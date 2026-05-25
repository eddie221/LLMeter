use crate::auth::{now_ts, token_estimate};
use crate::db::{AuthContext, Db};
use crate::inference::{run_chat, ChatCompletionRequest, ChatMessage, ChatMessageContent};
use crate::model_runtime::ModelRuntime;
use crate::types::{
    ChatGroupRecord, ChatSessionRecord, CreateUserRequest, LoginRequest, ModelLoadSettings,
    RequestLogRecord, ServerStatus, SetupAdminRequest, UpdateUserRequest,
};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Query, State};
use axum::http::header;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;

#[derive(Debug, Clone)]
pub struct ServerManager {
    inner: Arc<Mutex<ServerInner>>,
}

#[derive(Debug)]
struct ServerInner {
    status: ServerStatus,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct ApiState {
    db: Db,
    runtime: ModelRuntime,
    server: ServerManager,
    session_store_dir: PathBuf,
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ServerInner {
                status: ServerStatus {
                    state: "stopped".into(),
                    host: "127.0.0.1".into(),
                    port: 1234,
                    error: None,
                },
                shutdown: None,
            })),
        }
    }

    pub fn status(&self) -> ServerStatus {
        self.inner
            .lock()
            .expect("server mutex poisoned")
            .status
            .clone()
    }

    pub async fn start(
        &self,
        db: Db,
        runtime: ModelRuntime,
        session_store_dir: PathBuf,
    ) -> Result<ServerStatus, String> {
        self.ensure_service(db, runtime, session_store_dir).await?;
        Ok(self.start_api())
    }

    pub fn start_api(&self) -> ServerStatus {
        let mut inner = self.inner.lock().expect("server mutex poisoned");
        inner.status.state = "running".into();
        inner.status.error = None;
        inner.status.clone()
    }

    pub async fn ensure_service(
        &self,
        db: Db,
        runtime: ModelRuntime,
        session_store_dir: PathBuf,
    ) -> Result<ServerStatus, String> {
        let settings = db.get_settings()?;
        {
            let mut inner = self.inner.lock().expect("server mutex poisoned");
            if inner.shutdown.is_some() {
                return Ok(inner.status.clone());
            }
            inner.status = ServerStatus {
                state: "stopped".into(),
                host: settings.host.clone(),
                port: settings.port,
                error: None,
            };
        }

        let addr = format!("{}:{}", settings.host, settings.port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(err) => {
                let mut inner = self.inner.lock().expect("server mutex poisoned");
                inner.status = ServerStatus {
                    state: "error".into(),
                    host: settings.host,
                    port: settings.port,
                    error: Some(err.to_string()),
                };
                return Ok(inner.status.clone());
            }
        };

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let app = Router::new()
            .route("/", get(web_dashboard))
            .route("/web/assets/dashboard.css", get(web_dashboard_css))
            .route("/web/assets/dashboard.js", get(web_dashboard_js))
            .route(
                "/web/assets/vendor/bootstrap-icons/bootstrap-icons.css",
                get(web_bootstrap_icons_css),
            )
            .route(
                "/web/assets/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2",
                get(web_bootstrap_icons_woff2),
            )
            .route(
                "/web/assets/vendor/bootstrap-icons/fonts/bootstrap-icons.woff",
                get(web_bootstrap_icons_woff),
            )
            .route("/web/setup-state", get(web_setup_state))
            .route("/web/setup", post(web_setup))
            .route("/web/login", post(web_login))
            .route("/web/dashboard", get(web_dashboard_data))
            .route("/web/logs", get(web_logs))
            .route("/web/server", get(web_server_state))
            .route("/web/admin/server/start", post(web_admin_start_server))
            .route("/web/admin/server/stop", post(web_admin_stop_server))
            .route("/web/models", get(web_models))
            .route("/web/admin/models/load", post(web_admin_load_model))
            .route("/web/admin/models/eject", post(web_admin_eject_model))
            .route("/web/admin/models/delete", post(web_admin_delete_model))
            .route(
                "/web/chat/groups",
                get(web_chat_groups).post(web_create_chat_group),
            )
            .route("/web/chat/groups/delete", post(web_delete_chat_group))
            .route(
                "/web/chat/sessions",
                get(web_chat_sessions).post(web_save_chat_session),
            )
            .route("/web/chat/sessions/delete", post(web_delete_chat_session))
            .route("/web/profile", post(web_update_profile))
            .route("/web/api-keys", get(web_api_keys).post(web_create_api_key))
            .route("/web/api-keys/delete", post(web_delete_api_key))
            .route("/web/admin", get(web_admin_state))
            .route("/web/admin/users", post(web_admin_create_user))
            .route("/web/admin/users/update", post(web_admin_update_user))
            .route("/web/admin/users/delete", post(web_admin_delete_user))
            .route("/web/admin/api-keys", post(web_admin_create_api_key))
            .route("/web/admin/api-keys/delete", post(web_admin_delete_api_key))
            .route("/v1/models", get(list_models))
            .route("/v1/messages", post(anthropic_messages))
            .route("/v1/chat/completions", post(chat_completions))
            .route("/api/v1/chat", post(simple_chat))
            .layer(CorsLayer::permissive())
            .with_state(ApiState {
                db: db.clone(),
                runtime,
                server: self.clone(),
                session_store_dir,
            });

        {
            let mut inner = self.inner.lock().expect("server mutex poisoned");
            inner.shutdown = Some(shutdown_tx);
            inner.status = ServerStatus {
                state: "stopped".into(),
                host: settings.host.clone(),
                port: settings.port,
                error: None,
            };
        }

        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(self.status())
    }

    pub fn stop(&self) -> ServerStatus {
        let mut inner = self.inner.lock().expect("server mutex poisoned");
        inner.status.state = "stopped".into();
        inner.status.error = None;
        inner.status.clone()
    }
}

