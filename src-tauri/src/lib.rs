use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{Manager, State};

struct WorkerProcess(Mutex<Option<Child>>);

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        if let Ok(mut worker) = self.0.lock() {
            if let Some(mut child) = worker.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    worker_running: bool,
    worker_port: u16,
    app_data_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct BundledRuntimeConfig {
    inventory_api_token: String,
}

fn parse_inventory_token(raw: &str) -> Result<String, String> {
    let values: BundledRuntimeConfig = serde_json::from_str(raw)
        .map_err(|error| format!("Bundled runtime configuration is invalid: {error}"))?;
    let token = values.inventory_api_token.trim();
    if token.is_empty() {
        return Err("Bundled runtime configuration has no inventory token".to_string());
    }
    Ok(token.to_string())
}

fn bundled_inventory_token(app: &tauri::AppHandle) -> Result<String, String> {
    if let Some(path) = bundled_file(app, "runtime/default-runtime-config.json") {
        let raw = std::fs::read_to_string(path)
            .map_err(|error| format!("Unable to read bundled runtime configuration: {error}"))?;
        return parse_inventory_token(&raw);
    }
    if let Ok(token) = std::env::var("INVENTORY_API_TOKEN") {
        if !token.trim().is_empty() {
            return Ok(token);
        }
    }
    let fallback = runtime_config_file(app)?;
    let raw = std::fs::read_to_string(fallback)
        .map_err(|_| "Bundled inventory credential was not found".to_string())?;
    parse_inventory_token(&raw)
}

fn bundled_file(app: &tauri::AppHandle, relative: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join(relative));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(relative));
        if let Some(parent) = resource_dir.parent() {
            candidates.push(parent.join(relative));
        }
    }
    candidates.into_iter().find(|path| path.exists())
}

fn worker_script(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("TMALL_WORKER_SCRIPT") {
        return PathBuf::from(path);
    }

    if let Some(bundled) = bundled_file(app, "worker/server.mjs") {
        return bundled;
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("worker")
        .join("server.mjs")
}

fn worker_node(app: &tauri::AppHandle) -> String {
    if let Ok(path) = std::env::var("TMALL_NODE_PATH") {
        return path;
    }

    let bundled_name = if cfg!(target_os = "windows") {
        "runtime/node.exe"
    } else {
        "runtime/node"
    };
    if let Some(bundled) = bundled_file(app, bundled_name) {
        return bundled.display().to_string();
    }

    "node".to_string()
}

fn worker_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))
        .map(|path| path.join("worker"))
}

fn runtime_config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    worker_data_dir(app).map(|path| path.join("runtime-config.json"))
}

fn spawn_worker(app: &tauri::AppHandle) -> Result<Child, String> {
    let script = worker_script(app);
    if !script.exists() {
        return Err(format!("Worker script not found: {}", script.display()));
    }

    let app_data = worker_data_dir(app)?;
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Unable to create worker data directory: {error}"))?;
    let runtime_config = app_data.join("runtime-config.json");
    let inventory_api_token = bundled_inventory_token(app)?;

    let node = worker_node(app);
    let live_enabled = std::env::var("TMALL_LIVE_ENABLED").unwrap_or_else(|_| "true".to_string());
    let live_contract =
        std::env::var("TMALL_LIVE_CONTRACT").unwrap_or_else(|_| "tmall-publish-v2".to_string());
    let mut command = Command::new(node);
    command
        .arg(script)
        .env("TMALL_DATA_DIR", &app_data)
        .env("TMALL_RUNTIME_CONFIG", runtime_config)
        .env("INVENTORY_API_TOKEN", inventory_api_token)
        .env("TMALL_WORKER_PORT", "19828")
        .env("TMALL_LIVE_ENABLED", live_enabled)
        .env("TMALL_LIVE_CONTRACT", live_contract)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command
        .spawn()
        .map_err(|error| format!("Unable to start Node worker: {error}"))
}

#[tauri::command]
fn host_status(
    app: tauri::AppHandle,
    state: State<'_, WorkerProcess>,
) -> Result<HostStatus, String> {
    let mut worker = state
        .0
        .lock()
        .map_err(|_| "Worker lock poisoned".to_string())?;
    let worker_running = match worker.as_mut() {
        Some(child) => child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none(),
        None => false,
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(HostStatus {
        worker_running,
        worker_port: 19828,
        app_data_dir: app_data.display().to_string(),
    })
}

#[tauri::command]
fn restart_worker(app: tauri::AppHandle, state: State<'_, WorkerProcess>) -> Result<(), String> {
    let mut worker = state
        .0
        .lock()
        .map_err(|_| "Worker lock poisoned".to_string())?;
    if let Some(mut child) = worker.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *worker = Some(spawn_worker(&app)?);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let child = if std::env::var("TMALL_WORKER_DISABLED").as_deref() == Ok("true") {
                None
            } else {
                match spawn_worker(app.handle()) {
                    Ok(child) => Some(child),
                    Err(error) => {
                        eprintln!("Tmall worker failed to start: {error}");
                        None
                    }
                }
            };
            app.manage(WorkerProcess(Mutex::new(child)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![host_status, restart_worker])
        .run(tauri::generate_context!())
        .expect("error while running Tmall SKU Worker");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_inventory_token_parses_without_exposing_other_values() {
        let token =
            parse_inventory_token(r#"{"INVENTORY_API_TOKEN":"test-token","OTHER":"ignored"}"#)
                .expect("configuration should be valid");
        assert_eq!(token, "test-token");
    }

    #[test]
    fn bundled_inventory_token_is_required() {
        assert!(parse_inventory_token(r#"{"INVENTORY_API_TOKEN":""}"#).is_err());
        assert!(parse_inventory_token("{}").is_err());
    }
}
