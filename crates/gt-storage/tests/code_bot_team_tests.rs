//! `gt_agent::ensure_code_bot_team` against the real SQLite repository
//! (docs/cw/22_Code_Bot規劃.md, P1).

use std::path::PathBuf;

use gt_agent::{
    ensure_code_bot_team, AgentLinkKind, AgentLinkRepository, AgentPolicyRepository,
    AgentRepository, UpdateAgentInput, CODE_BOT_CLAUDE_AGENT_ID, CODE_BOT_CODEX_AGENT_ID,
};
use gt_storage::{SqliteAgentRepository, SqliteStorage};

struct ScratchDb {
    path: PathBuf,
}

impl ScratchDb {
    fn new(name: &str) -> Self {
        Self {
            path: std::env::temp_dir().join(format!(
                "gt-storage-code-bot-{name}-{}.db",
                uuid::Uuid::new_v4()
            )),
        }
    }

    fn repo(&self) -> SqliteAgentRepository {
        let repo =
            SqliteAgentRepository::new(SqliteStorage::new(&self.path).expect("open storage"));
        repo.ensure_schema().expect("ensure schema");
        repo
    }
}

impl Drop for ScratchDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
        }
    }
}

#[test]
fn creates_claude_and_codex_linked_both_ways() {
    let scratch = ScratchDb::new("create");
    let repo = scratch.repo();

    let team = ensure_code_bot_team(&repo, "ws-1").expect("ensure team");

    assert_eq!(team.claude.id, CODE_BOT_CLAUDE_AGENT_ID);
    assert_eq!(team.claude.tool, "claude");
    assert_eq!(team.codex.id, CODE_BOT_CODEX_AGENT_ID);
    assert_eq!(team.codex.tool, "codex");
    assert_eq!(team.claude.workdir.as_deref(), Some("."));
    assert_eq!(team.created_agent_ids.len(), 2);

    assert!(repo
        .has_authored_edge("ws-1", CODE_BOT_CLAUDE_AGENT_ID, CODE_BOT_CODEX_AGENT_ID)
        .expect("claude -> codex"));
    assert!(repo
        .has_authored_edge("ws-1", CODE_BOT_CODEX_AGENT_ID, CODE_BOT_CLAUDE_AGENT_ID)
        .expect("codex -> claude"));

    let links = repo.list_links("ws-1").expect("list links");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].kind, AgentLinkKind::Authored);
    assert!(links[0].bidirectional, "canvas should draw both arrowheads");

    for id in [CODE_BOT_CLAUDE_AGENT_ID, CODE_BOT_CODEX_AGENT_ID] {
        let policy = repo.get_agent_policy("ws-1", id).expect("policy");
        assert!(policy.agent.allow_gto_send);
    }
}

#[test]
fn calling_twice_creates_nothing_new() {
    let scratch = ScratchDb::new("idempotent");
    let repo = scratch.repo();

    ensure_code_bot_team(&repo, "ws-1").expect("first ensure");
    let second = ensure_code_bot_team(&repo, "ws-1").expect("second ensure");

    assert!(second.created_agent_ids.is_empty());
    assert_eq!(repo.list_agents("ws-1").expect("list agents").len(), 2);
    assert_eq!(repo.list_links("ws-1").expect("list links").len(), 1);
}

#[test]
fn keeps_a_renamed_agent_and_reenables_denied_sending() {
    let scratch = ScratchDb::new("repair");
    let repo = scratch.repo();
    let team = ensure_code_bot_team(&repo, "ws-1").expect("first ensure");

    repo.update_agent(UpdateAgentInput {
        workspace_id: "ws-1".to_string(),
        agent_id: team.codex.id.clone(),
        name: "Reviewer".to_string(),
        tool: team.codex.tool.clone(),
        workdir: team.codex.workdir.clone(),
        custom_workdir: team.codex.custom_workdir,
        employee_no: None,
        state: team.codex.state.clone(),
        launch_command: None,
        output_collection_enabled: false,
        session_boundary_auto_split_enabled: false,
        communicate_with_all: false,
    })
    .expect("rename codex");
    let mut policy = repo
        .get_agent_policy("ws-1", CODE_BOT_CODEX_AGENT_ID)
        .expect("policy");
    policy.agent.allow_gto_send = false;
    repo.save_agent_policy("ws-1", CODE_BOT_CODEX_AGENT_ID, &policy)
        .expect("deny sending");
    repo.delete_authored_link("ws-1", CODE_BOT_CLAUDE_AGENT_ID, CODE_BOT_CODEX_AGENT_ID)
        .expect("remove edge");

    let repaired = ensure_code_bot_team(&repo, "ws-1").expect("repair ensure");

    assert_eq!(repaired.codex.name, "Reviewer");
    assert!(repaired.created_agent_ids.is_empty());
    assert!(
        repo.get_agent_policy("ws-1", CODE_BOT_CODEX_AGENT_ID)
            .expect("policy")
            .agent
            .allow_gto_send
    );
    assert!(repo
        .has_authored_edge("ws-1", CODE_BOT_CODEX_AGENT_ID, CODE_BOT_CLAUDE_AGENT_ID)
        .expect("edge restored"));
}

#[test]
fn each_workspace_gets_its_own_team() {
    let scratch = ScratchDb::new("workspaces");
    let repo = scratch.repo();

    ensure_code_bot_team(&repo, "ws-1").expect("ws-1");
    ensure_code_bot_team(&repo, "ws-2").expect("ws-2");

    assert_eq!(repo.list_agents("ws-1").expect("ws-1 agents").len(), 2);
    assert_eq!(repo.list_agents("ws-2").expect("ws-2 agents").len(), 2);
}
