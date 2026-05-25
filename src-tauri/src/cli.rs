use crate::db::Db;
use crate::model_runtime::ModelRuntime;
use crate::server::ServerManager;
use crate::types::{CreateUserRequest, LoginRequest, ModelLoadSettings, SaveSettingsRequest, UserAccount};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

// ── path helpers ─────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn default_db_path() -> PathBuf {
    let Some(home) = home_dir() else {
        return PathBuf::from("llmeter.sqlite");
    };
    #[cfg(target_os = "macos")]
    return home.join("Library/Application Support/com.local.llmeter/llmeter.sqlite");
    #[cfg(target_os = "windows")]
    return home.join("AppData/Roaming/com.local.llmeter/llmeter.sqlite");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return home.join(".local/share/com.local.llmeter/llmeter.sqlite");
}

fn pid_file_path(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("llmeter-daemon.pid")
}

// ── arg parser ────────────────────────────────────────────────────────────────

struct Args {
    positional: Vec<String>,
    flags: HashMap<String, String>,
}

impl Args {
    fn parse(raw: &[String]) -> Self {
        let mut positional = Vec::new();
        let mut flags = HashMap::new();
        let mut i = 0;
        while i < raw.len() {
            let arg = &raw[i];
            if let Some(key) = arg.strip_prefix("--") {
                if i + 1 < raw.len() && !raw[i + 1].starts_with('-') {
                    flags.insert(key.to_string(), raw[i + 1].clone());
                    i += 2;
                } else {
                    flags.insert(key.to_string(), "true".into());
                    i += 1;
                }
            } else if arg.starts_with('-') && arg.len() == 2 {
                let key = arg[1..].to_string();
                if i + 1 < raw.len() && !raw[i + 1].starts_with('-') {
                    flags.insert(key, raw[i + 1].clone());
                    i += 2;
                } else {
                    flags.insert(key, "true".into());
                    i += 1;
                }
            } else {
                positional.push(arg.clone());
                i += 1;
            }
        }
        Self { positional, flags }
    }

    fn get(&self, long: &str, short: &str) -> Option<&str> {
        self.flags
            .get(long)
            .or_else(|| self.flags.get(short))
            .map(String::as_str)
    }

    fn require(&self, long: &str, short: &str) -> Result<&str, String> {
        self.get(long, short)
            .ok_or_else(|| format!("missing required flag --{long}"))
    }

    fn parse_id(&self, long: &str, short: &str) -> Result<i64, String> {
        self.require(long, short)?
            .parse::<i64>()
            .map_err(|_| format!("--{long} must be an integer"))
    }

    fn flag_u32(&self, long: &str) -> Option<u32> {
        self.flags.get(long).and_then(|v| v.parse().ok())
    }

    fn flag_f32(&self, long: &str) -> Option<f32> {
        self.flags.get(long).and_then(|v| v.parse().ok())
    }
}

// ── db / auth helpers ─────────────────────────────────────────────────────────

fn resolve_db_path(args: &Args) -> PathBuf {
    args.get("db", "D")
        .map(PathBuf::from)
        .or_else(|| std::env::var("LLMETER_DB").ok().map(PathBuf::from))
        .unwrap_or_else(default_db_path)
}

fn open_db(args: &Args) -> Result<Db, String> {
    let db_path = resolve_db_path(args);
    let model_store_dir = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("models");
    let db = Db::new(db_path, model_store_dir);
    db.init()?;
    Ok(db)
}

fn authenticate(db: &Db, args: &Args) -> Result<UserAccount, String> {
    let username = args
        .get("username", "u")
        .map(str::to_string)
        .or_else(|| std::env::var("LLMETER_USERNAME").ok())
        .ok_or("admin credentials required — use -u/--username and -p/--password, or LLMETER_USERNAME / LLMETER_PASSWORD")?;
    let password = args
        .get("password", "p")
        .map(str::to_string)
        .or_else(|| std::env::var("LLMETER_PASSWORD").ok())
        .ok_or("admin credentials required — use -u/--username and -p/--password, or LLMETER_USERNAME / LLMETER_PASSWORD")?;
    let user = db.login(LoginRequest { username, password })?;
    if user.role != "admin" {
        return Err("only admin accounts can use the CLI".into());
    }
    Ok(user)
}

// ── process helpers (for server start/stop/status) ────────────────────────────

