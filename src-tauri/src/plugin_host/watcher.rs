use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::task::JoinHandle;

use crate::app_error::AppCommandError;
use crate::paths::codeg_plugins_root;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::manifest::is_valid_plugin_id;
use super::state;
use super::{ChangedEvent, CHANGED_EVENT};

pub const WATCHER_DEBOUNCE_MILLIS: u64 = 300;

#[derive(Debug, PartialEq, Eq)]
pub enum PathCategory {
    Ignored,
    Plugin(String),
    Global,
}

pub fn is_excluded_component(name: &str) -> bool {
    name == ".deps"
        || name == ".trash"
        || name == ".staging"
        || name == ".tmp"
        || name == ".git"
        || name == "node_modules"
        || name.starts_with(".codeg")
}

pub fn categorize_path(plugins_root: &Path, path: &Path) -> PathCategory {
    let rel_opt = if let Ok(rel) = path.strip_prefix(plugins_root) {
        Some(rel.to_path_buf())
    } else if let (Ok(canon_root), Ok(canon_path)) = (plugins_root.canonicalize(), path.canonicalize()) {
        canon_path.strip_prefix(&canon_root).ok().map(|p| p.to_path_buf())
    } else {
        None
    };

    let Some(rel) = rel_opt else {
        return PathCategory::Ignored;
    };

    let mut components = rel.components().peekable();
    match components.next() {
        None => PathCategory::Global,
        Some(std::path::Component::Normal(first)) => {
            let first_str = first.to_string_lossy();
            if is_excluded_component(&first_str) {
                return PathCategory::Ignored;
            }
            // State files directly under plugins_root
            if components.peek().is_none()
                && (first_str == "state.json"
                    || first_str == "state.json.tmp"
                    || first_str.starts_with("state.json.corrupt-"))
            {
                return PathCategory::Ignored;
            }

            if is_valid_plugin_id(&first_str) {
                // If any sub-component is excluded (e.g. plugin_dir/.deps/...), ignore
                for comp in components {
                    if let std::path::Component::Normal(c) = comp {
                        let s = c.to_string_lossy();
                        if is_excluded_component(&s) {
                            return PathCategory::Ignored;
                        }
                    }
                }
                PathCategory::Plugin(first_str.to_string())
            } else {
                PathCategory::Global
            }
        }
        _ => PathCategory::Global,
    }
}

pub async fn run_debounce_loop(
    mut rx: UnboundedReceiver<notify::Event>,
    plugins_root: PathBuf,
) {
    let debounce_duration = Duration::from_millis(WATCHER_DEBOUNCE_MILLIS);
    let sleep = tokio::time::sleep(debounce_duration);
    tokio::pin!(sleep);
    let mut timer_active = false;
    let mut affected_plugins: BTreeSet<String> = BTreeSet::new();
    let mut is_global = false;

    loop {
        tokio::select! {
            biased;

            _ = &mut sleep, if timer_active => {
                timer_active = false;
                let ids = if is_global || affected_plugins.is_empty() {
                    Vec::new()
                } else {
                    affected_plugins.iter().cloned().collect()
                };
                affected_plugins.clear();
                is_global = false;

                emit_changed(ids);
            }

            maybe_event = rx.recv() => {
                let Some(event) = maybe_event else {
                    break;
                };

                let mut has_meaningful_change = false;
                for path in event.paths {
                    match categorize_path(&plugins_root, &path) {
                        PathCategory::Ignored => {}
                        PathCategory::Plugin(id) => {
                            affected_plugins.insert(id);
                            has_meaningful_change = true;
                        }
                        PathCategory::Global => {
                            is_global = true;
                            has_meaningful_change = true;
                        }
                    }
                }

                if has_meaningful_change {
                    timer_active = true;
                    sleep.as_mut().reset(tokio::time::Instant::now() + debounce_duration);
                }
            }
        }
    }
}

struct ActiveWatcher {
    _watcher: RecommendedWatcher,
    task: JoinHandle<()>,
}

static ACTIVE_WATCHER: LazyLock<Mutex<Option<ActiveWatcher>>> =
    LazyLock::new(|| Mutex::new(None));

static GLOBAL_EMITTER: LazyLock<Mutex<Option<EventEmitter>>> =
    LazyLock::new(|| Mutex::new(None));

pub fn set_watcher_emitter(emitter: EventEmitter) {
    if let Ok(mut lock) = GLOBAL_EMITTER.lock() {
        *lock = Some(emitter);
    }
}

