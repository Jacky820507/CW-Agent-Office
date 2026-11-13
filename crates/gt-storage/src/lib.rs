mod agent_repository;
mod ai_config_repository;
mod code_bot_thread_repository;
mod sqlite;

pub use code_bot_thread_repository::{
    CodeBotThreadRecord, SqliteCodeBotThreadRepository, MAX_THREAD_JSON_BYTES,
};

pub use agent_repository::SqliteAgentRepository;
pub use ai_config_repository::{
    AiConfigAuditLogInput, SavedAiProviderInput, SavedAiProviderRecord, SavedClaudeProviderInput,
    SavedClaudeProviderRecord, SqliteAiConfigRepository,
};
pub use sqlite::{SqliteStorage, StorageError};

pub fn module_name() -> &'static str {
    "gt-storage"
}
