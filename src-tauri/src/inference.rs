use crate::auth::{now_ts, token_estimate};
use crate::db::Db;
use crate::model_runtime::ModelRuntime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
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
pub struct ChatMessage {
    pub role: String,
    pub content: ChatMessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatMessageContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatContentPart {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<ChatImageUrl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatImageUrl {
    pub url: String,
}

impl ChatMessageContent {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    pub fn is_effectively_empty(&self) -> bool {
        match self {
            Self::Text(text) => text.trim().is_empty(),
            Self::Parts(parts) => parts.iter().all(|part| {
                part.text.as_deref().unwrap_or_default().trim().is_empty()
                    && part
                        .image_url
                        .as_ref()
                        .map(|image| image.url.trim().is_empty())
                        .unwrap_or(true)
            }),
        }
    }

    pub fn to_log_text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part.kind.as_str() {
                    "text" => part.text.clone(),
                    "image_url" => part
                        .image_url
                        .as_ref()
                        .map(|_| "[image attachment]".to_string()),
                    other => Some(format!("[{other} content]")),
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<ChatChoice>,
    pub usage: Option<ChatUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChoice {
    pub index: i64,
    pub message: ChatMessage,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone)]
pub struct InferenceResult {
    pub response: ChatCompletionResponse,
    pub input_text: String,
    pub output_text: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub time_ms: i64,
}

#[tracing::instrument(skip_all, fields(model = %request.model, num_messages = request.messages.len()), err)]
pub async fn run_chat(
    db: &Db,
    runtime: &ModelRuntime,
    request: ChatCompletionRequest,
) -> Result<InferenceResult, String> {
    tracing::info!("run_chat entered");
    if request.model.trim().is_empty() {
        return Err("model is required".into());
    }
    if request.messages.is_empty() {
        return Err("messages must contain at least one item".into());
    }
    for (index, message) in request.messages.iter().enumerate() {
        match message.role.as_str() {
            "system" | "user" | "assistant" | "tool" => {}
            _ => {
                return Err(format!(
                    "messages[{index}].role must be one of system, user, assistant, or tool"
                ))
            }
        }
        if message.content.is_effectively_empty() {
            return Err(format!("messages[{index}].content must not be empty"));
        }
    }
    if let Some(temperature) = request.temperature {
        if !(0.0..=2.0).contains(&temperature) {
            return Err("temperature must be between 0 and 2".into());
        }
    }
    if request.max_tokens == Some(0) {
        return Err("max_tokens must be greater than 0".into());
    }

    runtime.push_log(format!(
        "[{}] Generating...  (messages: {})",
        request.model,
        request.messages.len()
    )).await;

    if request.model.starts_with("claude-") {
        return run_anthropic_chat(db, request).await;
    }

    let model = db
        .get_model_by_name(&request.model)?
        .or_else(|| {
            request
                .model
                .rsplit_once(':')
                .and_then(|(base, suffix)| suffix.parse::<u32>().ok().map(|_| base.to_string()))
                .and_then(|base| db.get_model_by_name(&base).ok().flatten())
        })
        .ok_or_else(|| {
            format!(
                "Unknown model '{}'. Import it before using chat completions.",
                request.model
            )
        })?;
    if model.status != "ready" {
        return Err(format!(
            "Model '{}' is not ready. Only GGUF models are supported in v1.",
            model.name
        ));
    }

    let endpoint = runtime.endpoint_for(&request.model).await?;
    let input_text = request
        .messages
        .iter()
        .map(|message| format!("{}: {}", message.role, message.content.to_log_text()))
        .collect::<Vec<_>>()
        .join("\n");

    let t0 = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&request)
        .send()
        .await
        .map_err(|err| format!("Failed to call loaded llama-server: {err}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|err| err.to_string())?;
    let time_ms = t0.elapsed().as_millis() as i64;
    if !status.is_success() {
        return Err(if body.trim().is_empty() {
            format!("llama-server returned {status}")
        } else {
            body
        });
    }

    let mut parsed: ChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|err| format!("llama-server returned an unexpected response: {err}"))?;
    let output_text = parsed
        .choices
        .first()
        .map(|choice| choice.message.content.to_log_text())
        .unwrap_or_default();
    let input_tokens = parsed
        .usage
        .as_ref()
        .map(|usage| usage.prompt_tokens)
        .unwrap_or_else(|| token_estimate(&input_text));
    let output_tokens = parsed
        .usage
        .as_ref()
        .map(|usage| usage.completion_tokens)
        .unwrap_or_else(|| token_estimate(&output_text));
    if parsed.usage.is_none() {
        parsed.usage = Some(ChatUsage {
            prompt_tokens: input_tokens,
            completion_tokens: output_tokens,
            total_tokens: input_tokens + output_tokens,
        });
    }

    tracing::info!(
        input_tokens,
        output_tokens,
        time_ms,
        "run_chat completed (local)"
    );
    Ok(InferenceResult {
        response: parsed,
        input_text,
        output_text,
        input_tokens,
        output_tokens,
        time_ms,
    })
}

/// Convert OpenAI-style message content to the format Anthropic's Messages API expects.
/// Plain text is passed through unchanged. Multi-part content has `image_url` parts
/// (which carry `data:<mime>;base64,<data>` URLs) converted to Anthropic's `image/source`
/// shape; all other part types are forwarded as-is.
fn content_to_anthropic(content: &ChatMessageContent) -> serde_json::Value {
    match content {
        ChatMessageContent::Text(text) => serde_json::Value::String(text.clone()),
        ChatMessageContent::Parts(parts) => {
            let converted: Vec<serde_json::Value> = parts
                .iter()
                .map(|part| match part.kind.as_str() {
                    "image_url" => {
                        let url = part
                            .image_url
                            .as_ref()
                            .map(|u| u.url.as_str())
                            .unwrap_or("");
                        // data:<media_type>;base64,<data>  →  Anthropic base64 image block
                        if let Some(rest) = url.strip_prefix("data:") {
                            if let Some((mime_base, data)) = rest.split_once(',') {
                                if let Some(media_type) = mime_base.strip_suffix(";base64") {
                                    return serde_json::json!({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": media_type,
                                            "data": data
                                        }
                                    });
                                }
                            }
                        }
                        // Plain URL fallback
                        serde_json::json!({
                            "type": "image",
                            "source": { "type": "url", "url": url }
                        })
                    }
                    _ => serde_json::json!({
                        "type": "text",
                        "text": part.text.as_deref().unwrap_or("")
                    }),
                })
                .collect();
            serde_json::Value::Array(converted)
        }
    }
}

#[tracing::instrument(skip_all, fields(model = %request.model, num_messages = request.messages.len()), err)]
async fn run_anthropic_chat(
    db: &Db,
    request: ChatCompletionRequest,
) -> Result<InferenceResult, String> {
    tracing::info!("run_anthropic_chat entered");
    let api_key = db.get_settings().ok()
        .and_then(|s| s.anthropic_api_key)
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            "Anthropic API key not configured. Set it in the desktop app settings."
                .to_string()
        })?;