fn read_pid(pid_path: &Path) -> Option<u32> {
    std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

fn process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // kill -0 checks existence without sending a signal
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

// ── daemon HTTP helper ────────────────────────────────────────────────────────

/// Creates a temporary API key, runs `f` with it, then deletes the key.
/// Returns the result of `f`.
fn with_temp_key<F>(db: &Db, user: &UserAccount, f: F) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let created = db.create_api_key(user.id, "CLI session".to_string())?;
    let key_id = created.record.id;
    let secret = created.secret.clone();
    let result = f(&secret);
    let _ = db.delete_api_key(key_id);
    result
}

fn make_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Runtime::new().map_err(|e| format!("failed to start tokio runtime: {e}"))
}

// ── public entry points ───────────────────────────────────────────────────────

pub fn run(args: &[String]) -> i32 {
    match dispatch(args) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("error: {err}");
            1
        }
    }
}

/// Runs the HTTP API server in the foreground, blocking until SIGTERM/SIGINT.
/// Called from main() when `--daemon-worker` is detected.
pub fn run_daemon_worker(args: &[String]) -> i32 {
    let a = Args::parse(args);
    let db_path = resolve_db_path(&a);
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("error: failed to start tokio runtime: {err}");
            return 1;
        }
    };
    rt.block_on(async move {
        match daemon_main(db_path).await {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("error: {err}");
                1
            }
        }
    })
}

async fn daemon_main(db_path: PathBuf) -> Result<(), String> {
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    let model_store_dir = parent.join("models");
    let session_store_dir = parent.join("sessions");

    let db = Db::new(db_path.clone(), model_store_dir);
    db.init()?;

    let runtime = ModelRuntime::new();
    let server = ServerManager::new();

    server
        .ensure_service(db, runtime, session_store_dir)
        .await?;

    // Write our own PID so 'server stop' can find us
    let pid = std::process::id();
    let _ = std::fs::write(pid_file_path(&db_path), pid.to_string());

    // Block until SIGTERM or Ctrl-C
    tokio::signal::ctrl_c()
        .await
        .map_err(|e| format!("signal error: {e}"))?;
    Ok(())
}

// ── command dispatch ──────────────────────────────────────────────────────────

