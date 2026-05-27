mod auth;
pub mod cli;
mod db;
mod inference;
mod llama_bundle;
mod model_runtime;
mod server;
mod types;

use crate::auth::{now_ts, token_estimate};
use crate::db::Db;
use crate::model_runtime::ModelRuntime;
use crate::server::ServerManager;
use crate::types::*;
use base64::{engine::general_purpose, Engine as _};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    db: Db,
    runtime: ModelRuntime,
    server: ServerManager,
    app_data_dir: PathBuf,
    database_path: PathBuf,
    session_store_dir: PathBuf,
    hf_cache_dir: PathBuf,
    python_env_dir: PathBuf,
    /// Download IDs that have been requested to cancel.
    cancelled_downloads: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    // Keeps the async log-file writer alive for the lifetime of the app.
    _log_guard: tracing_appender::non_blocking::WorkerGuard,
}

const MAX_CHAT_ATTACHMENT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(serde::Serialize)]
struct ChatAttachmentFile {
    name: String,
    mime: String,
    size: u64,
    kind: String,
    content: String,
}

fn truncate_log(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

fn require_admin(requester_role: &str) -> Result<(), String> {
    if requester_role == "admin" {
        Ok(())
    } else {
        Err("Admin access required.".into())
    }
}

fn mime_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "txt" | "md" | "markdown" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "jsx" | "ts" | "tsx" => "text/plain",
        "rs" | "py" | "toml" | "yaml" | "yml" | "xml" => "text/plain",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn is_text_like_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json" | "application/xml" | "image/svg+xml"
        )
}

fn sanitize_model_file_name(file_name: &str) -> Result<String, String> {
    let name = file_name
        .rsplit('/')
        .next()
        .unwrap_or(file_name)
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if name.is_empty() || name == "." || name == ".." {
        Err("Download file name is invalid.".into())
    } else {
        Ok(name)
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|err| format!("Invalid URL: {err}"))?;
    let allowed = (parsed.scheme() == "https" && parsed.host_str() == Some("huggingface.co"))
        || parsed.scheme() == "file";
    if !allowed {
        return Err("Only Hugging Face links and local file paths can be opened from this view.".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(parsed.as_str()).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd")
        .args(["/C", "start", "", parsed.as_str()])
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(parsed.as_str()).status();
    status
        .map_err(|err| format!("Unable to open browser: {err}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Unable to open browser.".into())
            }
        })
}

fn unique_download_path(dir: &std::path::Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let source_path = std::path::Path::new(file_name);
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
        let next = dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }
    unreachable!("unbounded model file name search should always return");
}

fn sanitize_storage_id(value: &str, fallback: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn validate_hugging_face_model_id(model_id: &str) -> Result<(), String> {
    let parts = model_id.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part == &"."
                || part == &".."
                || !part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        })
    {
        return Err("Hugging Face model id must look like author/model-name.".into());
    }
    Ok(())
}

fn validate_hugging_face_repo_file(file_name: &str) -> Result<(), String> {
    let path = std::path::Path::new(file_name);
    if file_name.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("Invalid Hugging Face file path '{file_name}'."));
    }
    let lower = file_name.to_ascii_lowercase();
    let allowed = [
        ".safetensors",
        ".json",
        ".model",
        ".txt",
        ".tiktoken",
        ".spm",
        ".vocab",
        ".merges",
    ];
    if !allowed.iter().any(|suffix| lower.ends_with(suffix)) {
        return Err(format!(
            "Skipping unsupported Hugging Face repo file '{file_name}'."
        ));
    }
    Ok(())
}

fn encode_url_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![byte as char]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

