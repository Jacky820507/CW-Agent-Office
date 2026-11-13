//! Code Bot entry points (docs/cw/22_Code_Bot規劃.md). Command bodies only
//! bind arguments; the team logic lives in `gt_agent::ensure_code_bot_team`.

use std::sync::atomic::{AtomicBool, Ordering};

use gt_agent::AgentRepository;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use super::agent::{ensure_workspace_exists, resolve_agent_repository, to_command_error};
use crate::app_state::AppState;

/// Creates (or repairs) the workspace's Claude + Codex pair and the authored
/// edge between them. Idempotent, so the UI can call it on every "set up
/// team" click without checking first.
#[tauri::command]
pub fn code_bot_ensure_team(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_workspace_exists(&state, &workspace_id)?;
    let repo = resolve_agent_repository(&app)?;
    repo.ensure_schema().map_err(to_command_error)?;
    let team = gt_agent::ensure_code_bot_team(&repo, &workspace_id).map_err(to_command_error)?;
    tracing::info!(
        workspace_id = %workspace_id,
        created = team.created_agent_ids.len(),
        "code bot team ensured"
    );
    if !team.created_agent_ids.is_empty() {
        // New agents must show up in the gto directory right away, or the
        // first `gto agent send-task` between them fails as an unknown target.
        let _ = crate::local_bridge::refresh_directory_snapshot(&app, state.inner(), &workspace_id);
    }
    Ok(json!({
        "claudeAgentId": team.claude.id,
        "codexAgentId": team.codex.id,
        "createdAgentIds": team.created_agent_ids,
    }))
}

fn resolve_thread_repository(
    app: &AppHandle,
) -> Result<gt_storage::SqliteCodeBotThreadRepository, String> {
    // Same database file as the agent repository (`resolve_agent_repository`).
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("CODE_BOT_STORAGE_PATH_FAILED: {error}"))?;
    let storage =
        gt_storage::SqliteStorage::new(base_dir.join("gtoffice.db")).map_err(to_command_error)?;
    Ok(gt_storage::SqliteCodeBotThreadRepository::new(storage))
}

/// Set once the `code_bot_threads` table is known to exist, so routine
/// loads/saves don't re-run `CREATE TABLE IF NOT EXISTS` each time. A failed
/// attempt leaves it unset and the next call retries.
static THREAD_SCHEMA_READY: AtomicBool = AtomicBool::new(false);

fn ensure_thread_schema(repo: &gt_storage::SqliteCodeBotThreadRepository) -> Result<(), String> {
    if THREAD_SCHEMA_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    repo.ensure_schema().map_err(to_command_error)?;
    THREAD_SCHEMA_READY.store(true, Ordering::Release);
    Ok(())
}

/// Saved Code Bot thread for the workspace (P5), or nulls when none exists.
/// Async + `spawn_blocking`: the thread JSON can be large and SQLite may wait
/// on a lock, neither of which should block the UI thread.
#[tauri::command]
pub async fn code_bot_thread_load(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_workspace_exists(&state, &workspace_id)?;
    let repo = resolve_thread_repository(&app)?;
    let record = tauri::async_runtime::spawn_blocking(move || {
        ensure_thread_schema(&repo)?;
        repo.load(&workspace_id).map_err(to_command_error)
    })
    .await
    .map_err(to_command_error)??;
    Ok(match record {
        Some(record) => json!({
            "humanItems": record.human_items,
            "agentItems": record.agent_items,
            "clearedAtMs": record.cleared_at_ms,
            "updatedAtMs": record.updated_at_ms,
        }),
        None => json!({
            "humanItems": null,
            "agentItems": null,
            "clearedAtMs": 0,
            "updatedAtMs": 0,
        }),
    })
}

/// Replaces the workspace's saved Code Bot thread (P5).
#[tauri::command]
pub async fn code_bot_thread_save(
    workspace_id: String,
    human_items: Value,
    agent_items: Value,
    cleared_at_ms: u64,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_workspace_exists(&state, &workspace_id)?;
    let repo = resolve_thread_repository(&app)?;
    let updated_at_ms = tauri::async_runtime::spawn_blocking(move || {
        ensure_thread_schema(&repo)?;
        repo.save(&workspace_id, &human_items, &agent_items, cleared_at_ms)
            .map_err(to_command_error)
    })
    .await
    .map_err(to_command_error)??;
    Ok(json!({ "updatedAtMs": updated_at_ms }))
}

/// Sets the workspace's agent hand-off limit (clamped to 1..=20 by the guard).
/// In-memory like the rest of the guard; the frontend re-applies the user's
/// saved choice after a restart.
#[tauri::command]
pub fn code_bot_set_hop_limit(
    workspace_id: String,
    limit: u32,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_workspace_exists(&state, &workspace_id)?;
    let snapshot = state
        .collaboration_guard
        .set_hop_limit(&workspace_id, limit);
    tracing::info!(workspace_id = %workspace_id, limit = snapshot.hop_limit, "code bot hop limit set");
    let _ = app.emit("code_bot/collaboration_guard", &snapshot);
    serde_json::to_value(snapshot).map_err(to_command_error)
}

/// Current loop-guard state for the workspace (P3): paused flag and how many
/// agent hand-offs happened since the user's last message.
#[tauri::command]
pub fn code_bot_collaboration_state(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    ensure_workspace_exists(&state, &workspace_id)?;
    let snapshot = state.collaboration_guard.snapshot(&workspace_id);
    serde_json::to_value(snapshot).map_err(to_command_error)
}

/// Pauses or resumes agent-to-agent hand-offs. Resuming also resets the hop
/// count, so "continue" after hitting the limit gives a full budget.
#[tauri::command]
pub fn code_bot_set_collaboration_paused(
    workspace_id: String,
    paused: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_workspace_exists(&state, &workspace_id)?;
    let snapshot = state.collaboration_guard.set_paused(&workspace_id, paused);
    tracing::info!(workspace_id = %workspace_id, paused, "code bot collaboration toggled");
    let _ = app.emit("code_bot/collaboration_guard", &snapshot);
    serde_json::to_value(snapshot).map_err(to_command_error)
}
