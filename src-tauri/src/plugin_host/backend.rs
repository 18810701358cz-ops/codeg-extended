use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::broadcast;

use crate::app_error::AppCommandError;
use crate::paths::{codeg_home_dir, codeg_logs_root};
use crate::process::tokio_command;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::manifest::{
    BackendState, BackendStatus, PluginBackendConfig, PluginBackendHealthcheck, PluginManifest,
};
use super::registry::MANIFEST_FILE_NAME;
use super::runtime_resolve::{expand_env, expand_string, expand_vec, VariableContext};
use super::state::{load_state, mutate_state};
use super::{BackendStatusEvent, BACKEND_STATUS_EVENT};

pub const MAX_LOG_SIZE_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB
pub const MAX_FETCH_RESPONSE_BYTES: usize = 8 * 1024 * 1024; // 8 MiB
const FAILURE_WINDOW_SECS: u64 = 60;
const MAX_FAILURES_IN_WINDOW: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendFetchResult {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub struct BackendInstance {
    pub id: String,
    pub pid: Option<u32>,
    pub port: u16,
    pub url: String,
    pub token: String,
    pub state: BackendState,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub failure_timestamps: Vec<Instant>,
    pub stop_sender: Option<broadcast::Sender<()>>,
}

impl BackendInstance {
    pub fn to_status(&self) -> BackendStatus {
        BackendStatus {
            state: self.state,
            pid: self.pid,
            port: Some(self.port),
            url: Some(self.url.clone()),
            restarts: self.restarts,
            last_error: self.last_error.clone(),
        }
    }
}

/// Global registry of active backend instances keyed by plugin id.
static BACKENDS: LazyLock<Mutex<HashMap<String, BackendInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Active child processes keyed by plugin id.
static ACTIVE_CHILDREN: LazyLock<Mutex<HashMap<String, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Optional global event emitter reference for backend status events.
static GLOBAL_EMITTER: LazyLock<Mutex<Option<EventEmitter>>> =
    LazyLock::new(|| Mutex::new(None));

pub fn set_backend_emitter(emitter: EventEmitter) {
    if let Ok(mut lock) = GLOBAL_EMITTER.lock() {
        *lock = Some(emitter);
    }
}

pub fn emit_backend_status(id: &str, status: BackendStatus) {
    if let Ok(lock) = GLOBAL_EMITTER.lock() {
        if let Some(emitter) = lock.as_ref() {
            emit_event(
                emitter,
                BACKEND_STATUS_EVENT,
                BackendStatusEvent {
                    id: id.to_string(),
                    status,
                },
            );
        }
    }
}

/// Returns the current backend status for a plugin id.
pub fn get_backend_status(id: &str) -> BackendStatus {
    if let Ok(lock) = BACKENDS.lock() {
        if let Some(instance) = lock.get(id) {
            return instance.to_status();
        }
    }
    BackendStatus::default()
}

/// Checks if a port is available on localhost.
pub fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Allocates an ephemeral available port on localhost.
pub fn allocate_free_port() -> Result<u16, AppCommandError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| {
        AppCommandError::io_error(format!("Failed to allocate available port: {e}"))
    })?;
    let port = listener.local_addr().map_err(|e| {
        AppCommandError::io_error(format!("Failed to retrieve allocated port: {e}"))
    })?.port();
    drop(listener);
    Ok(port)
}

/// Retrieves or creates the secret backend token for a plugin in the keyring.
pub fn get_or_create_backend_token(id: &str) -> Result<String, AppCommandError> {
    let secret_name = format!("plugin:{id}:token");
    if let Ok(Some(existing)) = crate::plugin_host::secrets::get_secret(&secret_name) {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }

    let token = format!("cgt_{}", uuid::Uuid::new_v4().simple());
    crate::plugin_host::secrets::set_secret(&secret_name, &token).map_err(|e| {
        AppCommandError::io_error(format!("Failed to store backend token in keyring: {e}"))
    })?;
    Ok(token)
}

/// Path to the plugin's log file: `<data_dir>/logs/plugins/<id>.log`.
pub fn plugin_log_path(id: &str) -> PathBuf {
    codeg_logs_root().join("plugins").join(format!("{id}.log"))
}