fn command_exists(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn find_miniconda_command() -> Option<String> {
    if command_exists("conda") {
        return Some("conda".into());
    }
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let candidates = home
        .into_iter()
        .flat_map(|home| {
            [
                home.join("miniconda3/bin/conda"),
                home.join("opt/miniconda3/bin/conda"),
                home.join("anaconda3/bin/conda"),
            ]
        })
        .chain([
            PathBuf::from("/opt/homebrew/Caskroom/miniconda/base/bin/conda"),
            PathBuf::from("/usr/local/Caskroom/miniconda/base/bin/conda"),
        ]);
    candidates
        .filter(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
        .next()
}

fn python_bin_in_env(env_dir: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        env_dir.join("Scripts").join("python.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        env_dir.join("bin").join("python")
    }
}

fn ensure_converter_python_env(env_dir: &Path) -> Result<PathBuf, String> {
    let python_bin = python_bin_in_env(env_dir);
    if python_bin.is_file() {
        return Ok(python_bin);
    }
    if let Some(parent) = env_dir.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    if let Some(conda) = find_miniconda_command() {
        let status = Command::new(conda)
            .args(["create", "-y", "-p"])
            .arg(env_dir)
            .args(["python=3.11"])
            .status()
            .map_err(|err| format!("Unable to create Miniconda conversion env: {err}"))?;
        if !status.success() {
            return Err("Miniconda was found, but creating the conversion env failed.".into());
        }
    } else {
        let python = if command_exists("python3") {
            "python3"
        } else if command_exists("python") {
            "python"
        } else {
            return Err(
                "No Miniconda/conda or Python executable found for GGUF conversion.".into(),
            );
        };
        let status = Command::new(python)
            .args(["-m", "venv"])
            .arg(env_dir)
            .status()
            .map_err(|err| format!("Unable to create Python venv for conversion: {err}"))?;
        if !status.success() {
            return Err("Python venv creation failed for GGUF conversion.".into());
        }
    }
    if python_bin.is_file() {
        Ok(python_bin)
    } else {
        Err(
            "Python conversion environment was created, but its Python executable was not found."
                .into(),
        )
    }
}

fn ensure_converter_python_requirements(python_bin: &Path, script: &Path) -> Result<(), String> {
    let Some(script_dir) = script.parent() else {
        return Ok(());
    };
    let requirements = script_dir.join("requirements.txt");
    if !requirements.is_file() {
        return Ok(());
    }
    let marker = python_bin
        .parent()
        .and_then(|bin| bin.parent())
        .unwrap_or(script_dir)
        .join(".llmeter-converter-requirements-installed");
    if marker.is_file() {
        return Ok(());
    }
    let status = Command::new(python_bin)
        .args(["-m", "pip", "install", "-r"])
        .arg(&requirements)
        .status()
        .map_err(|err| format!("Unable to install converter Python requirements: {err}"))?;
    if !status.success() {
        return Err("Installing converter Python requirements failed.".into());
    }
    fs::write(marker, "ok").map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgressPayload {
    download_id: String,
    file_name: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    part_index: usize,
    part_total: usize,
    status: String,
}

fn legacy_user_session_dir(state: &AppState, user_id: i64) -> PathBuf {
    state.session_store_dir.join(format!("user_{user_id}"))
}

fn user_session_dir(state: &AppState, user_id: i64) -> Result<PathBuf, String> {
    let uid = state.db.get_user_uid(user_id)?;
    Ok(state.session_store_dir.join(format!("user_{uid}")))
}

fn migrate_legacy_user_session_dir(state: &AppState, user_id: i64) -> Result<(), String> {
    let legacy_dir = legacy_user_session_dir(state, user_id);
    let uid_dir = user_session_dir(state, user_id)?;
    if !legacy_dir.is_dir() || legacy_dir == uid_dir {
        return Ok(());
    }
    fs::create_dir_all(&uid_dir).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(&legacy_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let target = uid_dir.join(entry.file_name());
        if !target.exists() {
            fs::rename(entry.path(), target).map_err(|err| err.to_string())?;
        }
    }
    let _ = fs::remove_dir(&legacy_dir);
    Ok(())
}

fn group_dir(state: &AppState, user_id: i64, group_id: &str) -> Result<PathBuf, String> {
    migrate_legacy_user_session_dir(state, user_id)?;
    let user_dir = user_session_dir(state, user_id)?;
    if group_id.trim().is_empty() {
        Ok(user_dir)
    } else {
        Ok(user_dir.join(sanitize_storage_id(group_id, "group")))
    }
}

fn chat_session_file_path(
    state: &AppState,
    user_id: i64,
    group_id: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(group_dir(state, user_id, group_id)?.join(format!(
        "{}.json",
        sanitize_storage_id(session_id, "session")
    )))
}

fn migrate_legacy_ungrouped_sessions(state: &AppState, user_id: i64) -> Result<(), String> {
    migrate_legacy_user_session_dir(state, user_id)?;
    let user_dir = user_session_dir(state, user_id)?;
    let legacy_dir = user_dir.join("_ungrouped");
    if !legacy_dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(&user_dir).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(&legacy_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().map_err(|err| err.to_string())?.is_file() {
            continue;
        }
        let target = user_dir.join(entry.file_name());
        if !target.exists() {
            fs::rename(entry.path(), target).map_err(|err| err.to_string())?;
        }
    }
    let _ = fs::remove_dir(&legacy_dir);
    Ok(())
}

fn write_group_metadata(dir: &std::path::Path, group: &ChatGroupRecord) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let json = serde_json::to_string_pretty(group).map_err(|err| err.to_string())?;
    fs::write(dir.join("group.json"), json).map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn get_setup_state(state: State<'_, AppState>) -> Result<SetupState, String> {
    Ok(SetupState {
        needs_setup: state.db.needs_setup()?,
    })
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(username = %input.username))]
fn setup_admin(
    state: State<'_, AppState>,
    input: SetupAdminRequest,
) -> Result<UserAccount, String> {
    tracing::info!("admin account created");
    state.db.setup_admin(input)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(username = %input.username))]
fn login(state: State<'_, AppState>, input: LoginRequest) -> Result<LoginResult, String> {
    tracing::info!("login attempt");
    let result = LoginResult {
        user: state.db.login(input)?,
        api_key: None,
    };
    tracing::info!(role = %result.user.role, "login success");
    Ok(result)
}

#[tauri::command]
#[tracing::instrument(fields(path = %path), err)]
fn read_chat_attachment(path: String) -> Result<ChatAttachmentFile, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path)
        .map_err(|err| format!("Unable to read dropped file metadata: {err}"))?;
    if !metadata.is_file() {
        return Err("Only regular files can be attached to chat.".into());
    }
    if metadata.len() > MAX_CHAT_ATTACHMENT_BYTES {
        return Err(format!(
            "{} is too large. Max upload size is 2 MB per file.",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Dropped file")
        ));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment")
        .to_string();
    let mime = mime_from_path(&path).to_string();
    let kind = if mime.starts_with("image/") {
        "image"
    } else if is_text_like_mime(&mime) {
        "text"
    } else {
        "binary"
    };
    let content = if kind == "text" {
        fs::read_to_string(&path).map_err(|err| {
            format!("Unable to read {name} as text. Try a plain text file or image: {err}")
        })?
    } else {
        let bytes = fs::read(&path).map_err(|err| format!("Unable to read dropped file: {err}"))?;
        format!(
            "data:{};base64,{}",
            mime,
            general_purpose::STANDARD.encode(bytes)
        )
    };
    Ok(ChatAttachmentFile {
        name,
        mime,
        size: metadata.len(),
        kind: kind.into(),
        content,
    })
}

#[tauri::command]
fn scan_model_store(state: State<'_, AppState>) -> Result<(), String> {
    state.db.scan_model_store()
}

