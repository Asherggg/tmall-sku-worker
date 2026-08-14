use serde::Serialize;
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

fn worker_script(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("TMALL_WORKER_SCRIPT") {
        return PathBuf::from(path);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("worker").join("server.mjs");
        if bundled.exists() {
            return bundled;
        }
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

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_name = if cfg!(target_os = "windows") {
            "runtime/node.exe"
        } else {
            "runtime/node"
        };
        let bundled = resource_dir.join(bundled_name);
        if bundled.exists() {
            return bundled.display().to_string();
        }
    }

    "node".to_string()
}

fn spawn_worker(app: &tauri::AppHandle) -> Result<Child, String> {
    let script = worker_script(app);
    if !script.exists() {
        return Err(format!("Worker script not found: {}", script.display()));
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?
        .join("worker");
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Unable to create worker data directory: {error}"))?;

    let node = worker_node(app);
    let mut command = Command::new(node);
    command
        .arg(script)
        .env("TMALL_DATA_DIR", app_data)
        .env("TMALL_WORKER_PORT", "19828")
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
fn host_status(app: tauri::AppHandle, state: State<'_, WorkerProcess>) -> Result<HostStatus, String> {
    let mut worker = state.0.lock().map_err(|_| "Worker lock poisoned".to_string())?;
    let worker_running = match worker.as_mut() {
        Some(child) => child.try_wait().map_err(|error| error.to_string())?.is_none(),
        None => false,
    };
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(HostStatus {
        worker_running,
        worker_port: 19828,
        app_data_dir: app_data.display().to_string(),
    })
}

#[tauri::command]
fn restart_worker(app: tauri::AppHandle, state: State<'_, WorkerProcess>) -> Result<(), String> {
    let mut worker = state.0.lock().map_err(|_| "Worker lock poisoned".to_string())?;
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