/// Appends a message to the plugin log with rotation check.
pub fn append_to_plugin_log(id: &str, line: &str) {
    let log_path = plugin_log_path(id);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Check rotation
    if let Ok(meta) = log_path.metadata() {
        if meta.len() >= MAX_LOG_SIZE_BYTES {
            let rotated = log_path.with_extension("log.1");
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(&log_path, &rotated);
        }
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// Rotates log file if it exceeds MAX_LOG_SIZE_BYTES.
fn rotate_log_if_needed(log_path: &Path) {
    if let Ok(meta) = log_path.metadata() {
        if meta.len() >= MAX_LOG_SIZE_BYTES {
            let rotated = log_path.with_extension("log.1");
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(log_path, &rotated);
        }
    }
}

/// Reads the plugin log file, optionally tailing the last `tail_bytes`.
pub fn read_plugin_log(id: &str, tail_bytes: Option<u64>) -> Result<String, AppCommandError> {
    let log_path = plugin_log_path(id);
    if !log_path.exists() {
        return Ok(String::new());
    }

    let mut file = File::open(&log_path).map_err(|e| {
        AppCommandError::io_error(format!("Failed to open log file {}: {e}", log_path.display()))
    })?;

    let meta = file.metadata().map_err(|e| {
        AppCommandError::io_error(format!("Failed to read metadata for log file: {e}"))
    })?;
    let file_len = meta.len();

    if let Some(tail) = tail_bytes {
        if file_len > tail {
            file.seek(SeekFrom::Start(file_len - tail)).map_err(|e| {
                AppCommandError::io_error(format!("Failed to seek in log file: {e}"))
            })?;
        }
    }

    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| {
        AppCommandError::io_error(format!("Failed to read log file: {e}"))
    })?;

    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Resolves the effective port for a plugin backend.
pub async fn resolve_backend_port(
    plugins_root: &Path,
    id: &str,
    backend_cfg: &PluginBackendConfig,
) -> Result<(u16, Option<String>), AppCommandError> {
    let state = load_state(plugins_root).await;
    let state_entry = state.plugins.get(id);

    match &backend_cfg.port {
        Some(serde_json::Value::Number(num)) => {
            if let Some(preferred) = num.as_u64().map(|n| n as u16) {
                if is_port_available(preferred) {
                    Ok((preferred, None))
                } else {
                    let fallback = allocate_free_port()?;
                    let notice = format!("Port {preferred} occupied, allocated {fallback}");
                    tracing::warn!("[plugin_host] plugin '{id}': {notice}");
                    Ok((fallback, Some(notice)))
                }
            } else {
                let p = allocate_free_port()?;
                Ok((p, None))
            }
        }
        Some(serde_json::Value::String(s)) if s == "auto" => {
            if let Some(saved_port) = state_entry
                .and_then(|e| e.port.as_ref())
                .and_then(|v| v.as_u64())
                .map(|n| n as u16)
            {
                if is_port_available(saved_port) {
                    return Ok((saved_port, None));
                }
            }
            let free_port = allocate_free_port()?;
            let _ = mutate_state(plugins_root, |s| {
                if let Some(entry) = s.plugins.get_mut(id) {
                    entry.port = Some(serde_json::json!(free_port));
                }
                Ok(())
            })
            .await;
            Ok((free_port, None))
        }
        _ => {
            let free_port = allocate_free_port()?;
            Ok((free_port, None))
        }
    }
}

/// Runs the one-time `setup` command for a plugin backend version if not yet completed.
pub async fn run_backend_setup_if_needed(
    plugins_root: &Path,
    plugin_dir: &Path,
    manifest: &PluginManifest,
    backend_cfg: &PluginBackendConfig,
    ctx: &VariableContext<'_>,
) -> Result<(), AppCommandError> {
    let Some(setup) = &backend_cfg.setup else {
        return Ok(());
    };

    let state = load_state(plugins_root).await;
    if let Some(entry) = state.plugins.get(&manifest.id) {
        if entry.setup_done_for.as_deref() == Some(&manifest.version) {
            return Ok(());
        }
    }

    append_to_plugin_log(
        &manifest.id,
        &format!(
            "--- Running setup for {} v{} ---",
            manifest.id, manifest.version
        ),
    );

    let setup_cmd = expand_string(&setup.command, ctx);
    let setup_args = expand_vec(&setup.args, ctx);

    let mut command = tokio_command(&setup_cmd);
    command.current_dir(plugin_dir);
    command.args(&setup_args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to spawn setup command '{setup_cmd}': {e}");
            append_to_plugin_log(&manifest.id, &msg);
            return Err(AppCommandError::io_error(msg));
        }
    };

    let id_clone = manifest.id.clone();
    if let Some(mut stdout) = child.stdout.take() {
        let id = id_clone.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stdout.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                append_to_plugin_log(&id, &String::from_utf8_lossy(&buf[..n]));
            }
        });
    }

    if let Some(mut stderr) = child.stderr.take() {
        let id = id_clone.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                append_to_plugin_log(&id, &String::from_utf8_lossy(&buf[..n]));
            }
        });
    }

    let status = child.wait().await.map_err(|e| {
        let msg = format!("Setup execution failed: {e}");
        append_to_plugin_log(&manifest.id, &msg);
        AppCommandError::io_error(msg)
    })?;

    if !status.success() {
        let code = status.code().unwrap_or(-1);
        let msg = format!("Setup exited with non-zero exit code {code}");
        append_to_plugin_log(&manifest.id, &msg);
        return Err(AppCommandError::invalid_input(msg));
    }

    append_to_plugin_log(
        &manifest.id,
        &format!("--- Setup completed for v{} ---", manifest.version),
    );

    let _ = mutate_state(plugins_root, |s| {
        let entry = s.plugins.entry(manifest.id.clone()).or_default();
        entry.setup_done_for = Some(manifest.version.clone());
        Ok(())
    })
    .await;

    Ok(())
}

