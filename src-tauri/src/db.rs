use crate::auth::{generate_secret, hash_password, hash_secret, new_salt, now_ts};
use crate::types::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Db {
    path: PathBuf,
    model_store_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user_id: i64,
    pub role: String,
    pub api_key_prefix: String,
}

impl Db {
    pub fn new(path: PathBuf, model_store_dir: PathBuf) -> Self {
        Self {
            path,
            model_store_dir,
        }
    }

    fn connect(&self) -> Result<Connection, String> {
        Connection::open(&self.path).map_err(|err| err.to_string())
    }

    pub fn init(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::create_dir_all(&self.model_store_dir).map_err(|err| err.to_string())?;
        let conn = self.connect()?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT NOT NULL UNIQUE,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                key_prefix TEXT NOT NULL,
                secret_hash TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL,
                format TEXT NOT NULL,
                status TEXT NOT NULL,
                context_length_max INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                api_key_prefix TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                model TEXT,
                input_text TEXT NOT NULL,
                output_text TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                status_code INTEGER NOT NULL,
                error_message TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                default_model TEXT,
                llama_cpp_path TEXT,
                allow_non_localhost INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO settings (id, host, port, default_model, llama_cpp_path, allow_non_localhost)
            VALUES (1, '127.0.0.1', 1234, NULL, NULL, 0);
            ",
        )
        .map_err(|err| err.to_string())?;
        // Idempotent column additions for schema upgrades on existing databases
        let _ = conn.execute_batch("ALTER TABLE users ADD COLUMN uid TEXT;");
        // Anonymous system user for unauthenticated requests (disabled so it never shows in admin).
        conn.execute(
            "INSERT OR IGNORE INTO users (id, uid, username, display_name, password_salt, password_hash, role, enabled, created_at)
             VALUES (0, 'usr_anonymous', '__anonymous__', 'Anonymous', '', '', 'user', 0, 0)",
            [],
        )
        .map_err(|err| err.to_string())?;
        self.ensure_user_uids(&conn)?;
        conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid);")
            .map_err(|err| err.to_string())?;
        let _ = conn.execute_batch(
            "ALTER TABLE settings ADD COLUMN require_api_key INTEGER NOT NULL DEFAULT 1;",
        );
        let _ = conn.execute_batch("ALTER TABLE models ADD COLUMN context_length_max INTEGER;");
        let _ = conn.execute_batch("ALTER TABLE settings ADD COLUMN anthropic_api_key TEXT;");
        let _ = conn.execute_batch("ALTER TABLE settings ADD COLUMN hf_convert_script_path TEXT;");
        let _ = conn.execute_batch("ALTER TABLE models ADD COLUMN hf_repo TEXT;");
        let _ = conn.execute_batch("ALTER TABLE models ADD COLUMN model_type TEXT;");
        let _ = conn.execute_batch("ALTER TABLE models ADD COLUMN mmproj_path TEXT;");
        let _ = conn.execute_batch("ALTER TABLE settings ADD COLUMN inference_defaults TEXT;");
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_provider_keys (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,
                api_key TEXT NOT NULL,
                PRIMARY KEY (user_id, provider)
            );",
        );
        Ok(())
    }

    fn ensure_user_uids(&self, conn: &Connection) -> Result<(), String> {
        let mut stmt = conn
            .prepare("SELECT id FROM users WHERE uid IS NULL OR uid = ''")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|err| err.to_string())?;
        let ids = collect_rows(rows)?;
        for id in ids {
            let uid = if id == 0 {
                "usr_anonymous".to_string()
            } else {
                self.new_unique_user_uid(conn)?
            };
            conn.execute("UPDATE users SET uid = ?1 WHERE id = ?2", params![uid, id])
                .map_err(|err| err.to_string())?;
        }
        Ok(())
    }

    fn new_unique_user_uid(&self, conn: &Connection) -> Result<String, String> {
        for _ in 0..32 {
            let uid = generate_secret("usr_");
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE uid = ?1",
                    params![uid],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            if exists == 0 {
                return Ok(uid);
            }
        }
        Err("Unable to allocate a unique user id.".into())
    }

    pub fn needs_setup(&self) -> Result<bool, String> {
        let admin_count: i64 = self
            .connect()?
            .query_row(
                "SELECT COUNT(*) FROM users WHERE id != 0 AND role = 'admin' AND enabled = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(admin_count == 0)
    }

    pub fn setup_admin(&self, input: SetupAdminRequest) -> Result<UserAccount, String> {
        if !self.needs_setup()? {
            return Err("Setup is already complete.".into());
        }
        self.create_user(CreateUserRequest {
            username: input.username,
            display_name: input.display_name,
            password: input.password,
            role: "admin".into(),
        })
    }

    pub fn login(&self, input: LoginRequest) -> Result<UserAccount, String> {
        let conn = self.connect()?;
        let row = conn
            .query_row(
                "SELECT id, password_salt, password_hash, enabled FROM users WHERE username = ?1",
                params![input.username],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)? == 1,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let Some((user_id, salt, stored_hash, enabled)) = row else {
            return Err("Invalid username or password.".into());
        };
        if !enabled {
            return Err("This account is disabled.".into());
        }
        if hash_password(&input.password, &salt) != stored_hash {
            return Err("Invalid username or password.".into());
        }
        self.get_user(user_id)
    }

    pub fn list_users(&self) -> Result<Vec<UserAccount>, String> {
        let conn = self.connect()?;
        let mut stmt = conn
            .prepare("SELECT id, uid, username, display_name, role, enabled, created_at FROM users WHERE id > 0 ORDER BY id")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(UserAccount {
                    id: row.get(0)?,
                    uid: row.get(1)?,
                    username: row.get(2)?,
                    display_name: row.get(3)?,
                    role: row.get(4)?,
                    enabled: row.get::<_, i64>(5)? == 1,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|err| err.to_string())?;
        collect_rows(rows)
    }

    pub fn create_user(&self, input: CreateUserRequest) -> Result<UserAccount, String> {
        validate_role(&input.role)?;
        validate_password_strength(&input.password)?;
        let salt = new_salt();
        let password_hash = hash_password(&input.password, &salt);
        let conn = self.connect()?;
        let uid = self.new_unique_user_uid(&conn)?;
        conn.execute(
            "INSERT INTO users (uid, username, display_name, password_salt, password_hash, role, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
            params![uid, input.username, input.display_name, salt, password_hash, input.role, now_ts()],
        )
        .map_err(|err| err.to_string())?;
        self.get_user(conn.last_insert_rowid())
    }

    pub fn update_user(&self, input: UpdateUserRequest) -> Result<UserAccount, String> {
        validate_role(&input.role)?;
        let conn = self.connect()?;
        if let Some(password) = input.password.filter(|value| !value.is_empty()) {
            validate_password_strength(&password)?;
            let salt = new_salt();
            let password_hash = hash_password(&password, &salt);
            conn.execute(
                "UPDATE users SET username = ?1, display_name = ?2, role = ?3, enabled = ?4, password_salt = ?5, password_hash = ?6 WHERE id = ?7",
                params![input.username, input.display_name, input.role, bool_i64(input.enabled), salt, password_hash, input.id],
            )
            .map_err(|err| err.to_string())?;
        } else {
            conn.execute(
                "UPDATE users SET username = ?1, display_name = ?2, role = ?3, enabled = ?4 WHERE id = ?5",
                params![input.username, input.display_name, input.role, bool_i64(input.enabled), input.id],
            )
            .map_err(|err| err.to_string())?;
        }
        self.get_user(input.id)
    }

    pub fn delete_user(&self, user_id: i64) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM api_keys WHERE user_id = ?1", params![user_id])
            .map_err(|err| err.to_string())?;
        tx.execute(
            "DELETE FROM request_logs WHERE user_id = ?1",
            params![user_id],
        )
        .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM users WHERE id = ?1", params![user_id])
            .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn get_user(&self, user_id: i64) -> Result<UserAccount, String> {
        self.connect()?
            .query_row(
                "SELECT id, uid, username, display_name, role, enabled, created_at FROM users WHERE id = ?1",
                params![user_id],
                |row| {
                    Ok(UserAccount {
                        id: row.get(0)?,
                        uid: row.get(1)?,
                        username: row.get(2)?,
                        display_name: row.get(3)?,
                        role: row.get(4)?,
                        enabled: row.get::<_, i64>(5)? == 1,
                        created_at: row.get(6)?,
                    })
                },
            )
            .map_err(|err| err.to_string())
    }

    pub fn get_user_uid(&self, user_id: i64) -> Result<String, String> {
        self.connect()?
            .query_row(
                "SELECT uid FROM users WHERE id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())
    }

    pub fn list_api_keys(&self, user_id: Option<i64>) -> Result<Vec<ApiKeyRecord>, String> {
        let conn = self.connect()?;
        let sql = match user_id {
            Some(_) => "SELECT api_keys.id, user_id, users.username, users.display_name, label, key_prefix, api_keys.enabled, api_keys.created_at FROM api_keys LEFT JOIN users ON users.id = api_keys.user_id WHERE user_id = ?1 ORDER BY api_keys.id DESC",
            None => "SELECT api_keys.id, user_id, users.username, users.display_name, label, key_prefix, api_keys.enabled, api_keys.created_at FROM api_keys LEFT JOIN users ON users.id = api_keys.user_id ORDER BY api_keys.id DESC",
        };
        let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(ApiKeyRecord {
                id: row.get(0)?,
                user_id: row.get(1)?,
                username: row.get(2)?,
                display_name: row.get(3)?,
                label: row.get(4)?,
                key_prefix: row.get(5)?,
                enabled: row.get::<_, i64>(6)? == 1,
                created_at: row.get(7)?,
            })
        };
        let rows = if let Some(id) = user_id {
            stmt.query_map(params![id], map_row)
                .map_err(|err| err.to_string())?
        } else {
            stmt.query_map([], map_row).map_err(|err| err.to_string())?
        };
        collect_rows(rows)
    }

    pub fn create_api_key(&self, user_id: i64, label: String) -> Result<CreatedApiKey, String> {
        let secret = generate_secret("ais_");
        let secret_hash = hash_secret(&secret);
        let key_prefix = secret.chars().take(12).collect::<String>();
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO api_keys (user_id, label, key_prefix, secret_hash, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![user_id, label, key_prefix, secret_hash, now_ts()],
        )
        .map_err(|err| err.to_string())?;
        let record = self.get_api_key(conn.last_insert_rowid())?;
        Ok(CreatedApiKey { record, secret })
    }

    pub fn delete_api_key(&self, key_id: i64) -> Result<(), String> {
        self.connect()?
            .execute("DELETE FROM api_keys WHERE id = ?1", params![key_id])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Deletes all API keys with a specific label for a user (used to clean up web session keys).
    pub fn delete_labeled_api_keys(&self, user_id: i64, label: &str) -> Result<(), String> {
        self.connect()?
            .execute(
                "DELETE FROM api_keys WHERE user_id = ?1 AND label = ?2",
                params![user_id, label],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn get_api_key(&self, key_id: i64) -> Result<ApiKeyRecord, String> {
        self.connect()?
            .query_row(
                "SELECT api_keys.id, user_id, users.username, users.display_name, label, key_prefix, api_keys.enabled, api_keys.created_at FROM api_keys LEFT JOIN users ON users.id = api_keys.user_id WHERE api_keys.id = ?1",
                params![key_id],
                |row| {
                    Ok(ApiKeyRecord {
                        id: row.get(0)?,
                        user_id: row.get(1)?,
                        username: row.get(2)?,
                        display_name: row.get(3)?,
                        label: row.get(4)?,
                        key_prefix: row.get(5)?,
                        enabled: row.get::<_, i64>(6)? == 1,
                        created_at: row.get(7)?,
                    })
                },
            )
            .map_err(|err| err.to_string())
    }

    pub fn resolve_api_key(&self, secret: &str) -> Result<Option<AuthContext>, String> {
        let secret_hash = hash_secret(secret);
        self.connect()?
            .query_row(
                "SELECT users.id, users.role, api_keys.key_prefix
                 FROM api_keys
                 JOIN users ON users.id = api_keys.user_id
                 WHERE api_keys.secret_hash = ?1 AND api_keys.enabled = 1 AND users.enabled = 1",
                params![secret_hash],
                |row| {
                    Ok(AuthContext {
                        user_id: row.get(0)?,
                        role: row.get(1)?,
                        api_key_prefix: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn import_model(&self, path: String) -> Result<ModelRecord, String> {
        let path_ref = Path::new(&path);
        let metadata =
            fs::metadata(path_ref).map_err(|err| format!("Unable to read model path: {err}"))?;
        if !metadata.is_file() {
            return Err("Model path must point to a file.".into());
        }

        let stored_path = self.copy_model_to_store(path_ref)?;
        let stored_metadata = fs::metadata(&stored_path)
            .map_err(|err| format!("Unable to read stored model path: {err}"))?;
        let mut name = stored_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("model")
            .to_string();
        let format = stored_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_ascii_lowercase();
        let status = if format == "gguf" {
            "ready"
        } else {
            "unsupported"
        };
        let context_length_max = if format == "gguf" {
            read_gguf_context_length(&stored_path).ok().flatten()
        } else {
            None
        };
        name = self.unique_model_name(&name, &stored_path)?;
        let stored_path_string = stored_path.to_string_lossy().to_string();
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO models (name, path, size_bytes, format, status, context_length_max, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, format = excluded.format, status = excluded.status, context_length_max = excluded.context_length_max",
            params![name, stored_path_string, stored_metadata.len() as i64, format, status, context_length_max, now_ts()],
        )
        .map_err(|err| err.to_string())?;
        self.get_model_by_path(stored_path.to_string_lossy().to_string())
    }

    pub fn import_model_from_hf(
        &self,
        path: String,
        hf_repo: String,
        model_type: Option<String>,
        mmproj_path: Option<String>,
    ) -> Result<ModelRecord, String> {
        let path_ref = Path::new(&path);
        let metadata =
            fs::metadata(path_ref).map_err(|err| format!("Unable to read model path: {err}"))?;
        if !metadata.is_file() {
            return Err("Model path must point to a file.".into());
        }

        let stored_path = self.copy_model_to_store(path_ref)?;
        let stored_metadata = fs::metadata(&stored_path)
            .map_err(|err| format!("Unable to read stored model path: {err}"))?;
        let mut name = stored_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("model")
            .to_string();
        let format = stored_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_ascii_lowercase();
        let status = if format == "gguf" {
            "ready"
        } else {
            "unsupported"
        };
        let context_length_max = if format == "gguf" {
            read_gguf_context_length(&stored_path).ok().flatten()
        } else {
            None
        };
        name = self.unique_model_name(&name, &stored_path)?;
        let stored_path_string = stored_path.to_string_lossy().to_string();
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO models (name, path, size_bytes, format, status, context_length_max, created_at, hf_repo, model_type, mmproj_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, format = excluded.format, status = excluded.status, context_length_max = excluded.context_length_max, hf_repo = excluded.hf_repo, model_type = excluded.model_type, mmproj_path = excluded.mmproj_path",
            params![name, stored_path_string, stored_metadata.len() as i64, format, status, context_length_max, now_ts(), hf_repo, model_type, mmproj_path],
        )
        .map_err(|err| err.to_string())?;
        self.get_model_by_path(stored_path.to_string_lossy().to_string())
    }

    pub fn model_store_dir(&self) -> PathBuf {
        self.model_store_dir.clone()
    }

    /// Walk model_store_dir recursively and register any .gguf files not already in the DB.
    pub fn scan_model_store(&self) -> Result<(), String> {
        if !self.model_store_dir.exists() {
            return Ok(());
        }
        let conn = self.connect()?;
        let mut stack = vec![self.model_store_dir.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) == Some("gguf".to_string()) {
                    let path_str = path.to_string_lossy().to_string();
                    // Skip auxiliary files (mmproj, vision encoders) — not standalone loadable models
                    let lower_name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                    if lower_name.contains("mmproj") { continue; }
                    // Skip if already tracked
                    let exists: bool = conn
                        .query_row("SELECT 1 FROM models WHERE path = ?1", params![path_str], |_| Ok(true))
                        .unwrap_or(false);
                    if exists {
                        continue;
                    }
                    let metadata = match fs::metadata(&path) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    let name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("model")
                        .to_string();
                    let context_length_max = read_gguf_context_length(&path).ok().flatten();
                    let name = match self.unique_model_name(&name, &path) {
                        Ok(n) => n,
                        Err(_) => continue,
                    };
                    let _ = conn.execute(
                        "INSERT OR IGNORE INTO models (name, path, size_bytes, format, status, context_length_max, created_at) VALUES (?1, ?2, ?3, 'gguf', 'ready', ?4, ?5)",
                        params![name, path_str, metadata.len() as i64, context_length_max, crate::auth::now_ts()],
                    );
                }
            }
        }
        Ok(())
    }

    fn copy_model_to_store(&self, source: &Path) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.model_store_dir).map_err(|err| err.to_string())?;
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Model path must include a valid file name.".to_string())?;
        if let (Ok(canonical_source), Ok(canonical_store)) = (
            source.canonicalize(),
            self.model_store_dir.canonicalize(),
        ) {
            if canonical_source.starts_with(&canonical_store) {
                return Ok(source.to_path_buf());
            }
        }
        let destination = self.unique_model_file_path(file_name)?;
        if source.canonicalize().ok() == destination.canonicalize().ok() {
            return Ok(destination);
        }
        fs::copy(source, &destination)
            .map_err(|err| format!("Unable to copy model into app storage: {err}"))?;
        Ok(destination)
    }

    fn unique_model_file_path(&self, file_name: &str) -> Result<PathBuf, String> {
        let candidate = self.model_store_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }

        let source_path = Path::new(file_name);
        let stem = source_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("model");
        let extension = source_path.extension().and_then(|value| value.to_str());
        for index in 2.. {
            let next_name = match extension {
                Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
                _ => format!("{stem}-{index}"),
            };
            let next = self.model_store_dir.join(next_name);
            if !next.exists() {
                return Ok(next);
            }
        }
        unreachable!("unbounded model file name search should always return");
    }

    fn unique_model_name(&self, base_name: &str, path: &Path) -> Result<String, String> {
        let path = path.to_string_lossy().to_string();
        if let Some(existing) = self.get_model_by_name(base_name)? {
            if existing.path == path {
                return Ok(base_name.to_string());
            }
        } else {
            return Ok(base_name.to_string());
        }

        for index in 2.. {
            let candidate = format!("{base_name}-{index}");
            if let Some(existing) = self.get_model_by_name(&candidate)? {
                if existing.path == path {
                    return Ok(candidate);
                }
            } else {
                return Ok(candidate);
            }
        }
        unreachable!("unbounded model name search should always return");
    }

    pub fn list_models(&self) -> Result<Vec<ModelRecord>, String> {
        let conn = self.connect()?;
        let mut stmt = conn
            .prepare("SELECT id, name, path, size_bytes, format, status, context_length_max, created_at, hf_repo, model_type, mmproj_path FROM models ORDER BY name")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], model_from_row)
            .map_err(|err| err.to_string())?;
        collect_rows(rows)
    }

    pub fn get_model_by_name(&self, name: &str) -> Result<Option<ModelRecord>, String> {
        self.connect()?
            .query_row(
                "SELECT id, name, path, size_bytes, format, status, context_length_max, created_at, hf_repo, model_type, mmproj_path FROM models WHERE name = ?1",
                params![name],
                model_from_row,
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn get_model_by_id(&self, id: i64) -> Result<Option<ModelRecord>, String> {
        self.connect()?
            .query_row(
                "SELECT id, name, path, size_bytes, format, status, context_length_max, created_at, hf_repo, model_type, mmproj_path FROM models WHERE id = ?1",
                params![id],
                model_from_row,
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn set_mmproj_path(
        &self,
        id: i64,
        mmproj_path: Option<String>,
    ) -> Result<ModelRecord, String> {
        self.connect()?
            .execute(
                "UPDATE models SET mmproj_path = ?1 WHERE id = ?2",
                params![mmproj_path, id],
            )
            .map_err(|err| err.to_string())?;
        self.get_model_by_id(id)?
            .ok_or_else(|| format!("Model {id} not found after update."))
    }

    pub fn update_model_type(
        &self,
        id: i64,
        model_type: Option<String>,
    ) -> Result<ModelRecord, String> {
        self.connect()?
            .execute(
                "UPDATE models SET model_type = ?1 WHERE id = ?2",
                params![model_type, id],
            )
            .map_err(|err| err.to_string())?;
        self.get_model_by_id(id)?
            .ok_or_else(|| format!("Model {id} not found after update."))
    }

    pub fn delete_model(&self, id: i64) -> Result<(), String> {
        let Some(model) = self.get_model_by_id(id)? else {
            return Ok(());
        };

        fs::create_dir_all(&self.model_store_dir).map_err(|err| err.to_string())?;
        let store_dir = self
            .model_store_dir
            .canonicalize()
            .map_err(|err| format!("Unable to inspect model store: {err}"))?;
        let model_path = PathBuf::from(&model.path);
        match model_path.canonicalize() {
            Ok(canonical_path)
                if canonical_path.starts_with(&store_dir) && canonical_path.is_file() =>
            {
                fs::remove_file(&canonical_path)
                    .map_err(|err| format!("Unable to delete model file: {err}"))?;
            }
            Ok(_) => {
                // Imported external files are not owned by LLMeter. Remove the catalog
                // record, but leave the original file in place.
            }
            Err(_) => {
                // The record can still be removed if the file was deleted outside the app.
            }
        }

        self.connect()?
            .execute("DELETE FROM models WHERE id = ?1", params![id])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn get_model_by_path(&self, path: String) -> Result<ModelRecord, String> {
        self.connect()?
            .query_row(
                "SELECT id, name, path, size_bytes, format, status, context_length_max, created_at, hf_repo, model_type, mmproj_path FROM models WHERE path = ?1",
                params![path],
                model_from_row,
            )
            .map_err(|err| err.to_string())
    }

    pub fn get_settings(&self) -> Result<SettingsRecord, String> {
        self.connect()?
            .query_row(
                "SELECT host, port, default_model, llama_cpp_path, hf_convert_script_path, allow_non_localhost, require_api_key, anthropic_api_key, inference_defaults FROM settings WHERE id = 1",
                [],
                |row| {
                    let inference_defaults_json: Option<String> = row.get(8).unwrap_or(None);
                    let inference_defaults = inference_defaults_json
                        .and_then(|json| serde_json::from_str(&json).ok());
                    Ok(SettingsRecord {
                        host: row.get(0)?,
                        port: row.get::<_, i64>(1)? as u16,
                        default_model: row.get(2)?,
                        llama_cpp_path: row.get(3)?,
                        hf_convert_script_path: row.get(4).unwrap_or(None),
                        allow_non_localhost: row.get::<_, i64>(5)? == 1,
                        require_api_key: row.get::<_, i64>(6).unwrap_or(1) == 1,
                        anthropic_api_key: row.get(7).unwrap_or(None),
                        inference_defaults,
                    })
                },
            )
            .map_err(|err| err.to_string())
    }

    pub fn save_settings(&self, input: SaveSettingsRequest) -> Result<SettingsRecord, String> {
        if input.port == 0 {
            return Err("Port must be between 1 and 65535.".into());
        }
        if input.host != "127.0.0.1" && input.host != "localhost" && !input.allow_non_localhost {
            return Err("Non-localhost binds require explicit confirmation.".into());
        }
        let inference_defaults_json = input
            .inference_defaults
            .as_ref()
            .and_then(|p| serde_json::to_string(p).ok());
        self.connect()?
            .execute(
                "UPDATE settings SET host = ?1, port = ?2, default_model = ?3, llama_cpp_path = ?4, hf_convert_script_path = ?5, allow_non_localhost = ?6, require_api_key = ?7, anthropic_api_key = ?8, inference_defaults = ?9 WHERE id = 1",
                params![input.host, input.port, input.default_model, input.llama_cpp_path, input.hf_convert_script_path, bool_i64(input.allow_non_localhost), bool_i64(input.require_api_key), input.anthropic_api_key, inference_defaults_json],
            )
            .map_err(|err| err.to_string())?;
        self.get_settings()
    }

    pub fn add_log(&self, log: &RequestLogRecord) -> Result<(), String> {
        self.connect()?
            .execute(
                "INSERT INTO request_logs (user_id, api_key_prefix, endpoint, model, input_text, output_text, input_tokens, output_tokens, status_code, error_message, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![log.user_id, log.api_key_prefix, log.endpoint, log.model, log.input_text, log.output_text, log.input_tokens, log.output_tokens, log.status_code, log.error_message, log.created_at],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn list_logs(
        &self,
        search: Option<String>,
        requester_user_id: i64,
        requester_role: String,
    ) -> Result<Vec<RequestLogRecord>, String> {
        let search = search.unwrap_or_default();
        let like = format!("%{}%", search);
        let admin = requester_role == "admin";
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT request_logs.id, request_logs.user_id, users.username, users.display_name, api_key_prefix, endpoint, model, input_text, output_text, input_tokens, output_tokens, status_code, error_message, request_logs.created_at
             FROM request_logs
             LEFT JOIN users ON users.id = request_logs.user_id
             WHERE (?1 = 1 OR request_logs.user_id = ?2)
               AND (?3 = '' OR endpoint LIKE ?4 OR model LIKE ?4 OR input_text LIKE ?4 OR output_text LIKE ?4 OR api_key_prefix LIKE ?4 OR users.username LIKE ?4 OR users.display_name LIKE ?4)
             ORDER BY request_logs.id DESC LIMIT 500",
        ).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![bool_i64(admin), requester_user_id, search, like],
                log_from_row,
            )
            .map_err(|err| err.to_string())?;
        collect_rows(rows)
    }

    pub fn dashboard(
        &self,
        requester_user_id: i64,
        requester_role: String,
        scope: Option<String>,
        start_ts: Option<i64>,
        end_ts: Option<i64>,
    ) -> Result<DashboardSummary, String> {
        let include_all_users = requester_role == "admin" && scope.as_deref() != Some("mine");
        let conn = self.connect()?;
        let (request_count, input_tokens, output_tokens) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
             FROM request_logs
             WHERE (?1 = 1 OR user_id = ?2)
               AND (?3 IS NULL OR created_at >= ?3)
               AND (?4 IS NULL OR created_at <= ?4)",
                params![
                    bool_i64(include_all_users),
                    requester_user_id,
                    start_ts,
                    end_ts
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(model, 'unknown') AS model_name,
                        COUNT(*),
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0)
             FROM request_logs
             WHERE (?1 = 1 OR user_id = ?2)
               AND (?3 IS NULL OR created_at >= ?3)
               AND (?4 IS NULL OR created_at <= ?4)
             GROUP BY model_name ORDER BY COUNT(*) DESC LIMIT 12",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    bool_i64(include_all_users),
                    requester_user_id,
                    start_ts,
                    end_ts
                ],
                |row| {
                    Ok(ModelUsage {
                        model: row.get(0)?,
                        requests: row.get(1)?,
                        input_tokens: row.get(2)?,
                        output_tokens: row.get(3)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        let mut daily_stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime') AS day,
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(input_tokens + output_tokens), 0),
                        COUNT(*)
             FROM request_logs
             WHERE (?1 = 1 OR user_id = ?2)
               AND (?3 IS NULL OR created_at >= ?3)
               AND (?4 IS NULL OR created_at <= ?4)
             GROUP BY day ORDER BY day ASC",
            )
            .map_err(|err| err.to_string())?;
        let daily_rows = daily_stmt
            .query_map(
                params![
                    bool_i64(include_all_users),
                    requester_user_id,
                    start_ts,
                    end_ts
                ],
                |row| {
                    Ok(TokenUsagePoint {
                        day: row.get(0)?,
                        input_tokens: row.get(1)?,
                        output_tokens: row.get(2)?,
                        total_tokens: row.get(3)?,
                        requests: row.get(4)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        let mut model_daily_stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime') AS day,
                        COALESCE(model, 'unknown') AS model_name,
                        COALESCE(SUM(input_tokens + output_tokens), 0)
             FROM request_logs
             WHERE (?1 = 1 OR user_id = ?2)
               AND (?3 IS NULL OR created_at >= ?3)
               AND (?4 IS NULL OR created_at <= ?4)
             GROUP BY day, model_name ORDER BY day ASC, model_name ASC",
            )
            .map_err(|err| err.to_string())?;
        let model_daily_rows = model_daily_stmt
            .query_map(
                params![
                    bool_i64(include_all_users),
                    requester_user_id,
                    start_ts,
                    end_ts
                ],
                |row| {
                    Ok(ModelDailyUsagePoint {
                        day: row.get(0)?,
                        model: row.get(1)?,
                        total_tokens: row.get(2)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        Ok(DashboardSummary {
            request_count,
            input_tokens,
            output_tokens,
            model_usage: collect_rows(rows)?,
            daily_usage: collect_rows(daily_rows)?,
            model_daily_usage: collect_rows(model_daily_rows)?,
        })
    }

}

fn validate_role(role: &str) -> Result<(), String> {
    match role {
        "admin" | "user" => Ok(()),
        _ => Err("Role must be admin or user.".into()),
    }
}

fn validate_password_strength(password: &str) -> Result<(), String> {
    let mut missing = Vec::new();
    if password.chars().count() < 12 {
        missing.push("at least 12 characters");
    }
    if !password.chars().any(|ch| ch.is_uppercase()) {
        missing.push("an uppercase letter");
    }
    if !password.chars().any(|ch| ch.is_lowercase()) {
        missing.push("a lowercase letter");
    }
    if !password.chars().any(|ch| ch.is_numeric()) {
        missing.push("a number");
    }
    if !password
        .chars()
        .any(|ch| !ch.is_alphanumeric() && !ch.is_whitespace())
    {
        missing.push("a symbol");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("Password must include {}.", missing.join(", ")))
    }
}

fn bool_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> Result<Vec<T>, String> {
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn read_gguf_context_length(path: &Path) -> Result<Option<u32>, String> {
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|err| err.to_string())?;
    if &magic != b"GGUF" {
        return Ok(None);
    }
    let _version = read_u32(&mut file)?;
    let _tensor_count = read_u64(&mut file)?;
    let kv_count = read_u64(&mut file)?;
    for _ in 0..kv_count {
        let key_len = read_u64(&mut file)? as usize;
        if key_len > 4096 {
            return Ok(None);
        }
        let mut key = vec![0u8; key_len];
        file.read_exact(&mut key).map_err(|err| err.to_string())?;
        let key = String::from_utf8_lossy(&key);
        let value_type = read_u32(&mut file)?;
        if key.ends_with(".context_length") {
            return read_gguf_numeric_value(&mut file, value_type);
        }
        skip_gguf_value(&mut file, value_type)?;
    }
    Ok(None)
}

fn read_gguf_numeric_value(file: &mut fs::File, value_type: u32) -> Result<Option<u32>, String> {
    let value = match value_type {
        0 => read_exact_array::<1>(file)?[0] as u64,
        2 => u16::from_le_bytes(read_exact_array::<2>(file)?) as u64,
        4 => read_u32(file)? as u64,
        10 => read_u64(file)?,
        _ => {
            skip_gguf_value(file, value_type)?;
            return Ok(None);
        }
    };
    Ok(u32::try_from(value).ok())
}

fn skip_gguf_value(file: &mut fs::File, value_type: u32) -> Result<(), String> {
    match value_type {
        0 | 1 | 7 => skip_bytes(file, 1),
        2 | 3 => skip_bytes(file, 2),
        4 | 5 | 6 => skip_bytes(file, 4),
        10 | 11 | 12 => skip_bytes(file, 8),
        8 => {
            let len = read_u64(file)?;
            skip_bytes(file, len)
        }
        9 => {
            let item_type = read_u32(file)?;
            let len = read_u64(file)?;
            for _ in 0..len {
                skip_gguf_value(file, item_type)?;
            }
            Ok(())
        }
        _ => Err(format!("Unknown GGUF metadata value type {value_type}")),
    }
}

fn read_u32(file: &mut fs::File) -> Result<u32, String> {
    Ok(u32::from_le_bytes(read_exact_array::<4>(file)?))
}

fn read_u64(file: &mut fs::File) -> Result<u64, String> {
    Ok(u64::from_le_bytes(read_exact_array::<8>(file)?))
}

fn read_exact_array<const N: usize>(file: &mut fs::File) -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    file.read_exact(&mut bytes).map_err(|err| err.to_string())?;
    Ok(bytes)
}

fn skip_bytes(file: &mut fs::File, bytes: u64) -> Result<(), String> {
    let offset =
        i64::try_from(bytes).map_err(|_| "GGUF metadata value is too large to skip".to_string())?;
    file.seek(SeekFrom::Current(offset))
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn model_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelRecord> {
    Ok(ModelRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        size_bytes: row.get(3)?,
        format: row.get(4)?,
        status: row.get(5)?,
        context_length_max: row.get(6)?,
        created_at: row.get(7)?,
        hf_repo: row.get(8).unwrap_or(None),
        model_type: row.get(9).unwrap_or(None),
        mmproj_path: row.get(10).unwrap_or(None),
    })
}

fn log_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RequestLogRecord> {
    Ok(RequestLogRecord {
        id: row.get(0)?,
        user_id: row.get(1)?,
        username: row.get(2)?,
        display_name: row.get(3)?,
        api_key_prefix: row.get(4)?,
        endpoint: row.get(5)?,
        model: row.get(6)?,
        input_text: row.get(7)?,
        output_text: row.get(8)?,
        input_tokens: row.get(9)?,
        output_tokens: row.get(10)?,
        status_code: row.get(11)?,
        error_message: row.get(12)?,
        created_at: row.get(13)?,
    })
}