fn dispatch(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args);

    if a.flags.contains_key("version") || a.flags.contains_key("V") {
        println!("llmeter {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    if a.flags.contains_key("help") || a.flags.contains_key("h") || a.positional.is_empty() {
        print_help();
        return Ok(());
    }

    let group = a.positional[0].as_str();
    let sub = a.positional.get(1).map(String::as_str).unwrap_or("");

    match (group, sub) {
        // ── server ───────────────────────────────────────────────────────────
        ("server", "start") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let db_path = resolve_db_path(&a);
            let pid_path = pid_file_path(&db_path);

            if let Some(pid) = read_pid(&pid_path) {
                if process_running(pid) {
                    let settings = db.get_settings()?;
                    println!(
                        "server already running (pid={pid}) → http://{}:{}",
                        settings.host, settings.port
                    );
                    return Ok(());
                }
            }

            // Apply --host / --port overrides before starting
            if a.flags.contains_key("host") || a.flags.contains_key("port") {
                let s = db.get_settings()?;
                let new_host = a.get("host", "H").unwrap_or(&s.host).to_string();
                let new_port = match a.get("port", "P") {
                    Some(p) => p
                        .parse::<u16>()
                        .map_err(|_| "--port must be a number between 1 and 65535")?,
                    None => s.port,
                };
                let allow_remote = a.flags.contains_key("allow-remote") || s.allow_non_localhost;
                db.save_settings(SaveSettingsRequest {
                    host: new_host,
                    port: new_port,
                    default_model: s.default_model,
                    llama_cpp_path: s.llama_cpp_path,
                    hf_convert_script_path: s.hf_convert_script_path,
                    allow_non_localhost: allow_remote,
                    require_api_key: s.require_api_key,
                    anthropic_api_key: s.anthropic_api_key,
                    inference_defaults: s.inference_defaults,
                })?;
            }

            let exe = std::env::current_exe()
                .map_err(|e| format!("cannot locate current executable: {e}"))?;

            let mut cmd = std::process::Command::new(&exe);
            cmd.arg("--daemon-worker")
                .arg("--db")
                .arg(&db_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            let child = cmd
                .spawn()
                .map_err(|e| format!("failed to spawn daemon: {e}"))?;

            let pid = child.id();
            // Write PID immediately so 'server stop' can use it before the
            // daemon overwrites it with its own pid (same value).
            let _ = std::fs::write(&pid_path, pid.to_string());
            // Do not wait — the child runs independently.
            std::mem::forget(child);

            let settings = db.get_settings()?;
            println!(
                "server started (pid={pid}) → http://{}:{}",
                settings.host, settings.port
            );
            Ok(())
        }

        ("server", "stop") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let pid_path = pid_file_path(&resolve_db_path(&a));

            let pid = read_pid(&pid_path).ok_or("server is not running (no PID file found)")?;
            if !process_running(pid) {
                let _ = std::fs::remove_file(&pid_path);
                return Err(format!("no process found with pid={pid}"));
            }

            #[cfg(unix)]
            {
                std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .status()
                    .map_err(|e| format!("failed to send SIGTERM: {e}"))?;
            }
            #[cfg(not(unix))]
            {
                return Err("server stop is not supported on this platform".into());
            }

            let _ = std::fs::remove_file(&pid_path);
            println!("server stopped (pid={pid})");
            Ok(())
        }

        ("server", "status") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let pid_path = pid_file_path(&resolve_db_path(&a));
            let settings = db.get_settings()?;

            match read_pid(&pid_path) {
                Some(pid) if process_running(pid) => {
                    println!(
                        "running  pid={}  http://{}:{}",
                        pid, settings.host, settings.port
                    );
                }
                Some(pid) => {
                    let _ = std::fs::remove_file(&pid_path);
                    println!(
                        "stopped  (stale pid={pid})  configured: {}:{}",
                        settings.host, settings.port
                    );
                }
                None => {
                    println!(
                        "stopped  configured: {}:{}",
                        settings.host, settings.port
                    );
                }
            }
            Ok(())
        }

        // ── user ─────────────────────────────────────────────────────────────
        ("user" | "users", "list") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let users = db.list_users()?;
            println!(
                "{:<6} {:<20} {:<25} {:<8} {}",
                "ID", "Username", "Display Name", "Role", "Enabled"
            );
            println!("{}", "─".repeat(68));
            for u in users {
                println!(
                    "{:<6} {:<20} {:<25} {:<8} {}",
                    u.id,
                    u.username,
                    u.display_name,
                    u.role,
                    if u.enabled { "yes" } else { "no" }
                );
            }
            Ok(())
        }

        ("user" | "users", "create") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let username = a.require("new-username", "U")?;
            let display_name = a.get("display-name", "n").unwrap_or(username);
            let password = a.require("new-password", "P")?;
            let role = a.get("role", "r").unwrap_or("user");
            let user = db.create_user(CreateUserRequest {
                username: username.to_string(),
                display_name: display_name.to_string(),
                password: password.to_string(),
                role: role.to_string(),
            })?;
            println!("created user '{}' (id={})", user.username, user.id);
            Ok(())
        }

        ("user" | "users", "delete") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let id = a.parse_id("id", "i")?;
            db.delete_user(id)?;
            println!("deleted user id={id}");
            Ok(())
        }

        // ── model ─────────────────────────────────────────────────────────────
        ("model" | "models", "list") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let models = db.list_models()?;
            println!("{:<6} {:<40} {:<8} {}", "ID", "Name", "Format", "Status");
            println!("{}", "─".repeat(62));
            for m in models {
                println!("{:<6} {:<40} {:<8} {}", m.id, m.name, m.format, m.status);
            }
            Ok(())
        }

        ("model" | "models", "import") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let path = a.require("path", "f")?;
            let model = db.import_model(path.to_string())?;
            println!("imported model '{}' (id={})", model.name, model.id);
            Ok(())
        }

        ("model" | "models", "delete") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let id = a.parse_id("id", "i")?;
            db.delete_model(id)?;
            println!("deleted model id={id}");
            Ok(())
        }

        ("model" | "models", "load") => {
            let db = open_db(&a)?;
            let user = authenticate(&db, &a)?;
            let model_id = if let Some(name) = a.get("name", "n") {
                db.get_model_by_name(name)?
                    .ok_or_else(|| format!("no model found with name '{name}'"))?
                    .id
            } else {
                a.parse_id("id", "i")?
            };

            let context_length = a.flag_u32("ctx");
            let n_threads = a.flag_u32("threads");

            let temperature = a.flag_f32("temperature");
            let top_p = a.flag_f32("top-p");
            let top_k = a.flag_u32("top-k");
            let min_p = a.flag_f32("min-p");
            let repeat_penalty = a.flag_f32("repeat-penalty");
            let max_tokens = a.flag_u32("max-tokens");

            let load_settings = if temperature.is_some()
                || top_p.is_some()
                || top_k.is_some()
                || min_p.is_some()
                || repeat_penalty.is_some()
                || max_tokens.is_some()
            {
                Some(ModelLoadSettings {
                    temperature: temperature.unwrap_or(0.8),
                    limit_response_length: max_tokens.is_some(),
                    max_tokens,
                    context_overflow: "truncate-left".to_string(),
                    stop_strings: vec![],
                    top_k,
                    repeat_penalty_enabled: repeat_penalty.is_some(),
                    repeat_penalty,
                    presence_penalty_enabled: false,
                    presence_penalty: None,
                    top_p_enabled: top_p.is_some(),
                    top_p,
                    min_p_enabled: min_p.is_some(),
                    min_p,
                })
            } else {
                None
            };

            let settings = db.get_settings()?;
            let port = settings.port;

            with_temp_key(&db, &user, |secret| {
                let body = serde_json::json!({
                    "model_id": model_id,
                    "context_length": context_length,
                    "n_threads": n_threads,
                    "load_settings": load_settings,
                });
                let secret = secret.to_string();
                make_runtime()?.block_on(async move {
                    let client = reqwest::Client::new();
                    let resp = client
                        .post(format!("http://127.0.0.1:{port}/web/admin/models/load"))
                        .header("Authorization", format!("Bearer {secret}"))
                        .json(&body)
                        .send()
                        .await
                        .map_err(|e| format!("cannot reach server — is it running? ({e})"))?;
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    if !status.is_success() {
                        return Err(format!("server error {status}: {text}"));
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(models) = v["loaded_models"].as_array() {
                            for m in models {
                                if m["loaded"].as_bool().unwrap_or(false) {
                                    println!(
                                        "loaded  {}  (id={})  port={}  ctx={}",
                                        m["model_name"].as_str().unwrap_or("?"),
                                        m["model_id"].as_i64().unwrap_or(0),
                                        m["port"].as_i64().unwrap_or(0),
                                        m["context_length"]
                                            .as_i64()
                                            .map(|n| n.to_string())
                                            .unwrap_or_else(|| "default".into()),
                                    );
                                }
                            }
                        }
                    } else {
                        println!("model loaded");
                    }
                    Ok(())
                })
            })
        }

        ("model" | "models", "unload") => {
            let db = open_db(&a)?;
            let user = authenticate(&db, &a)?;
            let model_name = a.get("name", "n").map(str::to_string);

            let settings = db.get_settings()?;
            let port = settings.port;

            let display_name = model_name.clone().unwrap_or_else(|| "all models".into());
            with_temp_key(&db, &user, |secret| {
                let body = serde_json::json!({ "model_name": model_name });
                let secret = secret.to_string();
                make_runtime()?.block_on(async move {
                    let client = reqwest::Client::new();
                    let resp = client
                        .post(format!("http://127.0.0.1:{port}/web/admin/models/eject"))
                        .header("Authorization", format!("Bearer {secret}"))
                        .json(&body)
                        .send()
                        .await
                        .map_err(|e| format!("cannot reach server — is it running? ({e})"))?;
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    if !status.is_success() {
                        return Err(format!("server error {status}: {text}"));
                    }
                    Ok(())
                })
            })?;
            println!("unloaded {display_name}");
            Ok(())
        }

        ("model" | "models", "status") => {
            let db = open_db(&a)?;
            let user = authenticate(&db, &a)?;

            let settings = db.get_settings()?;
            let port = settings.port;

            with_temp_key(&db, &user, |secret| {
                let secret = secret.to_string();
                make_runtime()?.block_on(async move {
                    let client = reqwest::Client::new();
                    let resp = client
                        .get(format!("http://127.0.0.1:{port}/web/server"))
                        .header("Authorization", format!("Bearer {secret}"))
                        .send()
                        .await
                        .map_err(|e| format!("cannot reach server — is it running? ({e})"))?;
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    if !status.is_success() {
                        return Err(format!("server error {status}: {text}"));
                    }
                    let v: serde_json::Value =
                        serde_json::from_str(&text).map_err(|e| format!("parse error: {e}"))?;
                    let loaded = v["loaded_models"].as_array();
                    let models = loaded.map(|v| v.as_slice()).unwrap_or(&[]);
                    if models.is_empty() {
                        println!("no models loaded");
                    } else {
                        println!("{:<6} {:<40} {:<8} {}", "ModelID", "Name", "Port", "Ctx");
                        println!("{}", "─".repeat(62));
                        for m in models {
                            if m["loaded"].as_bool().unwrap_or(false) {
                                let ctx = m["context_length"]
                                    .as_i64()
                                    .map(|n| n.to_string())
                                    .unwrap_or_else(|| "default".into());
                                println!(
                                    "{:<6} {:<40} {:<8} {}",
                                    m["model_id"].as_i64().unwrap_or(0),
                                    m["model_name"].as_str().unwrap_or("?"),
                                    m["port"].as_i64().unwrap_or(0),
                                    ctx,
                                );
                            }
                        }
                    }
                    Ok(())
                })
            })
        }

        // ── key ──────────────────────────────────────────────────────────────
        ("key" | "keys", "list") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let user_id = a.get("user-id", "i").and_then(|v| v.parse::<i64>().ok());
            let keys = db.list_api_keys(user_id)?;
            println!(
                "{:<6} {:<14} {:<25} {:<20} {}",
                "ID", "Prefix", "User", "Label", "Enabled"
            );
            println!("{}", "─".repeat(72));
            for k in keys {
                println!(
                    "{:<6} {:<14} {:<25} {:<20} {}",
                    k.id,
                    k.key_prefix,
                    k.username.as_deref().unwrap_or("—"),
                    k.label,
                    if k.enabled { "yes" } else { "no" }
                );
            }
            Ok(())
        }

        ("key" | "keys", "create") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let user_id = a.parse_id("user-id", "i")?;
            let label = a.require("label", "l")?;
            let created = db.create_api_key(user_id, label.to_string())?;
            println!("created API key for user id={user_id}");
            println!("  label  : {}", created.record.label);
            println!("  prefix : {}", created.record.key_prefix);
            println!("  key    : {}", created.secret);
            println!("  (save this key — it will not be shown again)");
            Ok(())
        }

        ("key" | "keys", "delete") => {
            let db = open_db(&a)?;
            authenticate(&db, &a)?;
            let id = a.parse_id("id", "i")?;
            db.delete_api_key(id)?;
            println!("deleted API key id={id}");
            Ok(())
        }

        _ => {
            eprintln!("unknown command: {group} {sub}");
            eprintln!("run `llmeter --help` for usage");
            Err("unknown command".into())
        }
    }
}