/// Starts the backend process for a plugin.
pub fn start_backend<'a>(
    plugins_root: &'a Path,
    id: &'a str,
    emitter: Option<&'a EventEmitter>,
) -> Pin<Box<dyn Future<Output = Result<BackendStatus, AppCommandError>> + Send + 'a>> {
    Box::pin(start_backend_impl(plugins_root, id, emitter))
}

async fn start_backend_impl(
    plugins_root: &Path,
    id: &str,
    emitter: Option<&EventEmitter>,
) -> Result<BackendStatus, AppCommandError> {
    if let Some(e) = emitter {
        set_backend_emitter(e.clone());
    }

    // Stop any stale child process if still active (preserve failure history for supervisor backoff)
    let child_opt = {
        let mut lock = ACTIVE_CHILDREN.lock().unwrap();
        lock.remove(id)
    };
    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    let plugin_dir = plugins_root.join(id);
    if !plugin_dir.is_dir() {
        return Err(AppCommandError::not_found(format!("Plugin '{id}' not found")));
    }

    let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
        AppCommandError::not_found(format!("Failed to read manifest for '{id}': {e}"))
    })?;
    let manifest: PluginManifest = serde_json::from_str(&raw).map_err(|e| {
        AppCommandError::invalid_input(format!("Failed to parse manifest for '{id}': {e}"))
    })?;

    let backend_cfg = manifest.backend.as_ref().ok_or_else(|| {
        AppCommandError::invalid_input(format!("Plugin '{id}' has no backend configuration"))
    })?;

    let token = get_or_create_backend_token(id)?;
    let (port, port_notice) = resolve_backend_port(plugins_root, id, backend_cfg).await?;
    let url = format!("http://127.0.0.1:{port}");

    let state = load_state(plugins_root).await;
    let config_values = state
        .plugins
        .get(id)
        .map(|e| e.config.clone())
        .unwrap_or_default();

    let data_dir = std::env::var("CODEG_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| codeg_home_dir());

    let ctx = VariableContext {
        plugin_dir: &plugin_dir,
        data_dir: &data_dir,
        port: Some(port),
        token: Some(&token),
        config: &config_values,
        plugin_id: Some(id),
    };

    // Preserve restarts and recent failure timestamps if already tracked
    let (prev_restarts, prev_failures) = {
        let lock = BACKENDS.lock().unwrap();
        if let Some(existing) = lock.get(id) {
            let now = Instant::now();
            let mut failures = existing.failure_timestamps.clone();
            failures.retain(|t| now.duration_since(*t).as_secs() < FAILURE_WINDOW_SECS);
            (existing.restarts, failures)
        } else {
            (0, Vec::new())
        }
    };

    // Update instance in starting state
    let (stop_tx, _) = broadcast::channel(1);
    let instance = BackendInstance {
        id: id.to_string(),
        pid: None,
        port,
        url: url.clone(),
        token: token.clone(),
        state: BackendState::Starting,
        restarts: prev_restarts,
        last_error: port_notice.clone(),
        failure_timestamps: prev_failures,
        stop_sender: Some(stop_tx.clone()),
    };

    {
        let mut lock = BACKENDS.lock().unwrap();
        lock.insert(id.to_string(), instance);
    }
    emit_backend_status(id, get_backend_status(id));

    // Run setup if needed
    if let Err(setup_err) = run_backend_setup_if_needed(
        plugins_root,
        &plugin_dir,
        &manifest,
        backend_cfg,
        &ctx,
    )
    .await
    {
        {
            let mut lock = BACKENDS.lock().unwrap();
            if let Some(inst) = lock.get_mut(id) {
                inst.state = BackendState::SetupFailed;
                inst.last_error = Some(setup_err.to_string());
            }
        }
        let status = get_backend_status(id);
        emit_backend_status(id, status.clone());
        return Ok(status);
    }

    // Launch backend process
    let cmd_str = expand_string(&backend_cfg.command, &ctx);
    let args = expand_vec(&backend_cfg.args, &ctx);
    let mut env = expand_env(&backend_cfg.env, &ctx);

    // Ensure CODEG_PLUGIN_TOKEN is always provided
    env.entry("CODEG_PLUGIN_TOKEN".to_string())
        .or_insert_with(|| token.clone());

    append_to_plugin_log(
        id,
        &format!("--- Starting backend on {url} (PID pending) ---"),
    );

    let mut cmd = tokio_command(&cmd_str);
    cmd.kill_on_drop(true);
    cmd.current_dir(&plugin_dir);
    cmd.args(&args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let err_msg = format!("Failed to spawn backend process '{cmd_str}': {e}");
            append_to_plugin_log(id, &err_msg);
            {
                let mut lock = BACKENDS.lock().unwrap();
                if let Some(inst) = lock.get_mut(id) {
                    inst.state = BackendState::Crashed;
                    inst.last_error = Some(err_msg.clone());
                }
            }
            let status = get_backend_status(id);
            emit_backend_status(id, status.clone());
            return Ok(status);
        }
    };

    let pid = child.id();
    {
        let mut lock = BACKENDS.lock().unwrap();
        if let Some(inst) = lock.get_mut(id) {
            inst.pid = pid;
        }
    }

    // Stream logs to file
    let log_path = plugin_log_path(id);
    if let Some(mut stdout) = child.stdout.take() {
        let p = log_path.clone();
        let id_s = id.to_string();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stdout.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                rotate_log_if_needed(&p);
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
                    let _ = f.write_all(&buf[..n]);
                }
            }
            tracing::debug!("[plugin_host] backend stdout closed for {id_s}");
        });
    }

    if let Some(mut stderr) = child.stderr.take() {
        let p = log_path.clone();
        let id_s = id.to_string();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                rotate_log_if_needed(&p);
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
                    let _ = f.write_all(&buf[..n]);
                }
            }
            tracing::debug!("[plugin_host] backend stderr closed for {id_s}");
        });
    }

    // Register active child
    {
        let mut lock = ACTIVE_CHILDREN.lock().unwrap();
        lock.insert(id.to_string(), child);
    }

    // Perform healthcheck or brief liveness check
    let health_ok = run_healthcheck(id, port, backend_cfg.healthcheck.as_ref(), &token).await;

    {
        let mut lock = BACKENDS.lock().unwrap();
        if let Some(inst) = lock.get_mut(id) {
            if health_ok {
                inst.state = BackendState::Running;
            } else {
                inst.state = BackendState::Unhealthy;
                if inst.last_error.is_none() {
                    inst.last_error = Some("Healthcheck failed or timed out".to_string());
                }
            }
        }
    }

    let status = get_backend_status(id);
    emit_backend_status(id, status.clone());

    // Spawn supervisor task to detect unexpected exits and handle backoff restarts
    let id_owned = id.to_string();
    let plugins_root_owned = plugins_root.to_path_buf();
    let stop_rx = stop_tx.subscribe();
    tokio::spawn(async move {
        supervisor_loop(plugins_root_owned, id_owned, stop_rx).await;
    });

    Ok(status)
}