pub fn emit_changed(ids: Vec<String>) {
    if let Ok(lock) = GLOBAL_EMITTER.lock() {
        if let Some(emitter) = lock.as_ref() {
            emit_event(emitter, CHANGED_EVENT, ChangedEvent { ids });
        } else {
            tracing::debug!(
                "[plugin_host watcher] no emitter configured; dropped changed event for {ids:?}"
            );
        }
    }
}

pub fn is_watcher_running() -> bool {
    if let Ok(guard) = ACTIVE_WATCHER.lock() {
        guard.is_some()
    } else {
        false
    }
}

pub fn stop_watcher() {
    if let Ok(mut guard) = ACTIVE_WATCHER.lock() {
        if let Some(active) = guard.take() {
            active.task.abort();
            tracing::info!("[plugin_host watcher] developer mode watcher stopped");
        }
    }
}

pub async fn start_watcher_at(plugins_root: &Path) -> Result<(), AppCommandError> {
    let mut guard = ACTIVE_WATCHER.lock().map_err(|e| {
        AppCommandError::task_execution_failed(format!("Watcher lock poisoned: {e}"))
    })?;

    if guard.is_some() {
        return Ok(());
    }

    if !plugins_root.exists() {
        std::fs::create_dir_all(plugins_root).map_err(|e| {
            AppCommandError::io_error(format!(
                "Failed to create plugins root {}: {e}",
                plugins_root.display()
            ))
        })?;
    }

    let (tx, rx) = unbounded_channel::<notify::Event>();

    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| match res {
            Ok(event) => {
                let _ = tx.send(event);
            }
            Err(err) => {
                tracing::warn!("[plugin_host watcher] watcher error: {err}");
            }
        },
    )
    .map_err(|e| {
        AppCommandError::io_error(format!("Failed to create notify watcher: {e}"))
    })?;

    watcher
        .watch(plugins_root, RecursiveMode::Recursive)
        .map_err(|e| {
            AppCommandError::io_error(format!(
                "Failed to watch plugins directory {}: {e}",
                plugins_root.display()
            ))
        })?;

    let root_buf = plugins_root.to_path_buf();
    let task = tokio::spawn(async move {
        run_debounce_loop(rx, root_buf).await;
    });

    *guard = Some(ActiveWatcher {
        _watcher: watcher,
        task,
    });

    tracing::info!(
        "[plugin_host watcher] developer mode watcher started at {}",
        plugins_root.display()
    );

    Ok(())
}

pub async fn set_dev_mode(enabled: bool) -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    set_dev_mode_at(&plugins_root, enabled).await
}