#[derive(Debug, Deserialize)]
struct LogsQuery {
    search: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashboardQuery {
    scope: Option<String>,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct WebCreateApiKeyRequest {
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebDeleteApiKeyRequest {
    key_id: i64,
}

#[derive(Debug, Deserialize)]
struct WebDeleteModelRequest {
    model_id: i64,
}

#[derive(Debug, Deserialize)]
struct WebLoadModelRequest {
    model_id: i64,
    context_length: Option<u32>,
    n_threads: Option<u32>,
    load_settings: Option<ModelLoadSettings>,
}

#[derive(Debug, Deserialize)]
struct WebEjectModelRequest {
    model_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebUpdateProfileRequest {
    username: String,
    display_name: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebAdminCreateApiKeyRequest {
    user_id: i64,
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebAdminDeleteUserRequest {
    user_id: i64,
}

#[derive(Debug, Deserialize)]
struct WebChatSessionsQuery {
    group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebCreateChatGroupRequest {
    name: String,
}

#[derive(Debug, Deserialize)]
struct WebDeleteChatGroupRequest {
    group_id: String,
}

#[derive(Debug, Deserialize)]
struct WebSaveChatSessionRequest {
    group_id: String,
    session: ChatSessionRecord,
}

#[derive(Debug, Deserialize)]
struct WebDeleteChatSessionRequest {
    group_id: String,
    session_id: String,
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

fn web_legacy_user_session_dir(state: &ApiState, user_id: i64) -> PathBuf {
    state.session_store_dir.join(format!("user_{user_id}"))
}

fn web_user_session_dir(state: &ApiState, user_id: i64) -> Result<PathBuf, String> {
    let uid = state.db.get_user_uid(user_id)?;
    Ok(state.session_store_dir.join(format!("user_{uid}")))
}

fn web_migrate_legacy_user_session_dir(state: &ApiState, user_id: i64) -> Result<(), String> {
    let legacy_dir = web_legacy_user_session_dir(state, user_id);
    let uid_dir = web_user_session_dir(state, user_id)?;
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

fn web_migrate_legacy_ungrouped_sessions(state: &ApiState, user_id: i64) -> Result<(), String> {
    web_migrate_legacy_user_session_dir(state, user_id)?;
    let user_dir = web_user_session_dir(state, user_id)?;
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

fn web_group_dir(state: &ApiState, user_id: i64, group_id: &str) -> Result<PathBuf, String> {
    web_migrate_legacy_user_session_dir(state, user_id)?;
    let user_dir = web_user_session_dir(state, user_id)?;
    if group_id.trim().is_empty() {
        Ok(user_dir)
    } else {
        Ok(user_dir.join(sanitize_storage_id(group_id, "group")))
    }
}

fn write_web_group_metadata(dir: &std::path::Path, group: &ChatGroupRecord) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let json = serde_json::to_string_pretty(group).map_err(|err| err.to_string())?;
    fs::write(dir.join("group.json"), json).map_err(|err| err.to_string())
}

async fn web_dashboard() -> Html<&'static str> {
    Html(WEB_DASHBOARD_HTML)
}

async fn web_dashboard_css() -> Response {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        WEB_DASHBOARD_CSS,
    )
        .into_response()
}

async fn web_dashboard_js() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        WEB_DASHBOARD_JS,
    )
        .into_response()
}

async fn web_bootstrap_icons_css() -> Response {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        WEB_BOOTSTRAP_ICONS_CSS,
    )
        .into_response()
}

async fn web_bootstrap_icons_woff2() -> Response {
    (
        [(header::CONTENT_TYPE, "font/woff2")],
        WEB_BOOTSTRAP_ICONS_WOFF2,
    )
        .into_response()
}

async fn web_bootstrap_icons_woff() -> Response {
    (
        [(header::CONTENT_TYPE, "font/woff")],
        WEB_BOOTSTRAP_ICONS_WOFF,
    )
        .into_response()
}

async fn web_setup_state(State(state): State<ApiState>) -> Response {
    match state.db.needs_setup() {
        Ok(needs_setup) => Json(json!({ "needs_setup": needs_setup })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_setup(
    State(state): State<ApiState>,
    Json(payload): Json<SetupAdminRequest>,
) -> Response {
    match state.db.setup_admin(payload) {
        Ok(user) => match state.db.create_api_key(user.id, "Web session".into()) {
            Ok(key) => Json(json!({ "user": user, "api_key": key.secret })).into_response(),
            Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
        },
        Err(err) => api_error(StatusCode::BAD_REQUEST, &err),
    }
}

async fn web_login(State(state): State<ApiState>, Json(payload): Json<LoginRequest>) -> Response {
    match state.db.login(payload) {
        Ok(user) => match state.db.create_api_key(user.id, "Web session".into()) {
            Ok(key) => Json(json!({ "user": user, "api_key": key.secret })).into_response(),
            Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
        },
        Err(err) => api_error(StatusCode::UNAUTHORIZED, &err),
    }
}

async fn web_dashboard_data(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<DashboardQuery>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to view dashboard data.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    match state.db.dashboard(
        auth.user_id,
        auth.role,
        query.scope,
        query.start_ts,
        query.end_ts,
    ) {
        Ok(summary) => Json(summary).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_logs(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<LogsQuery>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to view request logs.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    match state.db.list_logs(query.search, auth.user_id, auth.role) {
        Ok(logs) => Json(logs).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_server_state(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    match authorize(&state.db, &headers) {
        Ok(Some(_auth)) => {
            let models = state.runtime.statuses().await;
            Json(json!({ "server": state.server.status(), "loaded_models": models }))
                .into_response()
        }
        Ok(None) => api_error(
            StatusCode::UNAUTHORIZED,
            "Enter a valid API key to view server model state.",
        ),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_admin_start_server(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    let status = state.server.start_api();
    Json(json!({ "server": status })).into_response()
}

async fn web_admin_stop_server(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    let status = state.server.stop();
    Json(json!({ "server": status })).into_response()
}

async fn web_models(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    match authorize(&state.db, &headers) {
        Ok(Some(_auth)) => {
            let models = match state.db.list_models() {
                Ok(models) => models,
                Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
            };
            let loaded_models = state.runtime.statuses().await;
            Json(json!({ "models": models, "loaded_models": loaded_models })).into_response()
        }
        Ok(None) => api_error(
            StatusCode::UNAUTHORIZED,
            "Enter a valid API key to view local models.",
        ),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_admin_load_model(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebLoadModelRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    match state
        .runtime
        .load_model(
            &state.db,
            payload.model_id,
            payload.context_length,
            payload.n_threads,
            payload.load_settings,
        )
        .await
    {
        Ok(statuses) => Json(json!({ "loaded_models": statuses })).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, &err),
    }
}

async fn web_admin_eject_model(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebEjectModelRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    match state.runtime.eject_model(payload.model_name).await {
        Ok(statuses) => Json(json!({ "loaded_models": statuses })).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, &err),
    }
}

async fn web_admin_delete_model(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebDeleteModelRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    if let Err(err) = state.runtime.eject_model_id(payload.model_id).await {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err);
    }
    match state.db.delete_model(payload.model_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_chat_groups(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to view chat groups.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    let user_dir = match web_user_session_dir(&state, auth.user_id) {
        Ok(dir) => dir,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    if let Err(err) = fs::create_dir_all(&user_dir) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
    }
    let mut groups = Vec::new();
    let entries = match fs::read_dir(&user_dir) {
        Ok(entries) => entries,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let metadata_path = entry.path().join("group.json");
        if metadata_path.exists() {
            if let Ok(json) = fs::read_to_string(metadata_path) {
                if let Ok(group) = serde_json::from_str::<ChatGroupRecord>(&json) {
                    groups.push(group);
                }
            }
        }
    }
    groups.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Json(groups).into_response()
}

async fn web_create_chat_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebCreateChatGroupRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to create chat groups.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let name = payload.name.trim();
    if name.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "Group name is required.");
    }
    let user_dir = match web_user_session_dir(&state, auth.user_id) {
        Ok(dir) => dir,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    if let Err(err) = fs::create_dir_all(&user_dir) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
    }
    let base = sanitize_storage_id(name, "group");
    let mut id = base.clone();
    for index in 2.. {
        if !user_dir.join(&id).exists() {
            break;
        }
        id = format!("{base}-{index}");
    }
    let group = ChatGroupRecord {
        id: id.clone(),
        name: name.to_string(),
    };
    match write_web_group_metadata(&user_dir.join(id), &group) {
        Ok(()) => Json(group).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_delete_chat_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebDeleteChatGroupRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to delete chat groups.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let dir = match web_group_dir(&state, auth.user_id, &payload.group_id) {
        Ok(dir) => dir,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    if dir.exists() {
        if let Err(err) = fs::remove_dir_all(dir) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
        }
    }
    Json(json!({ "ok": true })).into_response()
}

async fn web_chat_sessions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<WebChatSessionsQuery>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to view chat sessions.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let group_id = query.group_id.unwrap_or_default();
    if group_id.trim().is_empty() {
        if let Err(err) = web_migrate_legacy_ungrouped_sessions(&state, auth.user_id) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err);
        }
    }
    let dir = match web_group_dir(&state, auth.user_id, &group_id) {
        Ok(dir) => dir,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    if !dir.is_dir() {
        return Json(Vec::<ChatSessionRecord>::new()).into_response();
    }
    let mut sessions = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some("group.json") {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Ok(json) = fs::read_to_string(path) {
            if let Ok(session) = serde_json::from_str::<ChatSessionRecord>(&json) {
                sessions.push(session);
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Json(sessions).into_response()
}

async fn web_save_chat_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebSaveChatSessionRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to save chat sessions.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    if payload.session.id.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "Session id is required.");
    }
    if payload.group_id.trim().is_empty() {
        if let Err(err) = web_migrate_legacy_ungrouped_sessions(&state, auth.user_id) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err);
        }
    }
    let dir = match web_group_dir(&state, auth.user_id, &payload.group_id) {
        Ok(dir) => dir,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    if let Err(err) = fs::create_dir_all(&dir) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
    }
    let file_name = format!(
        "{}.json",
        sanitize_storage_id(&payload.session.id, "session")
    );
    let json = match serde_json::to_string_pretty(&payload.session) {
        Ok(json) => json,
        Err(err) => return api_error(StatusCode::BAD_REQUEST, &err.to_string()),
    };
    match fs::write(dir.join(file_name), json) {
        Ok(()) => Json(payload.session).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

async fn web_delete_chat_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebDeleteChatSessionRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to delete chat sessions.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let dir = match web_group_dir(&state, auth.user_id, &payload.group_id) {
        Ok(dir) => dir,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let file_name = format!(
        "{}.json",
        sanitize_storage_id(&payload.session_id, "session")
    );
    let _ = fs::remove_file(dir.join(file_name));
    Json(json!({ "ok": true })).into_response()
}

async fn web_update_profile(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebUpdateProfileRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to update your profile.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    let current = match state.db.get_user(auth.user_id) {
        Ok(user) => user,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let input = UpdateUserRequest {
        id: current.id,
        username: payload.username,
        display_name: payload.display_name,
        role: current.role,
        enabled: current.enabled,
        password: payload.password,
    };
    match state.db.update_user(input) {
        Ok(user) => Json(user).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, &err),
    }
}

async fn web_api_keys(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to view profile API keys.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    match state.db.list_api_keys(Some(auth.user_id)) {
        Ok(keys) => Json(keys).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_create_api_key(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebCreateApiKeyRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to create profile API keys.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    let label = payload
        .label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Web API key".into());
    match state.db.create_api_key(auth.user_id, label) {
        Ok(key) => Json(key).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_delete_api_key(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebDeleteApiKeyRequest>,
) -> Response {
    let auth = match authorize(&state.db, &headers) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Enter a valid API key to delete profile API keys.",
            )
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };

    match state.db.get_api_key(payload.key_id) {
        Ok(key) if key.user_id == auth.user_id => match state.db.delete_api_key(payload.key_id) {
            Ok(()) => Json(json!({ "ok": true })).into_response(),
            Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
        },
        Ok(_) => api_error(
            StatusCode::FORBIDDEN,
            "You can only delete your own API keys.",
        ),
        Err(_) => api_error(StatusCode::NOT_FOUND, "API key not found."),
    }
}

async fn web_admin_state(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let auth = match require_web_admin(&state.db, &headers) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let _ = auth;

    let users = match state.db.list_users() {
        Ok(users) => users,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let keys = match state.db.list_api_keys(None) {
        Ok(keys) => keys,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    Json(json!({ "users": users, "api_keys": keys })).into_response()
}

async fn web_admin_create_user(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<CreateUserRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    match state.db.create_user(payload) {
        Ok(user) => Json(user).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, &err),
    }
}

async fn web_admin_update_user(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateUserRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    match state.db.update_user(payload) {
        Ok(user) => Json(user).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, &err),
    }
}

async fn web_admin_delete_user(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebAdminDeleteUserRequest>,
) -> Response {
    let auth = match require_web_admin(&state.db, &headers) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    if payload.user_id == auth.user_id {
        return api_error(
            StatusCode::BAD_REQUEST,
            "You cannot delete your own account.",
        );
    }
    match state.db.delete_user(payload.user_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_admin_create_api_key(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebAdminCreateApiKeyRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    let label = payload
        .label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Admin-created key".into());
    match state.db.create_api_key(payload.user_id, label) {
        Ok(key) => Json(key).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn web_admin_delete_api_key(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<WebDeleteApiKeyRequest>,
) -> Response {
    if let Err(response) = require_web_admin(&state.db, &headers) {
        return response;
    }
    match state.db.delete_api_key(payload.key_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn list_models(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_api_server_running(&state.server) {
        return resp;
    }
    match api_auth(&state.db, &headers) {
        Ok(_auth) => {
            let loaded = state.runtime.statuses().await;
            let mut models = Vec::new();
            for status in loaded.into_iter().filter(|status| status.loaded) {
                let Some(name) = status.model_name else {
                    continue;
                };
                let Some(model_id) = status.model_id else {
                    continue;
                };
                match state.db.get_model_by_id(model_id) {
                    Ok(Some(mut model)) => {
                        model.name = name;
                        models.push(model);
                    }
                    Ok(None) => {}
                    Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
                }
            }
            Json(json!({
                "object": "list",
                "data": models.into_iter().map(|model| json!({
                    "id": model.name,
                    "object": "model",
                    "created": model.created_at,
                    "owned_by": "local"
                })).collect::<Vec<_>>()
            }))
            .into_response()
        }
        Err(resp) => resp,
    }
}

async fn chat_completions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: Result<Json<ChatCompletionRequest>, JsonRejection>,
) -> Response {
    if let Err(resp) = require_api_server_running(&state.server) {
        return resp;
    }
    let auth = match api_auth(&state.db, &headers) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };

    let payload = match payload {
        Ok(Json(payload)) => payload,
        Err(err) => {
            let message = format!("Invalid chat completions request body: {err}");
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/v1/chat/completions".into(),
                model: None,
                input_text: String::new(),
                output_text: String::new(),
                input_tokens: 0,
                output_tokens: 0,
                status_code: 400,
                error_message: Some(message.clone()),
                created_at: now_ts(),
            });
            return api_error(StatusCode::BAD_REQUEST, &message);
        }
    };

    let model = payload.model.clone();
    let last_user = payload
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| truncate(&m.content.to_log_text(), 120))
        .unwrap_or_default();
    state
        .runtime
        .push_log(format!(
            "> POST /v1/chat/completions  model=\"{}\"  messages={}  input=\"{}\"",
            model,
            payload.messages.len(),
            last_user
        ))
        .await;
    let input_text = payload
        .messages
        .iter()
        .map(|msg| format!("{}: {}", msg.role, msg.content.to_log_text()))
        .collect::<Vec<_>>()
        .join("\n");
    match run_chat(&state.db, &state.runtime, payload).await {
        Ok(result) => {
            state
                .runtime
                .push_log(format!(
                    "< 200 OK  in={} out={} total={}",
                    result.input_tokens,
                    result.output_tokens,
                    result.input_tokens + result.output_tokens
                ))
                .await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/v1/chat/completions".into(),
                model: Some(model),
                input_text: result.input_text,
                output_text: result.output_text,
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
                status_code: 200,
                error_message: None,
                created_at: now_ts(),
            });
            Json(result.response).into_response()
        }
        Err(err) => {
            state
                .runtime
                .push_log(format!("< 400 ERROR  {}", truncate(&err, 160)))
                .await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/v1/chat/completions".into(),
                model: Some(model),
                input_text: input_text.clone(),
                output_text: String::new(),
                input_tokens: token_estimate(&input_text),
                output_tokens: 0,
                status_code: 400,
                error_message: Some(err.clone()),
                created_at: now_ts(),
            });
            api_error(StatusCode::BAD_REQUEST, &err)
        }
    }
}

#[derive(Debug, Deserialize)]
struct AnthropicMessagesRequest {
    model: String,
    max_tokens: Option<u32>,
    messages: Vec<AnthropicRequestMessage>,
    system: Option<serde_json::Value>,
    temperature: Option<f32>,
    stream: Option<bool>,
    top_p: Option<f32>,
    top_k: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct AnthropicRequestMessage {
    role: String,
    content: serde_json::Value,
}

async fn anthropic_messages(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: Result<Json<AnthropicMessagesRequest>, JsonRejection>,
) -> Response {
    if let Err(resp) = require_api_server_running(&state.server) {
        return resp;
    }
    let auth = match api_auth(&state.db, &headers) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };

    let payload = match payload {
        Ok(Json(payload)) => payload,
        Err(err) => {
            let message = format!("Invalid Anthropic messages request body: {err}");
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/v1/messages".into(),
                model: None,
                input_text: String::new(),
                output_text: String::new(),
                input_tokens: 0,
                output_tokens: 0,
                status_code: 400,
                error_message: Some(message.clone()),
                created_at: now_ts(),
            });
            return api_error(StatusCode::BAD_REQUEST, &message);
        }
    };

    let model = payload.model.clone();
    let mut messages = Vec::new();
    if let Some(system) = &payload.system {
        let content = anthropic_content_to_text(system);
        if !content.trim().is_empty() {
            messages.push(ChatMessage {
                role: "system".into(),
                content: ChatMessageContent::text(content),
            });
        }
    }
    for message in &payload.messages {
        let role = match message.role.as_str() {
            "user" | "assistant" => message.role.clone(),
            other => other.to_string(),
        };
        let content = anthropic_content_to_text(&message.content);
        if !content.trim().is_empty() {
            messages.push(ChatMessage {
                role,
                content: ChatMessageContent::text(content),
            });
        }
    }

    let input_text = messages
        .iter()
        .map(|msg| format!("{}: {}", msg.role, msg.content.to_log_text()))
        .collect::<Vec<_>>()
        .join("\n");

    state
        .runtime
        .push_log(format!(
            "> POST /v1/messages  model=\"{}\"  messages={}",
            model,
            messages.len()
        ))
        .await;

    let completion_request = ChatCompletionRequest {
        model: model.clone(),
        messages,
        temperature: payload.temperature,
        max_tokens: payload.max_tokens,
        top_p: payload.top_p,
        top_k: payload.top_k,
        min_p: None,
        repeat_penalty: None,
        presence_penalty: None,
        stop: None,
    };

    match run_chat(&state.db, &state.runtime, completion_request).await {
        Ok(result) => {
            state
                .runtime
                .push_log(format!(
                    "< 200 OK  in={} out={} total={}",
                    result.input_tokens,
                    result.output_tokens,
                    result.input_tokens + result.output_tokens
                ))
                .await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/v1/messages".into(),
                model: Some(model.clone()),
                input_text: result.input_text.clone(),
                output_text: result.output_text.clone(),
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
                status_code: 200,
                error_message: None,
                created_at: now_ts(),
            });
            if payload.stream == Some(true) {
                anthropic_stream_response(
                    &model,
                    &result.output_text,
                    result.input_tokens,
                    result.output_tokens,
                )
            } else {
                Json(json!({
                    "id": result.response.id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [{ "type": "text", "text": result.output_text }],
                    "stop_reason": "end_turn",
                    "stop_sequence": null,
                    "usage": {
                        "input_tokens": result.input_tokens,
                        "output_tokens": result.output_tokens
                    }
                }))
                .into_response()
            }
        }
        Err(err) => {
            state
                .runtime
                .push_log(format!("< 400 ERROR  {}", truncate(&err, 160)))
                .await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/v1/messages".into(),
                model: Some(model),
                input_text: input_text.clone(),
                output_text: String::new(),
                input_tokens: token_estimate(&input_text),
                output_tokens: 0,
                status_code: 400,
                error_message: Some(err.clone()),
                created_at: now_ts(),
            });
            api_error(StatusCode::BAD_REQUEST, &err)
        }
    }
}

fn anthropic_content_to_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                serde_json::Value::String(text) => Some(text.clone()),
                serde_json::Value::Object(map) => map
                    .get("text")
                    .and_then(|text| text.as_str())
                    .map(String::from)
                    .or_else(|| {
                        map.get("content")
                            .map(anthropic_content_to_text)
                            .filter(|text| !text.is_empty())
                    }),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Object(map) => map
            .get("text")
            .and_then(|text| text.as_str())
            .map(String::from)
            .or_else(|| map.get("content").map(anthropic_content_to_text))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn anthropic_stream_response(
    model: &str,
    output_text: &str,
    input_tokens: i64,
    output_tokens: i64,
) -> Response {
    let id = format!("msg_{}", now_ts());
    let events = [
        (
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": input_tokens, "output_tokens": 0 }
                }
            }),
        ),
        (
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }),
        ),
        (
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": output_text }
            }),
        ),
        (
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        (
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                "usage": { "output_tokens": output_tokens }
            }),
        ),
        ("message_stop", json!({ "type": "message_stop" })),
    ];
    let body = events
        .into_iter()
        .map(|(event, data)| format!("event: {event}\ndata: {data}\n\n"))
        .collect::<String>();
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