/// Performs health check against `http://127.0.0.1:<port><path>`.
async fn run_healthcheck(
    id: &str,
    port: u16,
    healthcheck: Option<&PluginBackendHealthcheck>,
    token: &str,
) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let (path, timeout_ms) = match healthcheck {
        Some(h) => (h.path.clone(), h.timeout_ms.unwrap_or(20000)),
        None => ("/".to_string(), 1500),
    };

    let check_url = format!("http://127.0.0.1:{port}{path}");
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    while Instant::now() < deadline {
        // Check if child exited already
        let exited = {
            let mut lock = ACTIVE_CHILDREN.lock().unwrap();
            if let Some(child) = lock.get_mut(id) {
                child.try_wait().ok().flatten().is_some()
            } else {
                false
            }
        };
        if exited {
            tracing::warn!("[plugin_host] plugin '{id}' exited prematurely during healthcheck");
            return false;
        }

        if let Ok(resp) = client
            .get(&check_url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
        {
            if resp.status().is_success() {
                return true;
            }
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // If no explicit health check was configured, check if port is listening
    if healthcheck.is_none() {
        return !is_port_available(port);
    }

    false
}

/// Background supervisor loop that waits for child exit and handles `on-failure` backoff restart.
async fn supervisor_loop(
    plugins_root: PathBuf,
    id: String,
    mut stop_rx: broadcast::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = stop_rx.recv() => {
                // Requested to stop
                return;
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                let exit_status = {
                    let mut lock = ACTIVE_CHILDREN.lock().unwrap();
                    if let Some(child) = lock.get_mut(&id) {
                        let st = child.try_wait().ok().flatten();
                        if st.is_some() {
                            lock.remove(&id);
                        }
                        st
                    } else {
                        return;
                    }
                };

                if let Some(status) = exit_status {
                    // Child exited
                    let now = Instant::now();
                    let (should_restart, restarts, is_crashed) = {
                        let mut lock = BACKENDS.lock().unwrap();
                        let Some(inst) = lock.get_mut(&id) else { return; };
                        if inst.state == BackendState::Stopped {
                            return;
                        }

                        inst.failure_timestamps.retain(|t| now.duration_since(*t).as_secs() < FAILURE_WINDOW_SECS);
                        inst.failure_timestamps.push(now);

                        if inst.failure_timestamps.len() >= MAX_FAILURES_IN_WINDOW {
                            inst.state = BackendState::Crashed;
                            inst.last_error = Some(format!(
                                "Exited with code {:?}; failed {} times in {}s, marked as crashed",
                                status.code(),
                                inst.failure_timestamps.len(),
                                FAILURE_WINDOW_SECS
                            ));
                            (false, inst.restarts, true)
                        } else {
                            inst.restarts = inst.restarts.saturating_add(1);
                            inst.state = BackendState::Starting;
                            inst.last_error = Some(format!("Exited with code {:?}, restarting...", status.code()));
                            (true, inst.restarts, false)
                        }
                    };

                    let current_status = get_backend_status(&id);
                    emit_backend_status(&id, current_status);

                    if is_crashed || !should_restart {
                        return;
                    }

                    // Backoff sleep before restarting
                    let delay = Duration::from_millis(100 * (restarts as u64).min(10));
                    tokio::time::sleep(delay).await;

                    let root = plugins_root.clone();
                    let pid = id.clone();
                    tokio::spawn(async move {
                        let _ = start_backend(&root, &pid, None).await;
                    });
                    return;
                }
            }
        }
    }
}