#[tauri::command]
async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelRecord>, String> {
    let loaded_ids = state.runtime.loaded_model_ids().await;
    let mut models = state.db.list_models()?;
    for model in &mut models {
        if loaded_ids.contains(&model.id) {
            model.status = "loaded".into();
        }
    }
    Ok(models)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(path = %path), err)]
fn import_model(state: State<'_, AppState>, path: String) -> Result<ModelRecord, String> {
    tracing::info!("import_model called");
    state.db.import_model(path)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model_id), err)]
async fn delete_model(
    state: State<'_, AppState>,
    model_id: i64,
    requester_role: String,
) -> Result<(), String> {
    require_admin(&requester_role)?;
    tracing::info!("delete_model called");
    state.runtime.eject_model_id(model_id).await?;
    state.db.delete_model(model_id)
}

struct HfRepoMeta {
    pipeline_tag: Option<String>,
    mmproj_filename: Option<String>,
}

async fn fetch_hf_repo_meta(client: &reqwest::Client, repo_id: &str) -> HfRepoMeta {
    let url = format!("https://huggingface.co/api/models/{repo_id}");
    let Ok(response) = client.get(&url).send().await else {
        return HfRepoMeta {
            pipeline_tag: None,
            mmproj_filename: None,
        };
    };
    if !response.status().is_success() {
        return HfRepoMeta {
            pipeline_tag: None,
            mmproj_filename: None,
        };
    }
    let Ok(json) = response.json::<serde_json::Value>().await else {
        return HfRepoMeta {
            pipeline_tag: None,
            mmproj_filename: None,
        };
    };
    let pipeline_tag = json
        .get("pipeline_tag")
        .and_then(|v| v.as_str())
        .map(String::from);
    let mmproj_filename = json
        .get("siblings")
        .and_then(|v| v.as_array())
        .and_then(|siblings| {
            siblings
                .iter()
                .filter_map(|s| s.get("rfilename")?.as_str())
                .find(|name| {
                    let lower = name.to_ascii_lowercase();
                    lower.contains("mmproj") && lower.ends_with(".gguf")
                })
                .map(String::from)
        });
    HfRepoMeta {
        pipeline_tag,
        mmproj_filename,
    }
}

async fn fetch_hf_pipeline_tag(client: &reqwest::Client, repo_id: &str) -> Option<String> {
    fetch_hf_repo_meta(client, repo_id).await.pipeline_tag
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model_id, mmproj_path = ?mmproj_path), err)]
fn set_model_mmproj_path(
    state: State<'_, AppState>,
    model_id: i64,
    mmproj_path: Option<String>,
    requester_role: String,
) -> Result<ModelRecord, String> {
    require_admin(&requester_role)?;
    tracing::info!("set_model_mmproj_path called");
    if let Some(path) = &mmproj_path {
        if !path.trim().is_empty() && !std::path::Path::new(path).is_file() {
            return Err(format!("mmproj file not found: {path}"));
        }
    }
    state
        .db
        .set_mmproj_path(model_id, mmproj_path.filter(|p| !p.trim().is_empty()))
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model_id), err)]
async fn refresh_model_type(
    state: State<'_, AppState>,
    model_id: i64,
    requester_role: String,
) -> Result<ModelRecord, String> {
    require_admin(&requester_role)?;
    tracing::info!("refresh_model_type called");
    let model = state
        .db
        .get_model_by_id(model_id)?
        .ok_or_else(|| format!("Model {model_id} not found."))?;
    let hf_repo = model
        .hf_repo
        .as_deref()
        .ok_or("This model has no HuggingFace repo recorded.")?;
    let client = reqwest::Client::new();
    let pipeline_tag = fetch_hf_pipeline_tag(&client, hf_repo).await;
    tracing::info!(hf_repo, pipeline_tag = ?pipeline_tag, "model type refreshed");
    state.db.update_model_type(model_id, pipeline_tag)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(file_name = %file_name, part_index, part_total), err)]