pub async fn set_dev_mode_at(plugins_root: &Path, enabled: bool) -> Result<(), AppCommandError> {
    state::set_dev_mode(plugins_root, enabled).await?;
    if enabled {
        start_watcher_at(plugins_root).await?;
    } else {
        stop_watcher();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::tempdir;
    use crate::web::event_bridge::WebEventBroadcaster;

    // Mutex to serialize tests that touch global watcher/emitter state
    static TEST_SERIAL_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    #[test]
    fn test_categorize_path() {
        let root = Path::new("/var/plugins");

        // Direct root change
        assert_eq!(categorize_path(root, root), PathCategory::Global);

        // State files
        assert_eq!(
            categorize_path(root, &root.join("state.json")),
            PathCategory::Ignored
        );
        assert_eq!(
            categorize_path(root, &root.join("state.json.tmp")),
            PathCategory::Ignored
        );
        assert_eq!(
            categorize_path(root, &root.join("state.json.corrupt-12345")),
            PathCategory::Ignored
        );

        // Excluded top-level staging/trash/deps
        assert_eq!(
            categorize_path(root, &root.join(".staging").join("chunk.zip")),
            PathCategory::Ignored
        );
        assert_eq!(
            categorize_path(root, &root.join(".trash").join("old-plugin")),
            PathCategory::Ignored
        );
        assert_eq!(
            categorize_path(root, &root.join(".git").join("HEAD")),
            PathCategory::Ignored
        );

        // Valid plugin file
        assert_eq!(
            categorize_path(root, &root.join("my-plugin").join("dist").join("index.js")),
            PathCategory::Plugin("my-plugin".to_string())
        );
        assert_eq!(
            categorize_path(root, &root.join("workbuddy-connect").join("codeg-plugin.json")),
            PathCategory::Plugin("workbuddy-connect".to_string())
        );

        // Excluded files inside valid plugin (e.g. .deps, .git, node_modules)
        assert_eq!(
            categorize_path(
                root,
                &root.join("my-plugin").join(".deps").join("python").join("site-packages")
            ),
            PathCategory::Ignored
        );
        assert_eq!(
            categorize_path(
                root,
                &root.join("my-plugin").join("node_modules").join("foo").join("index.js")
            ),
            PathCategory::Ignored
        );

        // Invalid plugin name / unknown root files
        assert_eq!(
            categorize_path(root, &root.join("UNKNOWN_FILE.txt")),
            PathCategory::Global
        );
        assert_eq!(
            categorize_path(root, &root.join("invalid_name").join("index.js")),
            PathCategory::Global
        );

        // Path outside root
        assert_eq!(
            categorize_path(root, Path::new("/some/other/path")),
            PathCategory::Ignored
        );
    }

    #[tokio::test]
    async fn test_debounce_loop_logic() {
        let _lock = TEST_SERIAL_LOCK.lock().await;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        set_watcher_emitter(emitter);
        let mut sub = broadcaster.subscribe();

        let (tx, rx) = unbounded_channel::<notify::Event>();
        let root = PathBuf::from("/var/plugins");

        tokio::spawn(async move {
            run_debounce_loop(rx, root).await;
        });

        // Send two events for plugin-a and one for plugin-b
        let mut evt1 = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any));
        evt1.paths.push(PathBuf::from("/var/plugins/plugin-a/dist/index.js"));
        tx.send(evt1).unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;

        let mut evt2 = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any));
        evt2.paths.push(PathBuf::from("/var/plugins/plugin-b/codeg-plugin.json"));
        evt2.paths.push(PathBuf::from("/var/plugins/plugin-a/dist/style.css"));
        tx.send(evt2).unwrap();

        // Wait for debounced event (should fire within 1 second)
        let received = tokio::time::timeout(Duration::from_secs(1), sub.recv())
            .await
            .expect("Debounced event should arrive within 1 second")
            .expect("Channel receive failed");

        assert_eq!(received.channel, CHANGED_EVENT);
        let ids: Vec<String> = serde_json::from_value(received.payload["ids"].clone()).unwrap();
        assert_eq!(ids, vec!["plugin-a".to_string(), "plugin-b".to_string()]);
    }

    #[tokio::test]
    async fn test_watcher_dev_mode_state_persistence_and_fs_watch() {
        let _lock = TEST_SERIAL_LOCK.lock().await;

        let tmp = tempdir().unwrap();
        let plugins_root = tmp.path();

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        set_watcher_emitter(emitter);
        let mut sub = broadcaster.subscribe();

        // 1. Initial dev_mode is false
        let initial_state = state::load_state(plugins_root).await;
        assert!(!initial_state.dev_mode);
        assert!(!is_watcher_running());

        // 2. Enable dev_mode
        set_dev_mode_at(plugins_root, true).await.unwrap();
        let loaded = state::load_state(plugins_root).await;
        assert!(loaded.dev_mode);
        assert!(is_watcher_running());

        // Create plugin directory and write a file
        let plugin_dir = plugins_root.join("test-watch-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let file_path = plugin_dir.join("index.js");
        std::fs::write(&file_path, "console.log('hello');").unwrap();

        // Ensure file change triggers plugin-host://changed within 1-2 seconds
        let timeout_res = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(evt) = sub.recv().await {
                    if evt.channel == CHANGED_EVENT {
                        let ids: Vec<String> =
                            serde_json::from_value(evt.payload["ids"].clone()).unwrap_or_default();
                        // Either test-watch-plugin specifically or global refresh []
                        if ids.is_empty() || ids.contains(&"test-watch-plugin".to_string()) {
                            return true;
                        }
                    }
                }
            }
        })
        .await;

        assert!(
            timeout_res.is_ok(),
            "Filesystem change should trigger plugin-host://changed within timeout"
        );

        // 3. Disable dev_mode
        set_dev_mode_at(plugins_root, false).await.unwrap();
        let disabled_state = state::load_state(plugins_root).await;
        assert!(!disabled_state.dev_mode);
        assert!(!is_watcher_running());

        // 4. Test auto-start on init_at
        state::set_dev_mode(plugins_root, true).await.unwrap();
        crate::plugin_host::init_at(plugins_root).await.unwrap();
        assert!(is_watcher_running());

        // Cleanup
        set_dev_mode_at(plugins_root, false).await.unwrap();
        assert!(!is_watcher_running());
    }
}
