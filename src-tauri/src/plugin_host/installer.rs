use std::collections::HashMap;
use std::io::{Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::app_error::AppCommandError;
use super::git_source::{clone_git_repo, copy_dir_all, remove_dir_all_force};
use super::manifest::{is_valid_plugin_id, PluginManifest, PluginPermission, PluginSource};
use super::registry::{scan_plugins, PluginInfo, MANIFEST_FILE_NAME};
use super::state::{load_state, mutate_state};
use super::{is_safe_mode, ChangedEvent, CHANGED_EVENT, STAGING_DIR_NAME};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB
pub const MAX_FILE_COUNT: usize = 2000;
pub const MAX_SINGLE_FILE_BYTES: u64 = 32 * 1024 * 1024; // 32 MiB
pub const STAGING_MAX_AGE_SECS: u64 = 30 * 60; // 30 minutes
const STAGING_META_FILE_NAME: &str = "staging_meta.json";

/// Per-plugin-id locks serializing concurrent `commit_install` / `uninstall` operations.
static INSTALL_LOCKS: LazyLock<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| AsyncMutex::new(HashMap::new()));

pub async fn acquire_install_lock(id: &str) -> Arc<AsyncMutex<()>> {
    let mut map = INSTALL_LOCKS.lock().await;
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallSource {
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    Path {
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreviewContributes {
    pub model_providers: usize,
    pub mcp_servers: usize,
    pub quick_messages: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreview {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub permissions: Vec<PluginPermission>,
    pub has_backend: bool,
    pub has_main: bool,
    pub contributes: PluginPreviewContributes,
    pub is_upgrade: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    pub staging_id: String,
    pub preview: PluginPreview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub updatable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingMeta {
    pub id: String,
    pub created_at_secs: u64,
    pub source: PluginSource,
}

/// Recursively validates file count and size limits on an extracted folder.
pub fn validate_extracted_directory(dir: &Path) -> Result<(), AppCommandError> {
    let mut total_bytes: u64 = 0;
    let mut file_count: usize = 0;

    for entry in walkdir::WalkDir::new(dir) {
        let entry = entry.map_err(|e| {
            AppCommandError::io_error(format!("Failed to traverse directory: {e}"))
        })?;
        if entry.file_type().is_file() {
            file_count += 1;
            if file_count > MAX_FILE_COUNT {
                return Err(AppCommandError::invalid_input(format!(
                    "Package contains too many files ({file_count} > maximum {MAX_FILE_COUNT})"
                )));
            }

            let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if len > MAX_SINGLE_FILE_BYTES {
                return Err(AppCommandError::invalid_input(format!(
                    "File '{}' exceeds single file size limit ({len} > {MAX_SINGLE_FILE_BYTES} bytes)",
                    entry.path().display()
                )));
            }

            total_bytes += len;
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(AppCommandError::invalid_input(format!(
                    "Package exceeds total size limit ({total_bytes} > {MAX_TOTAL_BYTES} bytes)"
                )));
            }
        }
    }
    Ok(())
}

/// If the extracted directory has no root `codeg-plugin.json` and contains exactly
/// one subdirectory (and no regular files), automatically descends one level into that subdirectory.
pub fn sink_single_root_level(dir: &Path) -> Result<(), AppCommandError> {
    if dir.join(MANIFEST_FILE_NAME).exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| {
        AppCommandError::io_error(format!("Failed to inspect directory {}: {e}", dir.display()))
    })?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "Thumbs.db" {
            continue;
        }
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() {
                dirs.push(entry.path());
            } else if ft.is_file() {
                files.push(entry.path());
            }
        }
    }

    if files.is_empty() && dirs.len() == 1 {
        let single_subdir = dirs.remove(0);
        let parent = dir
            .parent()
            .unwrap_or(dir)
            .join(format!("sink_tmp_{}", uuid::Uuid::new_v4().simple()));

        // Move single_subdir to temp location outside dir
        move_dir_robust(&single_subdir, &parent)?;

        // Move contents of parent back into dir
        for entry in std::fs::read_dir(&parent).map_err(|e| {
            AppCommandError::io_error(format!("Failed to read sink temp directory: {e}"))
        })? {
            let entry = entry.map_err(|e| AppCommandError::io_error(e.to_string()))?;
            let dest = dir.join(entry.file_name());
            move_entry_robust(&entry.path(), &dest)?;
        }

        let _ = remove_dir_all_force(&parent);
    }

    Ok(())
}

/// Safely extracts a zip archive with zip-slip prevention and size caps.
pub fn extract_zip_archive<R: Read + Seek>(
    reader: R,
    target_dir: &Path,
) -> Result<(), AppCommandError> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| {
        AppCommandError::invalid_input(format!("Uploaded file is not a valid zip archive: {e}"))
    })?;

    if archive.len() > MAX_FILE_COUNT {
        return Err(AppCommandError::invalid_input(format!(
            "Zip archive contains too many files ({} > maximum {MAX_FILE_COUNT})",
            archive.len()
        )));
    }

    let mut total_bytes: u64 = 0;
    std::fs::create_dir_all(target_dir).map_err(|e| {
        AppCommandError::io_error(format!(
            "Failed to create target directory {}: {e}",
            target_dir.display()
        ))
    })?;

    let canonical_target = target_dir.canonicalize().map_err(|e| {
        AppCommandError::io_error(format!(
            "Failed to canonicalize target directory {}: {e}",
            target_dir.display()
        ))
    })?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppCommandError::invalid_input(format!("Bad zip entry #{i}: {e}")))?;

        // 1. Raw name inspection for zip-slip / drive letters
        let raw_name = entry.name().replace('\\', "/");
        if raw_name.starts_with('/') || raw_name.contains("../") || raw_name.contains("/..") || raw_name == ".." {
            return Err(AppCommandError::invalid_input(format!(
                "Zip-slip detected: forbidden path component in entry '{raw_name}'"
            )));
        }
        if raw_name.len() >= 2 && raw_name.as_bytes()[1] == b':' {
            return Err(AppCommandError::invalid_input(format!(
                "Zip-slip detected: drive letter in entry '{raw_name}'"
            )));
        }

        // 2. Enclosed name verification
        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                return Err(AppCommandError::invalid_input(format!(
                    "Zip-slip detected: invalid relative path in entry '{raw_name}'"
                )));
            }
        };

        let dest_path = canonical_target.join(&enclosed);

        if entry.is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| {
                AppCommandError::io_error(format!(
                    "Failed to create directory {}: {e}",
                    dest_path.display()
                ))
            })?;
        } else {
            if let Some(parent) = dest_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        AppCommandError::io_error(format!(
                            "Failed to create parent directory {}: {e}",
                            parent.display()
                        ))
                    })?;
                }
            }

            // Declared uncompressed size check
            if entry.size() > MAX_SINGLE_FILE_BYTES {
                return Err(AppCommandError::invalid_input(format!(
                    "Zip entry '{raw_name}' declared size exceeds single file limit of {MAX_SINGLE_FILE_BYTES} bytes"
                )));
            }
            if total_bytes + entry.size() > MAX_TOTAL_BYTES {
                return Err(AppCommandError::invalid_input(format!(
                    "Zip archive exceeds total size limit of {MAX_TOTAL_BYTES} bytes"
                )));
            }

            // Stream with read limit to prevent decompression bombs with forged sizes
            let mut writer = std::fs::File::create(&dest_path).map_err(|e| {
                AppCommandError::io_error(format!(
                    "Failed to create destination file {}: {e}",
                    dest_path.display()
                ))
            })?;

            let mut limited_reader = Read::take(&mut entry, MAX_SINGLE_FILE_BYTES + 1);
            let written = std::io::copy(&mut limited_reader, &mut writer).map_err(|e| {
                AppCommandError::io_error(format!("Failed to write file {}: {e}", dest_path.display()))
            })?;

            if written > MAX_SINGLE_FILE_BYTES {
                let _ = std::fs::remove_file(&dest_path);
                return Err(AppCommandError::invalid_input(format!(
                    "Zip entry '{raw_name}' uncompressed size exceeds single file limit of {MAX_SINGLE_FILE_BYTES} bytes"
                )));
            }

            total_bytes += written;
            if total_bytes > MAX_TOTAL_BYTES {
                let _ = std::fs::remove_file(&dest_path);
                return Err(AppCommandError::invalid_input(format!(
                    "Zip archive total uncompressed size exceeds limit of {MAX_TOTAL_BYTES} bytes"
                )));
            }
        }
    }

    sink_single_root_level(target_dir)?;
    validate_extracted_directory(target_dir)?;

    Ok(())
}