async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    file_name: String,
    requester_role: String,
    download_id: String,
    part_index: usize,
    part_total: usize,
) -> Result<ModelRecord, String> {
    require_admin(&requester_role)?;
    tracing::info!("download_model started");
    let parsed = reqwest::Url::parse(&url).map_err(|err| format!("Invalid download URL: {err}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("huggingface.co") {
        return Err("Only HTTPS downloads from huggingface.co are supported.".into());
    }
    let safe_name = sanitize_model_file_name(&file_name)?;
    if !safe_name.to_ascii_lowercase().ends_with(".gguf") {
        return Err("Only GGUF model downloads are supported.".into());
    }

    // Extract owner/repo from https://huggingface.co/{owner}/{repo}/resolve/...
    let hf_repo = {
        let segments: Vec<&str> = parsed
            .path_segments()
            .map(|s| s.collect())
            .unwrap_or_default();
        if segments.len() >= 2 {
            Some(format!("{}/{}", segments[0], segments[1]))
        } else {
            None
        }
    };

    // Store in a per-repo subfolder when the HF repo is known.
    let model_dir = if let Some(repo) = &hf_repo {
        let mut p = state.db.model_store_dir();
        for segment in repo.split('/') {
            p = p.join(segment);
        }
        p
    } else {
        state.db.model_store_dir()
    };
    fs::create_dir_all(&model_dir).map_err(|err| err.to_string())?;
    let destination = unique_download_path(&model_dir, &safe_name);
    let partial = destination.with_extension("gguf.part");

    let client = reqwest::Client::new();
    let meta = if let Some(repo) = &hf_repo {
        fetch_hf_repo_meta(&client, repo).await
    } else {
        HfRepoMeta {
            pipeline_tag: None,
            mmproj_filename: None,
        }
    };
    let pipeline_tag = meta.pipeline_tag;
    let mmproj_hf_filename = meta.mmproj_filename;

    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|err| format!("Unable to start model download: {err}"))?;
    if !response.status().is_success() {
        let _ = fs::remove_file(&partial);
        return Err(format!(
            "Model download failed with HTTP {}",
            response.status()
        ));
    }

    let total_bytes = response.content_length();
    let mut downloaded_bytes = 0_u64;
    let emit_progress =
        |status: &str, downloaded_bytes: u64, total_bytes: Option<u64>| -> Result<(), String> {
            app.emit(
                "model-download-progress",
                DownloadProgressPayload {
                    download_id: download_id.clone(),
                    file_name: safe_name.clone(),
                    downloaded_bytes,
                    total_bytes,
                    part_index,
                    part_total,
                    status: status.to_string(),
                },
            )
            .map_err(|err| err.to_string())
        };
    let _ = emit_progress("downloading", downloaded_bytes, total_bytes);

    let mut file = fs::File::create(&partial)
        .map_err(|err| format!("Unable to create download file: {err}"))?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Model download interrupted: {err}"))?
    {
        // Check for user-requested cancellation on every chunk.
        if state.cancelled_downloads.lock().unwrap().remove(&download_id) {
            drop(file);
            let _ = fs::remove_file(&partial);
            let _ = emit_progress("cancelled", downloaded_bytes, total_bytes);
            return Err("Download cancelled.".into());
        }
        file.write_all(&chunk)
            .map_err(|err| format!("Unable to write model download: {err}"))?;
        downloaded_bytes += chunk.len() as u64;
        let _ = emit_progress("downloading", downloaded_bytes, total_bytes);
    }
    file.flush()
        .map_err(|err| format!("Unable to finalize model download: {err}"))?;
    drop(file);
    fs::rename(&partial, &destination)
        .map_err(|err| format!("Unable to move downloaded model into place: {err}"))?;
    let _ = emit_progress("finalizing", downloaded_bytes, total_bytes);

    // Download mmproj projector for vision models if present in the same HF repo.
    let mmproj_stored_path: Option<String> =
        if let (Some(repo), Some(mmproj_file)) = (&hf_repo, &mmproj_hf_filename) {
            let safe_mmproj =
                sanitize_model_file_name(mmproj_file).unwrap_or_else(|_| "mmproj.gguf".into());

            // Skip download if mmproj already exists in the model subfolder.
            let existing_mmproj = fs::read_dir(&model_dir).ok().and_then(|entries| {
                entries.filter_map(|e| e.ok()).find(|e| {
                    let n = e.file_name().to_string_lossy().to_ascii_lowercase();
                    n.contains("mmproj") && n.ends_with(".gguf")
                })
            });
            if let Some(existing) = existing_mmproj {
                tracing::info!("mmproj already exists at {:?}, skipping download", existing.path());
                Some(existing.path().to_string_lossy().to_string())
            } else {

            let mmproj_url = format!("https://huggingface.co/{repo}/resolve/main/{mmproj_file}");
            let mmproj_dest = unique_download_path(&model_dir, &safe_mmproj);
            let mmproj_partial = mmproj_dest.with_extension("gguf.part");
            let emit_mmproj = |status: &str, dl: u64, total: Option<u64>| -> Result<(), String> {
                app.emit(
                    "model-download-progress",
                    DownloadProgressPayload {
                        download_id: format!("{download_id}_mmproj"),
                        file_name: safe_mmproj.clone(),
                        downloaded_bytes: dl,
                        total_bytes: total,
                        part_index: 0,
                        part_total: 1,
                        status: status.to_string(),
                    },
                )
                .map_err(|err| err.to_string())
            };
            match client.get(&mmproj_url).send().await {
                Ok(mut mmproj_resp) if mmproj_resp.status().is_success() => {
                    let mmproj_total = mmproj_resp.content_length();
                    let _ = emit_mmproj("downloading", 0, mmproj_total);
                    match fs::File::create(&mmproj_partial) {
                        Ok(mut f) => {
                            let mut dl: u64 = 0;
                            let mut ok = true;
                            while let Ok(Some(chunk)) = mmproj_resp.chunk().await {
                                if f.write_all(&chunk).is_err() {
                                    ok = false;
                                    break;
                                }
                                dl += chunk.len() as u64;
                                let _ = emit_mmproj("downloading", dl, mmproj_total);
                            }
                            drop(f);
                            if ok && fs::rename(&mmproj_partial, &mmproj_dest).is_ok() {
                                let _ = emit_mmproj("done", dl, mmproj_total);
                                Some(mmproj_dest.to_string_lossy().to_string())
                            } else {
                                let _ = fs::remove_file(&mmproj_partial);
                                None
                            }
                        }
                        Err(_) => None,
                    }
                }
                _ => None,
            }
            } // end else (mmproj not already present)
        } else {
            None
        };

    let record = if let Some(repo) = hf_repo {
        state.db.import_model_from_hf(
            destination.to_string_lossy().to_string(),
            repo,
            pipeline_tag,
            mmproj_stored_path,
        )?
    } else {
        state
            .db
            .import_model(destination.to_string_lossy().to_string())?
    };
    let _ = emit_progress("done", downloaded_bytes, total_bytes);
    tracing::info!(model_id = record.id, model_name = %record.name, "download_model completed");
    Ok(record)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model_id = %model_id), err)]
