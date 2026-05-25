use crate::db::Db;
use crate::llama_bundle::resolve_llama_server;
use crate::types::{LoadedModelStatus, ModelLoadSettings, ModelRecord};
use std::collections::HashMap;
use std::net::TcpListener as StdTcpListener;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

const MAX_LOG_LINES: usize = 500;

#[derive(Clone)]
pub struct ModelRuntime {
    inner: Arc<Mutex<HashMap<String, LoadedModel>>>,
    logs: Arc<Mutex<Vec<String>>>,
}

impl Default for ModelRuntime {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            logs: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

struct LoadedModel {
    model: ModelRecord,
    runtime_name: String,
    port: u16,
    context_length: Option<u32>,
    n_threads: Option<u32>,
    load_settings: Option<ModelLoadSettings>,
    child: Child,
}

impl ModelRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn logs(&self) -> Vec<String> {
        self.logs.lock().await.clone()
    }

    pub async fn push_log(&self, line: String) {
        let mut buf = self.logs.lock().await;
        buf.push(line);
        if buf.len() > MAX_LOG_LINES {
            let excess = buf.len() - MAX_LOG_LINES;
            buf.drain(..excess);
        }
    }

    pub async fn clear_logs(&self) {
        self.logs.lock().await.clear();
    }

    pub async fn statuses(&self) -> Vec<LoadedModelStatus> {
        let mut inner = self.inner.lock().await;
        let mut statuses = Vec::with_capacity(inner.len());
        let mut exited = Vec::new();

        for (runtime_name, loaded) in inner.iter_mut() {
            match loaded.child.try_wait() {
                Ok(Some(status)) => {
                    let model_name = loaded.runtime_name.clone();
                    exited.push(runtime_name.clone());
                    statuses.push(LoadedModelStatus {
                        loaded: false,
                        model_id: None,
                        model_name: None,
                        model_type: None,
                        mmproj_path: None,
                        port: None,
                        context_length: None,
                        n_threads: None,
                        load_settings: None,
                        error: Some(format!(
                            "Loaded model process for '{model_name}' exited with {status}."
                        )),
                    });
                }
                Ok(None) => statuses.push(LoadedModelStatus {
                    loaded: true,
                    model_id: Some(loaded.model.id),
                    model_name: Some(loaded.runtime_name.clone()),
                    model_type: loaded.model.model_type.clone(),
                    mmproj_path: loaded.model.mmproj_path.clone(),
                    port: Some(loaded.port),
                    context_length: loaded.context_length,
                    n_threads: loaded.n_threads,
                    load_settings: loaded.load_settings.clone(),
                    error: None,
                }),
                Err(err) => statuses.push(LoadedModelStatus {
                    loaded: false,
                    model_id: Some(loaded.model.id),
                    model_name: Some(loaded.runtime_name.clone()),
                    model_type: loaded.model.model_type.clone(),
                    mmproj_path: loaded.model.mmproj_path.clone(),
                    port: Some(loaded.port),
                    context_length: loaded.context_length,
                    n_threads: loaded.n_threads,
                    load_settings: loaded.load_settings.clone(),
                    error: Some(err.to_string()),
                }),
            }
        }

        for runtime_name in exited {
            inner.remove(&runtime_name);
        }

        statuses
    }

    pub async fn loaded_model_ids(&self) -> Vec<i64> {
        self.statuses()
            .await
            .into_iter()
            .filter_map(|status| status.loaded.then_some(status.model_id).flatten())
            .collect()
    }

    pub async fn endpoint_for(&self, model_name: &str) -> Result<String, String> {
        let statuses = self.statuses().await;
        if statuses.iter().all(|status| !status.loaded) {
            return Err("Load a model into RAM before requesting chat completions.".into());
        }
        let status = statuses
            .into_iter()
            .find(|status| status.loaded && status.model_name.as_deref() == Some(model_name))
            .ok_or_else(|| {
                format!("Model '{model_name}' is not loaded. Load it before requesting chat completions.")
            })?;
        let port = status
            .port
            .ok_or_else(|| "Loaded model has no runtime port.".to_string())?;
        Ok(format!("http://127.0.0.1:{port}/v1/chat/completions"))
    }