/// Recursively copies directory with limits
pub fn copy_dir_with_limits(src: &Path, dst: &Path) -> Result<(), AppCommandError> {
    validate_extracted_directory(src)?;
    copy_dir_all(src, dst).map_err(|e| {
        AppCommandError::io_error(format!(
            "Failed to copy directory from {} to {}: {e}",
            src.display(),
            dst.display()
        ))
    })
}

pub fn move_entry_robust(src: &Path, dst: &Path) -> Result<(), AppCommandError> {
    if dst.exists() {
        let _ = remove_dir_all_force(dst);
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if let Ok(meta) = std::fs::symlink_metadata(src) {
        if meta.is_dir() {
            copy_dir_all(src, dst).map_err(|e| AppCommandError::io_error(e.to_string()))?;
            let _ = remove_dir_all_force(src);
        } else {
            std::fs::copy(src, dst).map_err(|e| AppCommandError::io_error(e.to_string()))?;
            let _ = std::fs::remove_file(src);
        }
        Ok(())
    } else {
        Err(AppCommandError::io_error(format!(
            "Source entry {} not found",
            src.display()
        )))
    }
}

pub fn move_dir_robust(src: &Path, dst: &Path) -> Result<(), AppCommandError> {
    if dst.exists() {
        let _ = remove_dir_all_force(dst);
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_dir_all(src, dst).map_err(|e| {
        AppCommandError::io_error(format!(
            "Failed to copy directory from {} to {}: {e}",
            src.display(),
            dst.display()
        ))
    })?;
    let _ = remove_dir_all_force(src);
    Ok(())
}

pub fn spawn_background_delete(trash_dir: PathBuf) {
    tokio::spawn(async move {
        let mut retries = 5;
        let mut delay = Duration::from_millis(100);
        while retries > 0 {
            tokio::time::sleep(delay).await;
            if remove_dir_all_force(&trash_dir).is_ok() || !trash_dir.exists() {
                return;
            }
            retries -= 1;
            delay *= 2;
        }
        tracing::warn!(
            "[plugin_host] failed to delete trash directory after retries: {}",
            trash_dir.display()
        );
    });
}

/// Stage a plugin from an InstallSource (Git or local Path).
pub async fn stage_source(
    plugins_root: &Path,
    source: InstallSource,
    allow_file: bool,
) -> Result<StageResult, AppCommandError> {
    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging_base = plugins_root.join(STAGING_DIR_NAME).join(&staging_id);
    std::fs::create_dir_all(&staging_base).map_err(|e| {
        AppCommandError::io_error(format!("Failed to create staging directory: {e}"))
    })?;

    let work_dir = staging_base.join("work");
    std::fs::create_dir_all(&work_dir).map_err(|e| {
        AppCommandError::io_error(format!("Failed to create staging work directory: {e}"))
    })?;

    let plugin_source = match source {
        InstallSource::Git { url, r#ref, subdir } => {
            let commit = clone_git_repo(&url, r#ref.as_deref(), subdir.as_deref(), &work_dir, allow_file).await?;
            sink_single_root_level(&work_dir)?;
            validate_extracted_directory(&work_dir)?;
            PluginSource::Git {
                url,
                r#ref,
                subdir,
                commit: Some(commit),
            }
        }
        InstallSource::Path { path } => {
            let src_path = PathBuf::from(&path);
            if !src_path.exists() {
                let _ = remove_dir_all_force(&staging_base);
                return Err(AppCommandError::not_found(format!(
                    "Path '{path}' does not exist"
                )));
            }

            if src_path.is_file() {
                let file = std::fs::File::open(&src_path).map_err(|e| {
                    AppCommandError::io_error(format!("Failed to open file '{path}': {e}"))
                })?;
                extract_zip_archive(file, &work_dir)?;
                let file_name = src_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
                PluginSource::Upload { file_name }
            } else if src_path.is_dir() {
                copy_dir_with_limits(&src_path, &work_dir)?;
                sink_single_root_level(&work_dir)?;
                validate_extracted_directory(&work_dir)?;
                PluginSource::Manual
            } else {
                let _ = remove_dir_all_force(&staging_base);
                return Err(AppCommandError::invalid_input(format!(
                    "Path '{path}' is neither a file nor a directory"
                )));
            }
        }
    };

    build_stage_result_from_work_dir(plugins_root, &staging_base, &work_dir, staging_id, plugin_source).await
}

/// Stage a plugin directly from raw zip bytes (used by Web stage_upload).
pub async fn stage_zip_bytes(
    plugins_root: &Path,
    bytes: &[u8],
    file_name: Option<&str>,
) -> Result<StageResult, AppCommandError> {
    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging_base = plugins_root.join(STAGING_DIR_NAME).join(&staging_id);
    std::fs::create_dir_all(&staging_base).map_err(|e| {
        AppCommandError::io_error(format!("Failed to create staging directory: {e}"))
    })?;

    let work_dir = staging_base.join("work");
    std::fs::create_dir_all(&work_dir).map_err(|e| {
        AppCommandError::io_error(format!("Failed to create staging work directory: {e}"))
    })?;

    let cursor = Cursor::new(bytes);
    extract_zip_archive(cursor, &work_dir)?;

    let plugin_source = PluginSource::Upload {
        file_name: file_name.map(|s| s.to_string()),
    };

    build_stage_result_from_work_dir(plugins_root, &staging_base, &work_dir, staging_id, plugin_source).await
}

async fn build_stage_result_from_work_dir(
    plugins_root: &Path,
    staging_base: &Path,
    work_dir: &Path,
    staging_id: String,
    plugin_source: PluginSource,
) -> Result<StageResult, AppCommandError> {
    let manifest_path = work_dir.join(MANIFEST_FILE_NAME);
    if !manifest_path.exists() {
        let _ = remove_dir_all_force(staging_base);
        return Err(AppCommandError::invalid_input(format!(
            "Missing manifest file '{MANIFEST_FILE_NAME}' in plugin package"
        )));
    }

    let raw_manifest = std::fs::read_to_string(&manifest_path).map_err(|e| {
        let _ = remove_dir_all_force(staging_base);
        AppCommandError::io_error(format!("Failed to read '{MANIFEST_FILE_NAME}': {e}"))
    })?;

    let manifest: PluginManifest = serde_json::from_str(&raw_manifest).map_err(|e| {
        let _ = remove_dir_all_force(staging_base);
        AppCommandError::invalid_input(format!("Invalid '{MANIFEST_FILE_NAME}' JSON: {e}"))
    })?;

    if !is_valid_plugin_id(&manifest.id) {
        let _ = remove_dir_all_force(staging_base);
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{}'",
            manifest.id
        )));
    }

    let staged_plugin_dir = staging_base.join(&manifest.id);
    if staged_plugin_dir.exists() {
        let _ = remove_dir_all_force(&staged_plugin_dir);
    }
    move_dir_robust(work_dir, &staged_plugin_dir)?;

    // Record staging metadata
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let meta = StagingMeta {
        id: manifest.id.clone(),
        created_at_secs: now_secs,
        source: plugin_source,
    };
    let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(|e| {
        AppCommandError::io_error(format!("Failed to serialize staging metadata: {e}"))
    })?;
    std::fs::write(staging_base.join(STAGING_META_FILE_NAME), meta_bytes).map_err(|e| {
        AppCommandError::io_error(format!("Failed to write staging metadata: {e}"))
    })?;

    // Validate manifest against the staged plugin directory
    let mut problems = Vec::new();
    if let Err(failures) = super::manifest::validate_manifest(&manifest, &staged_plugin_dir) {
        for f in failures {
            match f {
                super::manifest::ValidationFailureReason::Invalid(m) => problems.push(m),
                super::manifest::ValidationFailureReason::Incompatible(m) => problems.push(m),
            }
        }
    }

    let installed_dir = plugins_root.join(&manifest.id);
    let is_upgrade = installed_dir.exists();
    let installed_version = if is_upgrade {
        let old_manifest_path = installed_dir.join(MANIFEST_FILE_NAME);
        if old_manifest_path.exists() {
            std::fs::read_to_string(&old_manifest_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<PluginManifest>(&raw).ok())
                .map(|m| m.version)
        } else {
            None
        }
    } else {
        None
    };

    let model_providers_cnt = manifest
        .contributes
        .as_ref()
        .and_then(|c| c.model_providers.as_ref())
        .map(|v| v.len())
        .unwrap_or(0);

    let mcp_servers_cnt = manifest
        .contributes
        .as_ref()
        .and_then(|c| c.mcp_servers.as_ref())
        .map(|v| {
            if let Some(obj) = v.as_object() {
                obj.len()
            } else if let Some(arr) = v.as_array() {
                arr.len()
            } else {
                0
            }
        })
        .unwrap_or(0);

    let quick_messages_cnt = manifest
        .contributes
        .as_ref()
        .and_then(|c| c.quick_messages.as_ref())
        .map(|v| v.len())
        .unwrap_or(0);

    let preview = PluginPreview {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        permissions: manifest.permissions,
        has_backend: manifest.backend.is_some(),
        has_main: manifest.main.is_some(),
        contributes: PluginPreviewContributes {
            model_providers: model_providers_cnt,
            mcp_servers: mcp_servers_cnt,
            quick_messages: quick_messages_cnt,
        },
        is_upgrade,
        installed_version,
        problems,
    };

    Ok(StageResult {
        staging_id,
        preview,
    })
}

