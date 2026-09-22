use serde::Serialize;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
use tauri::{Manager, State};

#[cfg(target_os = "windows")]
struct WorkerJob {
    handle: isize,
}

#[cfg(target_os = "windows")]
impl WorkerJob {
    fn new() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JobObjectExtendedLimitInformation,
        };

        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(format!(
                    "Unable to create Worker job object: {}",
                    std::io::Error::last_os_error()
                ));
            }

            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let configured = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                let error = std::io::Error::last_os_error();
                let _ = CloseHandle(handle);
                return Err(format!("Unable to configure Worker job object: {error}"));
            }

            Ok(Self {
                handle: handle as isize,
            })
        }
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        unsafe {
            if AssignProcessToJobObject(self.handle as HANDLE, child.as_raw_handle() as HANDLE) == 0
            {
                return Err(format!(
                    "Unable to attach Worker to its job object: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for WorkerJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

        unsafe {
            let _ = CloseHandle(self.handle as HANDLE);
        }
    }
}

struct ManagedWorker {
    child: Child,
    #[cfg(target_os = "windows")]
    _job: WorkerJob,
}

impl ManagedWorker {
    fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct WorkerProcess(Mutex<Option<ManagedWorker>>);

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        if let Ok(mut worker) = self.0.lock() {
            if let Some(worker) = worker.take() {
                worker.stop();
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

fn spawn_worker(app: &tauri::AppHandle) -> Result<ManagedWorker, String> {
    let script = worker_script(app);
    if !script.exists() {
        return Err(format!("Worker script not found: {}", script.display()));
    }

    let app_data = worker_data_dir(app)?;
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Unable to create worker data directory: {error}"))?;

    let node = worker_node(app);
    let live_enabled = std::env::var("TMALL_LIVE_ENABLED").unwrap_or_else(|_| "true".to_string());
    let live_contract =
        std::env::var("TMALL_LIVE_CONTRACT").unwrap_or_else(|_| "tmall-publish-v2".to_string());
    let mut command = Command::new(node);
    command
        .arg(script)
        .env("TMALL_DATA_DIR", &app_data)
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

    #[cfg(target_os = "windows")]
    let job = WorkerJob::new()?;

    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start Node worker: {error}"))?;

    #[cfg(target_os = "windows")]
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok(ManagedWorker {
        child,
        #[cfg(target_os = "windows")]
        _job: job,
    })
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
        Some(worker) => worker
            .child
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
    if let Some(worker) = worker.take() {
        worker.stop();
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
        .expect("error while running Tmall Operations Workbench");
}