fn print_help() {
    println!("LLMeter Admin CLI\n");
    println!("USAGE");
    println!("  llmeter <command> [options]\n");
    println!("GLOBAL OPTIONS");
    println!("  -u, --username <name>        Admin username  (or LLMETER_USERNAME)");
    println!("  -p, --password <pass>        Admin password  (or LLMETER_PASSWORD)");
    println!("      --db      <path>         Override DB path (or LLMETER_DB)\n");
    println!("SERVER COMMANDS");
    println!("  server start                 Start the HTTP API server in the background");
    println!("    --host <ip>                  Bind address (default: 127.0.0.1)");
    println!("    --port <n>                   Port number  (default: from settings)");
    println!("    --allow-remote               Allow non-localhost bind addresses");
    println!("  server stop                  Stop the background server");
    println!("  server status                Show server running state and address\n");
    println!("USER COMMANDS");
    println!("  user list                    List all users");
    println!("  user create                  Create a new user");
    println!("    --new-username <u>           Username (required)");
    println!("    --new-password <p>           Password (required)");
    println!("    --display-name <n>           Display name (optional)");
    println!("    --role         <r>           Role: user | admin  (default: user)");
    println!("  user delete --id <id>        Delete a user\n");
    println!("MODEL COMMANDS");
    println!("  model list                   List imported models");
    println!("  model import --path <p>      Import a GGUF model file");
    println!("  model delete --id <id>       Remove a model record");
    println!("  model load                   Load a model into the running server");
    println!("    --name <n>                   Model name (use instead of --id)");
    println!("    --id   <id>                  Model ID");
    println!("    --ctx <n>                    Context window size (tokens)");
    println!("    --threads <n>                CPU threads to use");
    println!("    --temperature <f>            Sampling temperature  (e.g. 0.8)");
    println!("    --top-p <f>                  Top-p nucleus sampling (e.g. 0.95)");
    println!("    --top-k <n>                  Top-k sampling        (e.g. 40)");
    println!("    --min-p <f>                  Min-p sampling        (e.g. 0.05)");
    println!("    --repeat-penalty <f>         Repetition penalty    (e.g. 1.1)");
    println!("    --max-tokens <n>             Max response tokens");
    println!("  model unload [--name <n>]    Unload a named model (omit to unload all)");
    println!("  model status                 Show currently loaded models\n");
    println!("API KEY COMMANDS");
    println!("  key list [--user-id <id>]    List API keys");
    println!("  key create                   Create an API key");
    println!("    --user-id <id>               Target user id (required)");
    println!("    --label   <l>                Key label     (required)");
    println!("  key delete --id <id>         Delete an API key");
}
