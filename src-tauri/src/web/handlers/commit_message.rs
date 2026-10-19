//! HTTP handlers of the commit message generator — the web-mode mirror of the
//! Tauri commands in `commands::commit_message`, over the same core functions.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::commit_message::{
    get_commit_message_settings_core, git_generate_commit_message_cancel_core,
    git_generate_commit_message_core, set_commit_message_settings_core,
};
use crate::commit_message::{CommitMessageSettings, GenerateRequest, GeneratedCommitMessage};

/// Held for as long as the generation runs. A client that goes away drops the
/// handler's future, and the run's agent process with it.
pub async fn git_generate_commit_message(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<GenerateRequest>,
) -> Result<Json<GeneratedCommitMessage>, AppCommandError> {
    let generated = git_generate_commit_message_core(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
    )
    .await?;
    Ok(Json(generated))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub request_id: String,
}

pub async fn git_generate_commit_message_cancel(
    Json(params): Json<CancelParams>,
) -> Result<Json<()>, AppCommandError> {
    git_generate_commit_message_cancel_core(&params.request_id);
    Ok(Json(()))
}

pub async fn get_commit_message_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CommitMessageSettings>, AppCommandError> {
    Ok(Json(get_commit_message_settings_core(&state.db).await))
}

#[derive(Deserialize)]
pub struct SetSettingsParams {
    pub settings: CommitMessageSettings,
}

pub async fn set_commit_message_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetSettingsParams>,
) -> Result<Json<CommitMessageSettings>, AppCommandError> {
    let saved = set_commit_message_settings_core(&state.db, params.settings).await?;
    Ok(Json(saved))
}