async fn download_and_convert_hf_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_id: String,
    files: Vec<HuggingFaceRepoFileRequest>,
    requester_role: String,
    outtype: Option<String>,
) -> Result<ModelRecord, String> {
    require_admin(&requester_role)?;
    tracing::info!(
        num_files = files.len(),
        "download_and_convert_hf_model started"
    );
    validate_hugging_face_model_id(&model_id)?;
    let outtype = outtype.unwrap_or_else(|| "q8_0".into());
    if !matches!(outtype.as_str(), "f16" | "bf16" | "f32" | "q8_0") {
        return Err("Supported GGUF conversion output types are f16, bf16, f32, and q8_0.".into());
    }
    let settings = state.db.get_settings()?;
    let script = settings
        .hf_convert_script_path
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Set the llama.cpp convert_hf_to_gguf.py path in Server Settings first.".to_string()
        })?;
    if !std::path::Path::new(&script).is_file() {
        return Err(format!("Converter script '{script}' was not found."));
    }
    if files.is_empty() {
        return Err("No Hugging Face files are available for conversion.".into());
    }

    let repo_dir = state
        .hf_cache_dir
        .join(sanitize_storage_id(&model_id.replace('/', "-"), "hf-model"));
    fs::create_dir_all(&repo_dir).map_err(|err| err.to_string())?;
    let client = reqwest::Client::new();
    let pipeline_tag = fetch_hf_pipeline_tag(&client, &model_id).await;
    let download_id = format!("convert:{model_id}");
    let file_total = files.len();
    for (index, repo_file) in files.iter().enumerate() {
        validate_hugging_face_repo_file(&repo_file.name)?;
        let relative_path = std::path::Path::new(&repo_file.name);
        let destination = repo_dir.join(relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let encoded_file = repo_file
            .name
            .split('/')
            .map(encode_url_path_segment)
            .collect::<Vec<_>>()
            .join("/");
        let url = format!("https://huggingface.co/{model_id}/resolve/main/{encoded_file}");
        let parsed =
            reqwest::Url::parse(&url).map_err(|err| format!("Invalid download URL: {err}"))?;
        let mut response = client
            .get(parsed)
            .send()
            .await
            .map_err(|err| format!("Unable to start Hugging Face download: {err}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Download failed for '{}' with HTTP {}.",
                repo_file.name,
                response.status()
            ));
        }
        let total_bytes = response.content_length().or(repo_file.size);
        let mut downloaded_bytes = 0_u64;
        let emit_progress = |status: &str, downloaded_bytes: u64, total_bytes: Option<u64>| {
            let _ = app.emit(
                "model-download-progress",
                DownloadProgressPayload {
                    download_id: download_id.clone(),
                    file_name: repo_file.name.clone(),
                    downloaded_bytes,
                    total_bytes,
                    part_index: index + 1,
                    part_total: file_total,
                    status: status.to_string(),
                },
            );
        };
        emit_progress("downloading", downloaded_bytes, total_bytes);
        let partial = destination.with_extension("download.part");
        let mut file = fs::File::create(&partial)
            .map_err(|err| format!("Unable to create download file: {err}"))?;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|err| format!("Hugging Face download interrupted: {err}"))?
        {
            file.write_all(&chunk)
                .map_err(|err| format!("Unable to write Hugging Face file: {err}"))?;
            downloaded_bytes += chunk.len() as u64;
            emit_progress("downloading", downloaded_bytes, total_bytes);
        }
        file.flush()
            .map_err(|err| format!("Unable to finalize Hugging Face file: {err}"))?;
        drop(file);
        fs::rename(&partial, &destination)
            .map_err(|err| format!("Unable to move Hugging Face file into place: {err}"))?;
    }

    let safe_name = sanitize_model_file_name(&format!(
        "{}-{outtype}.gguf",
        model_id.split('/').last().unwrap_or("model")
    ))?;
    let destination = unique_download_path(&state.db.model_store_dir(), &safe_name);
    let _ = app.emit(
        "model-download-progress",
        DownloadProgressPayload {
            download_id: download_id.clone(),
            file_name: safe_name.clone(),
            downloaded_bytes: 0,
            total_bytes: None,
            part_index: file_total,
            part_total: file_total,
            status: "converting".into(),
        },
    );
    let python_bin = ensure_converter_python_env(&state.python_env_dir)?;
    ensure_converter_python_requirements(&python_bin, Path::new(&script))?;
    let output = Command::new(python_bin)
        .arg(&script)
        .arg(&repo_dir)
        .arg("--outfile")
        .arg(&destination)
        .arg("--outtype")
        .arg(&outtype)
        .output()
        .map_err(|err| format!("Unable to start GGUF converter: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "GGUF conversion failed. {}\n{}",
            stderr.trim(),
            stdout.trim()
        ));
    }
    let record = state.db.import_model_from_hf(
        destination.to_string_lossy().to_string(),
        model_id,
        pipeline_tag,
        None,
    )?;
    let _ = app.emit(
        "model-download-progress",
        DownloadProgressPayload {
            download_id,
            file_name: safe_name,
            downloaded_bytes: 1,
            total_bytes: Some(1),
            part_index: file_total,
            part_total: file_total,
            status: "done".into(),
        },
    );
    Ok(record)
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn get_model_store_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.db.model_store_dir().to_string_lossy().to_string())
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn get_app_storage_dirs(
    state: State<'_, AppState>,
    requester_role: String,
) -> Result<AppStorageDirs, String> {
    require_admin(&requester_role)?;
    fs::create_dir_all(&state.session_store_dir).map_err(|err| err.to_string())?;
    Ok(AppStorageDirs {
        app_data_dir: state.app_data_dir.to_string_lossy().to_string(),
        database_path: state.database_path.to_string_lossy().to_string(),
        model_store_dir: state.db.model_store_dir().to_string_lossy().to_string(),
        session_store_dir: state.session_store_dir.to_string_lossy().to_string(),
        hf_cache_dir: state.hf_cache_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id))]