/// Commits an installation from a staged directory. Handles per-id locking,
/// upgrade backup to .trash, rollback upon failure, and state update.
pub async fn commit_install(
    plugins_root: &Path,
    staging_id: &str,
    emitter: &EventEmitter,
) -> Result<PluginInfo, AppCommandError> {
    let staging_base = plugins_root.join(STAGING_DIR_NAME).join(staging_id);
    if !staging_base.exists() {
        return Err(AppCommandError::not_found(format!(
            "Staging session '{staging_id}' not found"
        )));
    }

    let meta_path = staging_base.join(STAGING_META_FILE_NAME);
    if !meta_path.exists() {
        return Err(AppCommandError::not_found(format!(
            "Staging metadata for '{staging_id}' not found"
        )));
    }

    let meta_content = std::fs::read_to_string(&meta_path).map_err(|e| {
        AppCommandError::io_error(format!("Failed to read staging metadata: {e}"))
    })?;

    let meta: StagingMeta = serde_json::from_str(&meta_content).map_err(|e| {
        AppCommandError::invalid_input(format!("Invalid staging metadata: {e}"))
    })?;

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if now_secs.saturating_sub(meta.created_at_secs) > STAGING_MAX_AGE_SECS {
        let _ = remove_dir_all_force(&staging_base);
        return Err(AppCommandError::invalid_input(
            "Staging session has expired (exceeded 30 minutes). Please retry installation.",
        ));
    }

    let lock = acquire_install_lock(&meta.id).await;
    let _guard = lock.lock().await;

    let staged_plugin_dir = staging_base.join(&meta.id);
    if !staged_plugin_dir.exists() {
        return Err(AppCommandError::not_found(format!(
            "Staged plugin directory for '{}' not found",
            meta.id
        )));
    }

    // Re-validate manifest in staged directory
    let manifest_path = staged_plugin_dir.join(MANIFEST_FILE_NAME);
    let raw_manifest = std::fs::read_to_string(&manifest_path).map_err(|e| {
        AppCommandError::io_error(format!("Failed to read staged manifest: {e}"))
    })?;
    let manifest: PluginManifest = serde_json::from_str(&raw_manifest).map_err(|e| {
        AppCommandError::invalid_input(format!("Failed to parse staged manifest: {e}"))
    })?;

    if let Err(failures) = super::manifest::validate_manifest(&manifest, &staged_plugin_dir) {
        let msgs: Vec<String> = failures
            .into_iter()
            .map(|f| match f {
                super::manifest::ValidationFailureReason::Invalid(m) => m,
                super::manifest::ValidationFailureReason::Incompatible(m) => m,
            })
            .collect();
        return Err(AppCommandError::invalid_input(format!(
            "Plugin validation failed: {}",
            msgs.join("; ")
        )));
    }

    let target_dir = plugins_root.join(&meta.id);
    let is_upgrade = target_dir.exists();

    if is_upgrade {
        // Upgrade flow: stop backend, move old to .trash, move new in place, rollback if error
        super::on_disabled_at(plugins_root, &meta.id).await?;

        let trash_root = plugins_root.join(".trash");
        std::fs::create_dir_all(&trash_root).map_err(|e| {
            AppCommandError::io_error(format!("Failed to create .trash directory: {e}"))
        })?;

        let trash_id = format!("{}-{}", meta.id, uuid::Uuid::new_v4().simple());
        let trash_dir = trash_root.join(trash_id);

        move_dir_robust(&target_dir, &trash_dir)?;

        if let Err(err) = move_dir_robust(&staged_plugin_dir, &target_dir) {
            // Rollback
            let _ = move_dir_robust(&trash_dir, &target_dir);
            return Err(AppCommandError::io_error(format!(
                "Failed to install upgraded plugin files (rolled back to previous version): {err}"
            )));
        }

        spawn_background_delete(trash_dir);
        let _ = remove_dir_all_force(&staging_base);

        mutate_state(plugins_root, |state| {
            let entry = state.plugins.entry(meta.id.clone()).or_default();
            entry.source = meta.source.clone();
            entry.installed_version = Some(manifest.version.clone());
            Ok(())
        })
        .await?;

        emit_event(
            emitter,
            CHANGED_EVENT,
            ChangedEvent {
                ids: vec![meta.id.clone()],
            },
        );
    } else {
        // Fresh install flow
        move_dir_robust(&staged_plugin_dir, &target_dir)?;
        let _ = remove_dir_all_force(&staging_base);

        mutate_state(plugins_root, |state| {
            let entry = state.plugins.entry(meta.id.clone()).or_default();
            entry.enabled = true;
            entry.source = meta.source.clone();
            entry.installed_version = Some(manifest.version.clone());
            Ok(())
        })
        .await?;

        emit_event(
            emitter,
            CHANGED_EVENT,
            ChangedEvent {
                ids: vec![meta.id.clone()],
            },
        );

        super::on_enabled_at(plugins_root, &meta.id).await?;
    }

    let state = load_state(plugins_root).await;
    let safe_mode = is_safe_mode();
    let plugins = scan_plugins(plugins_root, &state, safe_mode);
    plugins
        .into_iter()
        .find(|p| p.id == meta.id)
        .ok_or_else(|| AppCommandError::not_found(format!("Plugin '{}' not found after install", meta.id)))
}

