use std::path::PathBuf;
use std::process::Command as StdCommand;

pub fn resolve_llama_server(configured_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = configured_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let configured = PathBuf::from(path);
        if configured.is_file() {
            return Ok(configured);
        }
        return Err(format!(
            "Configured llama-server executable '{}' was not found. Clear the override to use the bundled server, or set a valid path.",
            configured.display()
        ));
    }

    for candidate in bundled_llama_server_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Some(extracted) = extract_bundled_llama_server()? {
        return Ok(extracted);
    }

    for candidate in system_llama_server_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("Bundled llama-server was not found. Run `npm run bundle:llama -- /path/to/llama-server` before packaging, or set a custom executable path in Settings.".into())
}

fn bundled_llama_server_candidates() -> Vec<PathBuf> {
    let executable_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let target = bundled_llama_target();
    let relative = PathBuf::from("resources")
        .join("llama")
        .join(&target)
        .join("bin")
        .join(executable_name);
    let resource_relative = PathBuf::from("llama")
        .join(&target)
        .join("bin")
        .join(executable_name);
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(&relative));
            candidates.push(exe_dir.join(&resource_relative));
            candidates.push(
                exe_dir
                    .join("..")
                    .join("Resources")
                    .join(&resource_relative),
            );
            candidates.push(exe_dir.join("..").join("Resources").join(&relative));
            candidates.push(exe_dir.join("..").join("..").join(&relative));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join(&relative));
        candidates.push(cwd.join(&relative));
    }
    candidates
}

fn bundled_llama_server_archive_candidates() -> Vec<PathBuf> {
    let target = bundled_llama_target();
    let archive_name = format!("{target}.tar.gz");
    let resource_relative = PathBuf::from("llama").join(&archive_name);
    let relative = PathBuf::from("resources").join("llama").join(&archive_name);
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(&relative));
            candidates.push(exe_dir.join(&resource_relative));
            candidates.push(
                exe_dir
                    .join("..")
                    .join("Resources")
                    .join(&resource_relative),
            );
            candidates.push(exe_dir.join("..").join("Resources").join(&relative));
            candidates.push(exe_dir.join("..").join("..").join(&relative));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join(&relative));
        candidates.push(cwd.join(&relative));
    }
    candidates
}

fn extract_bundled_llama_server() -> Result<Option<PathBuf>, String> {
    let target = bundled_llama_target();
    let executable_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let extract_root = std::env::temp_dir().join("llmeter").join("llama-runtime");
    let executable = extract_root.join(&target).join("bin").join(executable_name);
    if executable.is_file() {
        return Ok(Some(executable));
    }
    let Some(archive) = bundled_llama_server_archive_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
    else {
        return Ok(None);
    };
    std::fs::create_dir_all(&extract_root).map_err(|err| err.to_string())?;
    let output = StdCommand::new("tar")
        .args(["-xzf"])
        .arg(&archive)
        .arg("-C")
        .arg(&extract_root)
        .output()
        .map_err(|err| format!("Failed to extract bundled llama-server: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to extract bundled llama-server archive '{}': {}",
            archive.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&executable)
            .map_err(|err| err.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).map_err(|err| err.to_string())?;
    }
    if executable.is_file() {
        Ok(Some(executable))
    } else {
        Err(format!(
            "Bundled llama-server archive '{}' did not contain '{}'.",
            archive.display(),
            executable.display()
        ))
    }
}

fn bundled_llama_target() -> String {
    format!(
        "{}-{}",
        std::env::consts::OS,
        match std::env::consts::ARCH {
            "x86_64" => "x64",
            other => other,
        }
    )
}

fn system_llama_server_candidates() -> Vec<PathBuf> {
    let executable_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let mut candidates = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(executable_name));
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/llama-server"),
        PathBuf::from("/usr/local/bin/llama-server"),
        PathBuf::from("/usr/bin/llama-server"),
    ]);
    candidates
}