/// Stops the backend process for a plugin.
pub async fn stop_backend(id: &str) {
    // Notify supervisor loop to terminate
    {
        if let Ok(lock) = BACKENDS.lock() {
            if let Some(inst) = lock.get(id) {
                if let Some(sender) = &inst.stop_sender {
                    let _ = sender.send(());
                }
            }
        }
    }

    // Kill and reap child process
    let child_opt = {
        let mut lock = ACTIVE_CHILDREN.lock().unwrap();
        lock.remove(id)
    };

    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    {
        let mut lock = BACKENDS.lock().unwrap();
        if let Some(inst) = lock.get_mut(id) {
            inst.state = BackendState::Stopped;
            inst.pid = None;
        }
    }

    emit_backend_status(id, get_backend_status(id));
}

/// Graceful shutdown hook terminating all running plugin backend processes.
pub fn stop_all() {
    tracing::info!("[plugin_host] stopping all backend processes");

    // Signal all supervisor loops
    if let Ok(lock) = BACKENDS.lock() {
        for inst in lock.values() {
            if let Some(sender) = &inst.stop_sender {
                let _ = sender.send(());
            }
        }
    }

    let mut children = {
        let mut lock = ACTIVE_CHILDREN.lock().unwrap();
        lock.drain().collect::<Vec<_>>()
    };

    for (id, mut child) in children.drain(..) {
        tracing::info!("[plugin_host] killing backend child for plugin '{id}'");
        let _ = child.start_kill();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = child.wait().await;
            });
        }
    }

    if let Ok(mut lock) = BACKENDS.lock() {
        for inst in lock.values_mut() {
            inst.state = BackendState::Stopped;
            inst.pid = None;
        }
    }
}