#[derive(Debug, Deserialize)]
struct SimpleChatRequest {
    model: String,
    system_prompt: Option<String>,
    input: String,
}

async fn simple_chat(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: Result<Json<SimpleChatRequest>, JsonRejection>,
) -> Response {
    if let Err(resp) = require_api_server_running(&state.server) {
        return resp;
    }
    let auth = match api_auth(&state.db, &headers) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };

    let payload = match payload {
        Ok(Json(payload)) => payload,
        Err(err) => {
            let message = format!("Invalid request body: {err}");
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/api/v1/chat".into(),
                model: None,
                input_text: String::new(),
                output_text: String::new(),
                input_tokens: 0,
                output_tokens: 0,
                status_code: 400,
                error_message: Some(message.clone()),
                created_at: now_ts(),
            });
            return api_error(StatusCode::BAD_REQUEST, &message);
        }
    };

    if payload.input.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "input must not be empty");
    }

    let model = payload.model.clone();
    state
        .runtime
        .push_log(format!(
            "> POST /api/v1/chat  model=\"{}\"  input=\"{}\"",
            model,
            truncate(&payload.input, 120)
        ))
        .await;
    let mut messages: Vec<ChatMessage> = Vec::new();
    if let Some(ref system_prompt) = payload.system_prompt {
        if !system_prompt.trim().is_empty() {
            messages.push(ChatMessage {
                role: "system".into(),
                content: ChatMessageContent::text(system_prompt.clone()),
            });
        }
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: ChatMessageContent::text(payload.input.clone()),
    });

    let completion_request = ChatCompletionRequest {
        model: model.clone(),
        messages,
        temperature: None,
        max_tokens: None,
        top_p: None,
        top_k: None,
        min_p: None,
        repeat_penalty: None,
        presence_penalty: None,
        stop: None,
    };

    match run_chat(&state.db, &state.runtime, completion_request).await {
        Ok(result) => {
            state
                .runtime
                .push_log(format!(
                    "< 200 OK  in={} out={} total={}",
                    result.input_tokens,
                    result.output_tokens,
                    result.input_tokens + result.output_tokens
                ))
                .await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/api/v1/chat".into(),
                model: Some(model.clone()),
                input_text: result.input_text,
                output_text: result.output_text.clone(),
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
                status_code: 200,
                error_message: None,
                created_at: now_ts(),
            });
            Json(json!({
                "model": model,
                "output": result.output_text,
                "usage": {
                    "input_tokens": result.input_tokens,
                    "output_tokens": result.output_tokens,
                    "total_tokens": result.input_tokens + result.output_tokens
                }
            }))
            .into_response()
        }
        Err(err) => {
            state
                .runtime
                .push_log(format!("< 400 ERROR  {}", truncate(&err, 160)))
                .await;
            let _ = state.db.add_log(&RequestLogRecord {
                id: 0,
                user_id: auth.user_id,
                display_name: None,
                username: None,
                api_key_prefix: auth.api_key_prefix,
                endpoint: "/api/v1/chat".into(),
                model: Some(model),
                input_text: payload.input,
                output_text: String::new(),
                input_tokens: 0,
                output_tokens: 0,
                status_code: 400,
                error_message: Some(err.clone()),
                created_at: now_ts(),
            });
            api_error(StatusCode::BAD_REQUEST, &err)
        }
    }
}