fn list_chat_groups(
    state: State<'_, AppState>,
    user_id: i64,
) -> Result<Vec<ChatGroupRecord>, String> {
    let user_dir = user_session_dir(&state, user_id)?;
    fs::create_dir_all(&user_dir).map_err(|err| err.to_string())?;
    let mut groups = Vec::new();
    for entry in fs::read_dir(&user_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().map_err(|err| err.to_string())?.is_dir() {
            continue;
        }
        let metadata_path = entry.path().join("group.json");
        if metadata_path.exists() {
            let json = fs::read_to_string(metadata_path).map_err(|err| err.to_string())?;
            if let Ok(group) = serde_json::from_str::<ChatGroupRecord>(&json) {
                groups.push(group);
            }
        }
    }
    groups.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(groups)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, name = %name), err)]
fn create_chat_group(
    state: State<'_, AppState>,
    user_id: i64,
    name: String,
) -> Result<ChatGroupRecord, String> {
    tracing::info!("create_chat_group called");
    let user_dir = user_session_dir(&state, user_id)?;
    fs::create_dir_all(&user_dir).map_err(|err| err.to_string())?;
    let base = sanitize_storage_id(name.trim(), "group");
    let mut id = base.clone();
    for index in 2.. {
        if !user_dir.join(&id).exists() {
            break;
        }
        id = format!("{base}-{index}");
    }
    let group = ChatGroupRecord {
        id: id.clone(),
        name: name.trim().to_string(),
    };
    if group.name.is_empty() {
        return Err("Group name is required.".into());
    }
    write_group_metadata(&user_dir.join(id), &group)?;
    Ok(group)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, group_id = %group_id), err)]
fn delete_chat_group(
    state: State<'_, AppState>,
    user_id: i64,
    group_id: String,
) -> Result<(), String> {
    tracing::info!("delete_chat_group called");
    let dir = group_dir(&state, user_id, &group_id)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, group_id = %group_id))]
fn list_chat_sessions(
    state: State<'_, AppState>,
    user_id: i64,
    group_id: String,
) -> Result<Vec<ChatSessionRecord>, String> {
    if group_id.trim().is_empty() {
        migrate_legacy_ungrouped_sessions(&state, user_id)?;
    }
    let dir = group_dir(&state, user_id, &group_id)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().map_err(|err| err.to_string())?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some("group.json") {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let json = fs::read_to_string(path).map_err(|err| err.to_string())?;
        if let Ok(session) = serde_json::from_str::<ChatSessionRecord>(&json) {
            sessions.push(session);
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, group_id = %group_id, session_id = %session.id), err)]
fn save_chat_session(
    state: State<'_, AppState>,
    user_id: i64,
    group_id: String,
    session: ChatSessionRecord,
) -> Result<(), String> {
    if group_id.trim().is_empty() {
        migrate_legacy_ungrouped_sessions(&state, user_id)?;
    }
    let dir = group_dir(&state, user_id, &group_id)?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file_name = format!("{}.json", sanitize_storage_id(&session.id, "session"));
    let json = serde_json::to_string_pretty(&session).map_err(|err| err.to_string())?;
    fs::write(dir.join(file_name), json).map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, group_id = %group_id, session_id = %session_id), err)]
fn delete_chat_session(
    state: State<'_, AppState>,
    user_id: i64,
    group_id: String,
    session_id: String,
) -> Result<(), String> {
    tracing::info!("delete_chat_session called");
    let dir = group_dir(&state, user_id, &group_id)?;
    let path = dir.join(format!(
        "{}.json",
        sanitize_storage_id(&session_id, "session")
    ));
    if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, group_id = %group_id, session_id = %session_id), err)]
fn reveal_chat_session(
    state: State<'_, AppState>,
    user_id: i64,
    group_id: String,
    session_id: String,
) -> Result<(), String> {
    let path = chat_session_file_path(&state, user_id, &group_id, &session_id)?;
    if !path.exists() {
        return Err("Chat session file was not found.".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|err| format!("Unable to reveal chat session in Finder: {err}"))?;
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status()
        .map_err(|err| format!("Unable to reveal chat session in Explorer: {err}"))?;
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open")
        .arg(path.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .status()
        .map_err(|err| format!("Unable to open chat session folder: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Opening the chat session location failed.".into())
    }
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn get_settings(
    state: State<'_, AppState>,
    requester_role: String,
) -> Result<SettingsRecord, String> {
    require_admin(&requester_role)?;
    state.db.get_settings()
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(host = %input.host, port = input.port), err)]
fn save_settings(
    state: State<'_, AppState>,
    input: SaveSettingsRequest,
    requester_role: String,
) -> Result<SettingsRecord, String> {
    require_admin(&requester_role)?;
    tracing::info!("save_settings called");
    state.db.save_settings(input)
}

#[tauri::command]
async fn start_server(
    state: State<'_, AppState>,
    requester_role: String,
) -> Result<ServerStatus, String> {
    require_admin(&requester_role)?;
    tracing::info!("start_server called");
    let status = state
        .server
        .start(
            state.db.clone(),
            state.runtime.clone(),
            state.session_store_dir.clone(),
        )
        .await?;
    tracing::info!(host = %status.host, port = status.port, "server started");
    Ok(status)
}

#[tauri::command]
fn stop_server(state: State<'_, AppState>, requester_role: String) -> Result<ServerStatus, String> {
    require_admin(&requester_role)?;
    tracing::info!("stop_server called");
    Ok(state.server.stop())
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn get_server_status(
    state: State<'_, AppState>,
    requester_role: String,
) -> Result<ServerStatus, String> {
    require_admin(&requester_role)?;
    Ok(state.server.status())
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn get_public_server_status(state: State<'_, AppState>) -> Result<ServerStatus, String> {
    let mut status = state.server.status();
    // Always reflect current DB settings so host/port stay correct after config changes
    if let Ok(settings) = state.db.get_settings() {
        status.host = settings.host;
        status.port = settings.port;
    }
    Ok(status)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model_id, ?context_length, ?n_threads), err)]
async fn load_model(
    state: State<'_, AppState>,
    model_id: i64,
    context_length: Option<u32>,
    n_threads: Option<u32>,
    load_settings: Option<ModelLoadSettings>,
    requester_role: String,
) -> Result<Vec<LoadedModelStatus>, String> {
    require_admin(&requester_role)?;
    tracing::info!("load_model started");
    let statuses = state
        .runtime
        .load_model(
            &state.db,
            model_id,
            context_length,
            n_threads,
            load_settings,
        )
        .await?;
    tracing::info!("load_model completed");
    Ok(statuses)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model_name = ?model_name), err)]
