use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserAccount {
    pub id: i64,
    pub uid: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupState {
    pub needs_setup: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetupAdminRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    pub user: UserAccount,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyRecord {
    pub id: i64,
    pub user_id: i64,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub label: String,
    pub key_prefix: String,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatedApiKey {
    pub record: ApiKeyRecord,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRecord {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub size_bytes: i64,
    pub format: String,
    pub status: String,
    pub context_length_max: Option<u32>,
    pub created_at: i64,
    pub hf_repo: Option<String>,
    pub model_type: Option<String>,
    pub mmproj_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedModelStatus {
    pub loaded: bool,
    pub model_id: Option<i64>,
    pub model_name: Option<String>,
    pub model_type: Option<String>,
    pub mmproj_path: Option<String>,
    pub port: Option<u16>,
    pub context_length: Option<u32>,
    pub n_threads: Option<u32>,
    pub load_settings: Option<ModelLoadSettings>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLoadSettings {
    pub temperature: f32,
    pub limit_response_length: bool,
    pub max_tokens: Option<u32>,
    pub context_overflow: String,
    pub stop_strings: Vec<String>,
    pub top_k: Option<u32>,
    pub repeat_penalty_enabled: bool,
    pub repeat_penalty: Option<f32>,
    pub presence_penalty_enabled: bool,
    pub presence_penalty: Option<f32>,
    pub top_p_enabled: bool,
    pub top_p: Option<f32>,
    pub min_p_enabled: bool,
    pub min_p: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsRecord {
    pub host: String,
    pub port: u16,
    pub default_model: Option<String>,
    pub llama_cpp_path: Option<String>,
    pub hf_convert_script_path: Option<String>,
    pub allow_non_localhost: bool,
    pub require_api_key: bool,
    pub anthropic_api_key: Option<String>,
    pub inference_defaults: Option<InferenceParams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppStorageDirs {
    pub app_data_dir: String,
    pub database_path: String,
    pub model_store_dir: String,
    pub session_store_dir: String,
    pub hf_cache_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatGroupRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    pub role: String,
    pub content: String,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionRecord {
    pub id: String,
    pub title: String,
    pub model: String,
    pub system_prompt: String,
    pub messages: Vec<ChatMessageRecord>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogRecord {
    pub id: i64,
    pub user_id: i64,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub api_key_prefix: String,
    pub endpoint: String,
    pub model: Option<String>,
    pub input_text: String,
    pub output_text: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub status_code: i64,
    pub error_message: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStatus {
    pub state: String,
    pub host: String,
    pub port: u16,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardSummary {
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model_usage: Vec<ModelUsage>,
    pub daily_usage: Vec<TokenUsagePoint>,
    pub model_daily_usage: Vec<ModelDailyUsagePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsage {
    pub model: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsagePoint {
    pub day: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDailyUsagePoint {
    pub day: String,
    pub model: String,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
    pub role: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateUserRequest {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub enabled: bool,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveSettingsRequest {
    pub host: String,
    pub port: u16,
    pub default_model: Option<String>,
    pub llama_cpp_path: Option<String>,
    pub hf_convert_script_path: Option<String>,
    pub allow_non_localhost: bool,
    pub require_api_key: bool,
    pub anthropic_api_key: Option<String>,
    pub inference_defaults: Option<InferenceParams>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HuggingFaceRepoFileRequest {
    pub name: String,
    pub size: Option<u64>,
}
