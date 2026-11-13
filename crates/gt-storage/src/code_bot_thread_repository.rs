//! Code Bot thread persistence (docs/cw/22_Code_Bot規劃.md, P5).
//!
//! One row per workspace. The thread items are owned and validated by the
//! frontend, so they are stored as JSON arrays here; this layer only checks
//! that they are JSON arrays and caps their size.

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::{SqliteStorage, StorageError};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS code_bot_threads (
  workspace_id TEXT PRIMARY KEY,
  human_items TEXT NOT NULL,
  agent_items TEXT NOT NULL,
  cleared_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
"#;

/// Per-list cap. The frontend keeps at most 200 items per list; this is a
/// backstop against a runaway client filling the database.
pub const MAX_THREAD_JSON_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct CodeBotThreadRecord {
    pub human_items: Value,
    pub agent_items: Value,
    pub cleared_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct SqliteCodeBotThreadRepository {
    storage: SqliteStorage,
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidInput {
        message: message.into(),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn encode_list(name: &str, value: &Value) -> Result<String, StorageError> {
    if !value.is_array() {
        return Err(invalid(format!("{name} must be a JSON array")));
    }
    let encoded = value.to_string();
    if encoded.len() > MAX_THREAD_JSON_BYTES {
        return Err(invalid(format!(
            "{name} is {} bytes, over the {MAX_THREAD_JSON_BYTES} byte limit",
            encoded.len()
        )));
    }
    Ok(encoded)
}

fn decode_list(raw: &str) -> Value {
    // A corrupt row degrades to an empty list rather than failing the load.
    // The next save overwrites it, so log what was dropped.
    match serde_json::from_str::<Value>(raw) {
        Ok(value) if value.is_array() => value,
        _ => {
            tracing::warn!(bytes = raw.len(), "corrupt code bot thread list dropped");
            Value::Array(Vec::new())
        }
    }
}

impl SqliteCodeBotThreadRepository {
    pub fn new(storage: SqliteStorage) -> Self {
        Self { storage }
    }

    pub fn ensure_schema(&self) -> Result<(), StorageError> {
        self.storage.open_connection()?.execute_batch(SCHEMA)?;
        Ok(())
    }

    pub fn load(&self, workspace_id: &str) -> Result<Option<CodeBotThreadRecord>, StorageError> {
        let conn = self.storage.open_connection()?;
        let row = conn
            .query_row(
                "SELECT human_items, agent_items, cleared_at_ms, updated_at_ms \
                 FROM code_bot_threads WHERE workspace_id = ?1",
                params![workspace_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;
        Ok(
            row.map(|(human, agent, cleared, updated)| CodeBotThreadRecord {
                human_items: decode_list(&human),
                agent_items: decode_list(&agent),
                cleared_at_ms: cleared.max(0) as u64,
                updated_at_ms: updated.max(0) as u64,
            }),
        )
    }

    /// Replaces the workspace's thread. Returns the stored `updated_at_ms`.
    pub fn save(
        &self,
        workspace_id: &str,
        human_items: &Value,
        agent_items: &Value,
        cleared_at_ms: u64,
    ) -> Result<u64, StorageError> {
        if workspace_id.trim().is_empty() {
            return Err(invalid("workspace id is required"));
        }
        let human = encode_list("humanItems", human_items)?;
        let agent = encode_list("agentItems", agent_items)?;
        let updated = now_ms();
        self.storage.open_connection()?.execute(
            "INSERT INTO code_bot_threads (workspace_id, human_items, agent_items, cleared_at_ms, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(workspace_id) DO UPDATE SET human_items = excluded.human_items, \
             agent_items = excluded.agent_items, cleared_at_ms = excluded.cleared_at_ms, \
             updated_at_ms = excluded.updated_at_ms",
            params![workspace_id, human, agent, cleared_at_ms as i64, updated as i64],
        )?;
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct ScratchDb(std::path::PathBuf);

    impl ScratchDb {
        fn new(name: &str) -> Self {
            Self(std::env::temp_dir().join(format!(
                "gt-storage-code-bot-thread-{name}-{}.db",
                uuid::Uuid::new_v4()
            )))
        }

        fn repo(&self) -> SqliteCodeBotThreadRepository {
            let repo =
                SqliteCodeBotThreadRepository::new(SqliteStorage::new(&self.0).expect("storage"));
            repo.ensure_schema().expect("schema");
            repo
        }
    }

    impl Drop for ScratchDb {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
            }
        }
    }

    #[test]
    fn save_then_load_round_trips_and_replaces() {
        let scratch = ScratchDb::new("round-trip");
        let repo = scratch.repo();
        assert_eq!(repo.load("ws").expect("empty load"), None);

        repo.save("ws", &json!([{"id": "cb-1"}]), &json!([]), 0)
            .expect("first save");
        repo.save("ws", &json!([{"id": "cb-2"}]), &json!([{"id": "m1"}]), 42)
            .expect("second save");

        let record = repo.load("ws").expect("load").expect("record");
        assert_eq!(record.human_items, json!([{"id": "cb-2"}]));
        assert_eq!(record.agent_items, json!([{"id": "m1"}]));
        assert_eq!(record.cleared_at_ms, 42);
        assert!(repo.load("other").expect("other").is_none());
    }

    #[test]
    fn rejects_non_arrays_and_blank_workspace() {
        let scratch = ScratchDb::new("reject");
        let repo = scratch.repo();
        assert!(repo.save("ws", &json!({"id": 1}), &json!([]), 0).is_err());
        assert!(repo.save(" ", &json!([]), &json!([]), 0).is_err());
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let scratch = ScratchDb::new("schema");
        let repo = scratch.repo();
        repo.ensure_schema().expect("second ensure");
    }
}