async fn eject_model(
    state: State<'_, AppState>,
    model_name: Option<String>,
    requester_role: String,
) -> Result<Vec<LoadedModelStatus>, String> {
    require_admin(&requester_role)?;
    tracing::info!("eject_model called");
    state.runtime.eject_model(model_name).await
}

#[tauri::command]
#[tracing::instrument(skip_all)]
async fn loaded_model_status(state: State<'_, AppState>) -> Result<Vec<LoadedModelStatus>, String> {
    Ok(state.runtime.statuses().await)
}

#[tauri::command]
#[tracing::instrument(skip_all)]
async fn get_model_logs(
    state: State<'_, AppState>,
    requester_role: String,
) -> Result<Vec<String>, String> {
    require_admin(&requester_role)?;
    Ok(state.runtime.logs().await)
}

#[tauri::command]
#[tracing::instrument(skip_all)]
async fn clear_model_logs(
    state: State<'_, AppState>,
    requester_role: String,
) -> Result<(), String> {
    require_admin(&requester_role)?;
    tracing::info!("model logs cleared");
    state.runtime.clear_logs().await;
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip_all)]
fn list_users(state: State<'_, AppState>, requester_role: String) -> Result<Vec<UserAccount>, String> {
    require_admin(&requester_role)?;
    state.db.list_users()
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(username = %input.username, role = %input.role), err)]
fn create_user(
    state: State<'_, AppState>,
    input: CreateUserRequest,
    requester_role: String,
) -> Result<UserAccount, String> {
    require_admin(&requester_role)?;
    tracing::info!("create_user called");
    state.db.create_user(input)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id = input.id, username = %input.username), err)]
fn update_user(
    state: State<'_, AppState>,
    input: UpdateUserRequest,
    requester_role: String,
) -> Result<UserAccount, String> {
    require_admin(&requester_role)?;
    tracing::info!(enabled = input.enabled, role = %input.role, "update_user called");
    state.db.update_user(input)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id), err)]
fn delete_user(state: State<'_, AppState>, user_id: i64, requester_role: String) -> Result<(), String> {
    require_admin(&requester_role)?;
    tracing::info!("delete_user called");
    state.db.delete_user(user_id)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id = ?user_id))]
fn list_api_keys(
    state: State<'_, AppState>,
    user_id: Option<i64>,
) -> Result<Vec<ApiKeyRecord>, String> {
    state.db.list_api_keys(user_id)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(user_id, label = %label), err)]
fn create_api_key(
    state: State<'_, AppState>,
    user_id: i64,
    label: String,
) -> Result<CreatedApiKey, String> {
    tracing::info!("create_api_key called");
    state.db.create_api_key(user_id, label)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(key_id), err)]
fn delete_api_key(state: State<'_, AppState>, key_id: i64) -> Result<(), String> {
    tracing::info!("delete_api_key called");
    state.db.delete_api_key(key_id)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(requester_user_id, search = ?search))]
