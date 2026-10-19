//! Commands of the commit message generator (`crate::commit_message`): one to
//! write a message, one to stop that, and the settings pair. The web handlers
//! in `web::handlers::commit_message` call the same core functions.

use std::path::Path;

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::commit_message::{self, CommitMessageSettings, GenerateRequest, GeneratedCommitMessage};
use crate::db::AppDatabase;

pub async fn git_generate_commit_message_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: GenerateRequest,
) -> Result<GeneratedCommitMessage, AppCommandError> {
    commit_message::generate(db, manager, data_dir, request).await
}

pub fn git_generate_commit_message_cancel_core(request_id: &str) {
    commit_message::cancel(request_id);
}

pub async fn get_commit_message_settings_core(db: &AppDatabase) -> CommitMessageSettings {
    commit_message::load_settings(&db.conn).await
}

pub async fn set_commit_message_settings_core(
    db: &AppDatabase,
    settings: CommitMessageSettings,
) -> Result<CommitMessageSettings, AppCommandError> {
    commit_message::save_settings(&db.conn, &settings).await?;
    Ok(settings)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn git_generate_commit_message(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    request_id: String,
    path: String,
    folder_id: Option<i32>,
    files: Vec<String>,
    draft: Option<String>,
    fallback_agent: Option<String>,
) -> Result<GeneratedCommitMessage, AppCommandError> {
    use tauri::Manager;
    // The same data directory a session launch resolves (see `acp_connect`).
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    // A window that closes mid-generation never sends its cancel (the page is
    // gone before any cleanup of its runs), and a run has no deadline: it
    // stops with the window. The flag keeps a window closed later from
    // cancelling, and so tombstoning, a request that is long over.
    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let finished = finished.clone();
        let request_id = request_id.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && !finished.load(std::sync::atomic::Ordering::SeqCst)
            {
                git_generate_commit_message_cancel_core(&request_id);
            }
        });
    }
    let request = GenerateRequest {
        request_id,
        path,
        folder_id,
        files,
        draft,
        fallback_agent: fallback_agent
            .as_deref()
            .and_then(crate::models::agent::AgentType::from_wire),
    };
    let result = git_generate_commit_message_core(&db, &manager, &data_dir, request).await;
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_generate_commit_message_cancel(request_id: String) -> Result<(), AppCommandError> {
    git_generate_commit_message_cancel_core(&request_id);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_commit_message_settings(
    db: tauri::State<'_, AppDatabase>,
) -> Result<CommitMessageSettings, AppCommandError> {
    Ok(get_commit_message_settings_core(&db).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_commit_message_settings(
    db: tauri::State<'_, AppDatabase>,
    settings: CommitMessageSettings,
) -> Result<CommitMessageSettings, AppCommandError> {
    set_commit_message_settings_core(&db, settings).await
}