/// Discards a staging directory.
pub fn discard_staging(plugins_root: &Path, staging_id: &str) -> Result<(), AppCommandError> {
    let staging_base = plugins_root.join(STAGING_DIR_NAME).join(staging_id);
    if staging_base.exists() {
        let _ = remove_dir_all_force(&staging_base);
    }
    Ok(())
}

/// Checks for updates on a git-sourced plugin. If an update is available, returns updatable: true
/// along with the stagingId ready for `commit_install`.
pub async fn check_update(
    plugins_root: &Path,
    id: &str,
) -> Result<UpdateCheckResult, AppCommandError> {
    check_update_internal(plugins_root, id, false).await
}

pub async fn check_update_internal(
    plugins_root: &Path,
    id: &str,
    allow_file: bool,
) -> Result<UpdateCheckResult, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!("Invalid plugin id '{id}'")));
    }

    let state = load_state(plugins_root).await;
    let entry = state.plugins.get(id).ok_or_else(|| {
        AppCommandError::not_found(format!("Plugin '{id}' not found in state"))
    })?;

    let (url, r#ref, subdir) = match &entry.source {
        PluginSource::Git { url, r#ref, subdir, .. } => (url.clone(), r#ref.clone(), subdir.clone()),
        _ => {
            return Err(AppCommandError::invalid_input(format!(
                "Plugin '{id}' was not installed from a git repository"
            )));
        }
    };

    let plugin_dir = plugins_root.join(id);
    let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
    let current_version = if manifest_path.exists() {
        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
            AppCommandError::io_error(format!("Failed to read manifest for '{id}': {e}"))
        })?;
        let m: PluginManifest = serde_json::from_str(&raw).map_err(|e| {
            AppCommandError::invalid_input(format!("Failed to parse manifest for '{id}': {e}"))
        })?;
        m.version
    } else {
        return Err(AppCommandError::not_found(format!(
            "Plugin '{id}' manifest not found"
        )));
    };

    let stage_res = stage_source(
        plugins_root,
        InstallSource::Git {
            url,
            r#ref,
            subdir,
        },
        allow_file,
    )
    .await?;

    let latest_version = stage_res.preview.version.clone();
    let meta_path = plugins_root
        .join(STAGING_DIR_NAME)
        .join(&stage_res.staging_id)
        .join(STAGING_META_FILE_NAME);

    let latest_commit = if let Ok(meta_bytes) = std::fs::read(&meta_path) {
        if let Ok(meta) = serde_json::from_slice::<StagingMeta>(&meta_bytes) {
            if let PluginSource::Git { commit, .. } = meta.source {
                commit
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let cur_sem = semver::Version::parse(&current_version).ok();
    let lat_sem = semver::Version::parse(&latest_version).ok();

    let updatable = match (cur_sem, lat_sem) {
        (Some(c), Some(l)) => l > c,
        _ => latest_version != current_version,
    };

    if updatable {
        Ok(UpdateCheckResult {
            current: current_version,
            latest: Some(latest_version),
            commit: latest_commit,
            updatable: true,
            staging_id: Some(stage_res.staging_id),
        })
    } else {
        let _ = discard_staging(plugins_root, &stage_res.staging_id);
        Ok(UpdateCheckResult {
            current: current_version,
            latest: Some(latest_version),
            commit: latest_commit,
            updatable: false,
            staging_id: None,
        })
    }
}

/// Uninstalls a plugin: invokes on_uninstall, moves files to .trash, deletes secrets, and removes state.
pub async fn uninstall(
    plugins_root: &Path,
    id: &str,
    remove_contributions: bool,
    emitter: &EventEmitter,
) -> Result<(), AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!("Invalid plugin id '{id}'")));
    }

    let lock = acquire_install_lock(id).await;
    let _guard = lock.lock().await;

    super::on_uninstall_at(plugins_root, id, remove_contributions).await?;

    let plugin_dir = plugins_root.join(id);
    let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
    let config_schema = if manifest_path.exists() {
        std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PluginManifest>(&raw).ok())
            .and_then(|m| m.config_schema)
    } else {
        None
    };

    if plugin_dir.exists() {
        let trash_root = plugins_root.join(".trash");
        std::fs::create_dir_all(&trash_root).map_err(|e| {
            AppCommandError::io_error(format!("Failed to create .trash directory: {e}"))
        })?;

        let trash_id = format!("{id}-{}", uuid::Uuid::new_v4().simple());
        let trash_dir = trash_root.join(trash_id);
        move_dir_robust(&plugin_dir, &trash_dir)?;
        spawn_background_delete(trash_dir);
    }

    // Clean up backend token secret
    let _ = crate::keyring_store::delete_secret(&format!("plugin:{id}:token"));

    // Clean up config secrets
    if let Some(schema) = config_schema {
        for (prop_key, prop) in schema.properties {
            if prop.format.as_deref() == Some("secret") {
                let _ = crate::keyring_store::delete_secret(&format!("plugin:{id}:{prop_key}"));
            }
        }
    }

    // Also check state config to clean up any secrets
    let state = load_state(plugins_root).await;
    if let Some(entry) = state.plugins.get(id) {
        for key in entry.config.keys() {
            let _ = crate::keyring_store::delete_secret(&format!("plugin:{id}:{key}"));
        }
    }

    // Remove state record
    mutate_state(plugins_root, |state| {
        state.plugins.remove(id);
        Ok(())
    })
    .await?;

    emit_event(
        emitter,
        CHANGED_EVENT,
        ChangedEvent {
            ids: vec![id.to_string()],
        },
    );

    Ok(())
}