/// Proxies an HTTP request to the plugin's backend process.
pub async fn backend_fetch(
    id: &str,
    path: &str,
    method: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
    body: Option<&str>,
) -> Result<BackendFetchResult, AppCommandError> {
    let (url, token) = {
        let lock = BACKENDS.lock().unwrap();
        let inst = lock.get(id).ok_or_else(|| {
            AppCommandError::not_found(format!("Plugin backend for '{id}' is not running"))
        })?;
        if inst.state != BackendState::Running && inst.state != BackendState::Unhealthy {
            return Err(AppCommandError::invalid_input(format!(
                "Plugin backend for '{id}' is in state {:?}",
                inst.state
            )));
        }
        (inst.url.clone(), inst.token.clone())
    };

    let norm_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };

    let target_url = format!("{url}{norm_path}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppCommandError::io_error(e.to_string()))?;

    let req_method = match method.unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => {
            return Err(AppCommandError::invalid_input(format!(
                "Unsupported HTTP method: {other}"
            )))
        }
    };

    let mut req = client.request(req_method, &target_url);

    // Default Authorization header with plugin token
    req = req.header("Authorization", format!("Bearer {token}"));

    if let Some(custom_headers) = headers {
        for (k, v) in custom_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                req = req.header(name, val);
            }
        }
    }

    if let Some(b) = body {
        req = req.body(b.to_string());
    }

    let resp = req.send().await.map_err(|e| {
        AppCommandError::io_error(format!("Failed to send request to backend: {e}"))
    })?;

    let status = resp.status().as_u16();

    let mut resp_headers = BTreeMap::new();
    for (k, v) in resp.headers() {
        if let Ok(v_str) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), v_str.to_string());
        }
    }

    let bytes = resp.bytes().await.map_err(|e| {
        AppCommandError::io_error(format!("Failed to read response body: {e}"))
    })?;

    if bytes.len() > MAX_FETCH_RESPONSE_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "Response body exceeded limit of {} bytes (got {} bytes)",
            MAX_FETCH_RESPONSE_BYTES,
            bytes.len()
        )));
    }

    let body_str = String::from_utf8_lossy(&bytes).to_string();

    Ok(BackendFetchResult {
        status,
        headers: resp_headers,
        body: body_str,
    })
}