    pub async fn load_model(
        &self,
        db: &Db,
        model_id: i64,
        context_length: Option<u32>,
        n_threads: Option<u32>,
        load_settings: Option<ModelLoadSettings>,
    ) -> Result<Vec<LoadedModelStatus>, String> {
        let model = db
            .get_model_by_id(model_id)?
            .ok_or_else(|| format!("Unknown model id {model_id}."))?;
        let runtime_name = self.next_runtime_name(&model.name).await;
        if model.status != "ready" {
            return Err(format!(
                "Model '{}' is not ready. Only GGUF models can be loaded.",
                model.name
            ));
        }
        if !Path::new(&model.path).is_file() {
            return Err(format!(
                "Model file '{}' is missing. Re-import a valid GGUF file before loading.",
                model.path
            ));
        }
        let settings = db.get_settings()?;
        let executable = resolve_llama_server(settings.llama_cpp_path.as_deref())?;
        let port = find_free_port()?;

        // Build the arg list separately so we can log the full command.
        let mut args: Vec<String> = vec![
            "-m".into(),
            model.path.clone(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            port.to_string(),
            "--log-disable".into(),
        ];
        if let Some(ctx) = context_length {
            args.push("--ctx-size".into());
            args.push(ctx.to_string());
        }
        if let Some(threads) = n_threads {
            args.push("--threads".into());
            args.push(threads.to_string());
        }
        if let Some(settings) = &load_settings {
            args.push("--temp".into());
            args.push(settings.temperature.to_string());
            if settings.limit_response_length {
                if let Some(max_tokens) = settings.max_tokens {
                    args.push("--n-predict".into());
                    args.push(max_tokens.to_string());
                }
            }
            if let Some(top_k) = settings.top_k {
                args.push("--top-k".into());
                args.push(top_k.to_string());
            }
            if settings.repeat_penalty_enabled {
                if let Some(repeat_penalty) = settings.repeat_penalty {
                    args.push("--repeat-penalty".into());
                    args.push(repeat_penalty.to_string());
                }
            }
            if settings.presence_penalty_enabled {
                if let Some(presence_penalty) = settings.presence_penalty {
                    args.push("--presence-penalty".into());
                    args.push(presence_penalty.to_string());
                }
            }
            if settings.top_p_enabled {
                if let Some(top_p) = settings.top_p {
                    args.push("--top-p".into());
                    args.push(top_p.to_string());
                }
            }
            if settings.min_p_enabled {
                if let Some(min_p) = settings.min_p {
                    args.push("--min-p".into());
                    args.push(min_p.to_string());
                }
            }
        }

        if let Some(mmproj) = &model.mmproj_path {
            args.push("--mmproj".into());
            args.push(mmproj.clone());
        }

        // Record the exact command line for this model load.
        {
            let cmd_line = format!(
                "[{}] $ {} {}",
                runtime_name,
                executable.display(),
                args.iter()
                    .map(|a| if a.contains(' ') {
                        format!("\"{a}\"")
                    } else {
                        a.clone()
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            tracing::info!("[{}] spawning llama-server on port {}", runtime_name, port);
            self.logs.lock().await.push(cmd_line);
        }

        let mut cmd = Command::new(&executable);
        cmd.args(&args).stdout(Stdio::null()).stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("Failed to start llama-server process: {err}"))?;

        // Drain stderr into the shared log buffer on a background task.
        if let Some(stderr) = child.stderr.take() {
            let logs = self.logs.clone();
            let model_name = runtime_name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[{}] {}", model_name, line);
                    let mut buf = logs.lock().await;
                    buf.push(format!("[{model_name}] {line}"));
                    if buf.len() > MAX_LOG_LINES {
                        let excess = buf.len() - MAX_LOG_LINES;
                        buf.drain(..excess);
                    }
                }
            });
        }

        // Poll llama-server's /health endpoint until it reports ready.
        // This is necessary because large models can take tens of seconds to
        // map into RAM; a fixed sleep would either time out too early or
        // leave the caller with a process that can't serve requests yet.
        let health_url = format!("http://127.0.0.1:{port}/health");
        let client = reqwest::Client::new();
        let start = tokio::time::Instant::now();
        let timeout = Duration::from_secs(300);
        loop {
            if start.elapsed() >= timeout {
                let _ = child.kill().await;
                return Err("llama-server did not become ready within 5 minutes. \
                     The model may be too large or the executable invalid."
                    .to_string());
            }
            match child.try_wait() {
                Ok(Some(exit)) => {
                    return Err(format!(
                        "llama-server exited with {exit}. \
                         Check the executable path and model file in Settings."
                    ))
                }
                Ok(None) => {}
                Err(err) => return Err(err.to_string()),
            }
            if let Ok(resp) = client
                .get(&health_url)
                .timeout(Duration::from_secs(2))
                .send()
                .await
            {
                if resp.status().is_success() {
                    break;
                }
            }
            sleep(Duration::from_millis(500)).await;
        }

        tracing::info!("[{}] model ready on port {}", runtime_name, port);
        let mut inner = self.inner.lock().await;
        inner.insert(
            runtime_name.clone(),
            LoadedModel {
                model,
                runtime_name,
                port,
                context_length,
                n_threads,
                load_settings,
                child,
            },
        );
        drop(inner);
        Ok(self.statuses().await)
    }

    pub async fn eject_model(
        &self,
        model_name: Option<String>,
    ) -> Result<Vec<LoadedModelStatus>, String> {
        let mut loaded = {
            let mut inner = self.inner.lock().await;
            if let Some(model_name) = model_name {
                inner.remove(&model_name).into_iter().collect::<Vec<_>>()
            } else {
                inner.drain().map(|(_, loaded)| loaded).collect::<Vec<_>>()
            }
        };
        for model in &mut loaded {
            let _ = model.child.kill().await;
            let _ = model.child.wait().await;
        }
        Ok(self.statuses().await)
    }

    pub async fn eject_model_id(&self, model_id: i64) -> Result<Vec<LoadedModelStatus>, String> {
        let mut loaded = {
            let mut inner = self.inner.lock().await;
            let matching_names = inner
                .iter()
                .filter_map(|(runtime_name, loaded)| {
                    (loaded.model.id == model_id).then(|| runtime_name.clone())
                })
                .collect::<Vec<_>>();
            matching_names
                .into_iter()
                .filter_map(|runtime_name| inner.remove(&runtime_name))
                .collect::<Vec<_>>()
        };
        for model in &mut loaded {
            let _ = model.child.kill().await;
            let _ = model.child.wait().await;
        }
        Ok(self.statuses().await)
    }

    async fn next_runtime_name(&self, base_name: &str) -> String {
        let inner = self.inner.lock().await;
        if !inner.contains_key(base_name) {
            return base_name.to_string();
        }
        for index in 2.. {
            let candidate = format!("{base_name}:{index}");
            if !inner.contains_key(&candidate) {
                return candidate;
            }
        }
        unreachable!("unbounded runtime name search should always return");
    }
}

fn find_free_port() -> Result<u16, String> {
    let listener = StdTcpListener::bind("127.0.0.1:0").map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    Ok(port)
}