    // Separate system messages (Anthropic takes them as a top-level field)
    let system_prompt: Option<String> = request
        .messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.to_log_text())
        .collect::<Vec<_>>()
        .join("\n")
        .pipe_some();

    let messages: Vec<serde_json::Value> = request
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({ "role": m.role, "content": content_to_anthropic(&m.content) }))
        .collect();

    let mut body = serde_json::json!({
        "model": request.model,
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "messages": messages,
    });
    if let Some(system) = system_prompt {
        body["system"] = serde_json::Value::String(system);
    }
    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::Value::from(temp);
    }
    if let Some(top_p) = request.top_p {
        body["top_p"] = serde_json::Value::from(top_p);
    }
    if let Some(top_k) = request.top_k {
        body["top_k"] = serde_json::Value::from(top_k);
    }
    if let Some(stop) = &request.stop {
        if !stop.is_empty() {
            body["stop_sequences"] = serde_json::json!(stop);
        }
    }

    let t0 = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to reach Anthropic API: {err}"))?;

    let status = response.status();
    let body_text = response.text().await.map_err(|err| err.to_string())?;
    let time_ms = t0.elapsed().as_millis() as i64;
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(body_text);
        return Err(format!("Anthropic API error: {msg}"));
    }

    #[derive(Deserialize)]
    struct AnthropicContent {
        #[serde(rename = "type")]
        kind: String,
        text: Option<String>,
    }
    #[derive(Deserialize)]
    struct AnthropicUsage {
        input_tokens: i64,
        output_tokens: i64,
    }
    #[derive(Deserialize)]
    struct AnthropicResponse {
        id: String,
        content: Vec<AnthropicContent>,
        usage: AnthropicUsage,
    }

    let parsed: AnthropicResponse = serde_json::from_str(&body_text)
        .map_err(|err| format!("Anthropic returned unexpected response: {err}"))?;

    let output_text = parsed
        .content
        .iter()
        .find(|c| c.kind == "text")
        .and_then(|c| c.text.clone())
        .unwrap_or_default();

    let input_text = request
        .messages
        .iter()
        .map(|m| format!("{}: {}", m.role, m.content.to_log_text()))
        .collect::<Vec<_>>()
        .join("\n");

    let input_tokens = parsed.usage.input_tokens;
    let output_tokens = parsed.usage.output_tokens;

    let chat_response = ChatCompletionResponse {
        id: parsed.id,
        object: "chat.completion".into(),
        created: now_ts(),
        model: request.model,
        choices: vec![ChatChoice {
            index: 0,
            message: ChatMessage {
                role: "assistant".into(),
                content: ChatMessageContent::text(output_text.clone()),
            },
            finish_reason: Some("stop".into()),
        }],
        usage: Some(ChatUsage {
            prompt_tokens: input_tokens,
            completion_tokens: output_tokens,
            total_tokens: input_tokens + output_tokens,
        }),
    };

    tracing::info!(
        input_tokens,
        output_tokens,
        time_ms,
        "run_anthropic_chat completed"
    );
    Ok(InferenceResult {
        response: chat_response,
        input_text,
        output_text,
        input_tokens,
        output_tokens,
        time_ms,
    })
}

/// Converts a non-empty String into Some(String), empty into None.
trait PipeSome {
    fn pipe_some(self) -> Option<String>;
}
impl PipeSome for String {
    fn pipe_some(self) -> Option<String> {
        if self.is_empty() {
            None
        } else {
            Some(self)
        }
    }
}