fn authorize(db: &Db, headers: &HeaderMap) -> Result<Option<AuthContext>, String> {
    let secret = if let Some(value) = headers.get("authorization") {
        let value = value.to_str().map_err(|err| err.to_string())?;
        value
            .strip_prefix("Bearer ")
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
            .map(String::from)
    } else if let Some(value) = headers.get("x-api-key") {
        Some(
            value
                .to_str()
                .map_err(|err| err.to_string())?
                .trim()
                .to_string(),
        )
        .filter(|secret| !secret.is_empty())
    } else {
        None
    };
    let Some(secret) = secret else {
        return Ok(None);
    };
    db.resolve_api_key(secret.trim())
}

fn require_web_admin(db: &Db, headers: &HeaderMap) -> Result<AuthContext, Response> {
    match authorize(db, headers) {
        Ok(Some(auth)) if auth.role == "admin" => Ok(auth),
        Ok(Some(_)) => Err(api_error(StatusCode::FORBIDDEN, "Admin access required.")),
        Ok(None) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Enter a valid admin API key.",
        )),
        Err(err) => Err(api_error(StatusCode::INTERNAL_SERVER_ERROR, &err)),
    }
}

/// For the public API endpoints (`/v1/*`): skip key check when `require_api_key`
/// is disabled in settings; otherwise behave like a normal bearer-token check.
fn api_auth(db: &Db, headers: &HeaderMap) -> Result<AuthContext, Response> {
    let settings = db
        .get_settings()
        .map_err(|err| api_error(StatusCode::INTERNAL_SERVER_ERROR, &err))?;
    if !settings.require_api_key {
        return Ok(AuthContext {
            user_id: 0,
            role: "user".into(),
            api_key_prefix: "anonymous".into(),
        });
    }
    match authorize(db, headers) {
        Ok(Some(auth)) => Ok(auth),
        Ok(None) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid API key.",
        )),
        Err(err) => Err(api_error(StatusCode::INTERNAL_SERVER_ERROR, &err)),
    }
}

fn require_api_server_running(server: &ServerManager) -> Result<(), Response> {
    if server.status().state == "running" {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "LLMeter API server is stopped. Run `llmeter server start` or start it from the desktop app.",
        ))
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "type": "invalid_request_error"
            }
        })),
    )
        .into_response()
}

const WEB_DASHBOARD_HTML: &str = include_str!("../web/index.html");
const WEB_DASHBOARD_CSS: &str = include_str!("../web/dashboard.css");
const WEB_DASHBOARD_JS: &str = include_str!("../web/dashboard.js");
const WEB_BOOTSTRAP_ICONS_CSS: &str =
    include_str!("../web/vendor/bootstrap-icons/bootstrap-icons.css");
const WEB_BOOTSTRAP_ICONS_WOFF2: &[u8] =
    include_bytes!("../web/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2");
const WEB_BOOTSTRAP_ICONS_WOFF: &[u8] =
    include_bytes!("../web/vendor/bootstrap-icons/fonts/bootstrap-icons.woff");