fn list_logs(
    state: State<'_, AppState>,
    search: Option<String>,
    requester_user_id: i64,
    requester_role: String,
) -> Result<Vec<RequestLogRecord>, String> {
    state
        .db
        .list_logs(search, requester_user_id, requester_role)
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(model = %model, num_messages = messages.len()), err)]
async fn chat(
    state: State<'_, AppState>,
    model: String,
    messages: Vec<crate::inference::ChatMessage>,
    params: Option<InferenceParams>,
    user_id: i64,
) -> Result<serde_json::Value, String> {
    tracing::info!("chat request started");
    let num_messages = messages.len();
    let input_text = messages
        .iter()
        .map(|message| format!("{}: {}", message.role, message.content.to_log_text()))
        .collect::<Vec<_>>()
        .join("\n");
    let request = crate::inference::ChatCompletionRequest {
        model: model.clone(),
        messages,
        temperature: params.as_ref().and_then(|p| p.temperature),
        max_tokens: params.as_ref().and_then(|p| p.max_tokens).or(Some(2048)),
        top_p: params.as_ref().and_then(|p| p.top_p),
        top_k: params.as_ref().and_then(|p| p.top_k),
        min_p: params.as_ref().and_then(|p| p.min_p),
        repeat_penalty: params.as_ref().and_then(|p| p.repeat_penalty),
        presence_penalty: params.as_ref().and_then(|p| p.presence_penalty),
        stop: params.as_ref().and_then(|p| p.stop.clone()),
    };
    state.runtime.push_log(format!(
        "> chat  model=\"{}\"  messages={}  input=\"{}\"",
        model,
        num_messages,
        truncate_log(&input_text, 120)
    )).await;

    let result = match crate::inference::run_chat(&state.db, &state.runtime, request).await {
        Ok(result) => result,
        Err(err) => {
            state.runtime.push_log(format!("< 400 ERROR  {}", truncate_log(&err, 160))).await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id,
                username: None,
                display_name: None,
                api_key_prefix: "desktop".into(),
                endpoint: "/app/chat".into(),
                model: Some(model.clone()),
                input_text: input_text.clone(),
                output_text: String::new(),
                input_tokens: token_estimate(&input_text),
                output_tokens: 0,
                status_code: 400,
                error_message: Some(err.clone()),
                created_at: now_ts(),
            });
            return Err(err);
        }
    };
    let finish_reason = result
        .response
        .choices
        .first()
        .and_then(|c| c.finish_reason.clone());
    state.runtime.push_log(format!(
        "< 200 OK  in={} out={} total={}  {}ms  {:.1} tok/s",
        result.input_tokens,
        result.output_tokens,
        result.input_tokens + result.output_tokens,
        result.time_ms,
        if result.time_ms > 0 { result.output_tokens as f64 * 1000.0 / result.time_ms as f64 } else { 0.0 }
    )).await;
    let _ = state.db.add_log(&RequestLogRecord {
        id: 0,
        user_id,
        username: None,
        display_name: None,
        api_key_prefix: "desktop".into(),
        endpoint: "/app/chat".into(),
        model: Some(model.clone()),
        input_text: result.input_text.clone(),
        output_text: result.output_text.clone(),
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        status_code: 200,
        error_message: None,
        created_at: now_ts(),
    });
    tracing::info!(
        output_tokens = result.output_tokens,
        time_ms = result.time_ms,
        "chat completed"
    );
    Ok(serde_json::json!({
        "text": result.output_text,
        "output_tokens": result.output_tokens,
        "input_tokens": result.input_tokens,
        "time_ms": result.time_ms,
        "finish_reason": finish_reason,
    }))
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(requester_user_id, scope = ?scope))]
fn dashboard(
    state: State<'_, AppState>,
    requester_user_id: i64,
    requester_role: String,
    scope: Option<String>,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
) -> Result<DashboardSummary, String> {
    state
        .db
        .dashboard(requester_user_id, requester_role, scope, start_ts, end_ts)
}

#[tauri::command]
fn get_system_memory() -> serde_json::Value {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    serde_json::json!({
        "total_bytes": sys.total_memory(),
        "available_bytes": sys.available_memory(),
    })
}

#[tauri::command]
async fn cancel_download(
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), String> {
    state.cancelled_downloads.lock().unwrap().insert(download_id);
    Ok(())
}

pub fn run_cli(args: &[String]) -> i32 {
    cli::run(args)
}

pub fn run_daemon_worker(args: &[String]) -> i32 {
    cli::run_daemon_worker(args)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from(".").join("data"));
            let db_path = app_data_dir.join("llmeter.sqlite");
            let model_store_dir = app_data_dir.join("models");
            let session_store_dir = app_data_dir.join("sessions");
            let hf_cache_dir = app_data_dir.join("huggingface-cache");
            let python_env_dir = app_data_dir.join("python-envs").join("hf-to-gguf");
            let log_dir = app_data_dir.join("logs");

            std::fs::create_dir_all(&session_store_dir)
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
            std::fs::create_dir_all(&hf_cache_dir)
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
            std::fs::create_dir_all(&log_dir)
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;

            // Rolling daily log file: {app_data_dir}/logs/llmeter.YYYY-MM-DD.log
            let file_appender = tracing_appender::rolling::daily(&log_dir, "llmeter.log");
            let (non_blocking, log_guard) = tracing_appender::non_blocking(file_appender);
            tracing_subscriber::fmt()
                .with_writer(non_blocking)
                .with_target(true)
                .with_ansi(false)
                .init();

            tracing::info!(log_dir = %log_dir.display(), "LLMeter starting — log file initialised");

            let db = Db::new(db_path.clone(), model_store_dir);
            db.init()
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
            let runtime = ModelRuntime::new();
            let server = ServerManager::new();
            let auto_start_db = db.clone();
            let auto_start_runtime = runtime.clone();
            let auto_start_server = server.clone();
            let auto_start_sessions = session_store_dir.clone();
            app.manage(AppState {
                db,
                runtime,
                server,
                app_data_dir,
                database_path: db_path,
                session_store_dir,
                hf_cache_dir,
                python_env_dir,
                cancelled_downloads: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
                _log_guard: log_guard,
            });
            tauri::async_runtime::spawn(async move {
                match auto_start_server
                    .ensure_service(auto_start_db, auto_start_runtime, auto_start_sessions)
                    .await
                {
                    Ok(status) => tracing::info!(
                        host = %status.host,
                        port = status.port,
                        state = %status.state,
                        "local HTTP control service ready"
                    ),
                    Err(err) => tracing::warn!(error = %err, "local HTTP control service failed"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_setup_state,
            setup_admin,
            login,
            read_chat_attachment,
            open_external_url,
            scan_model_store,
            list_models,
            import_model,
            delete_model,
            download_model,
            download_and_convert_hf_model,
            get_model_store_dir,
            get_app_storage_dirs,
            list_chat_groups,
            create_chat_group,
            delete_chat_group,
            list_chat_sessions,
            save_chat_session,
            delete_chat_session,
            reveal_chat_session,
            get_settings,
            save_settings,
            start_server,
            stop_server,
            get_server_status,
            get_public_server_status,
            load_model,
            eject_model,
            loaded_model_status,
            refresh_model_type,
            set_model_mmproj_path,
            get_model_logs,
            clear_model_logs,
            list_users,
            create_user,
            update_user,
            delete_user,
            list_api_keys,
            create_api_key,
            delete_api_key,
            list_logs,
            dashboard,
            chat,
            get_system_memory,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running LLMeter");
}
