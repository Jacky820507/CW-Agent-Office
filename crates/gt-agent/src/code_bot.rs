//! Code Bot collaboration team (docs/cw/22_Code_Bot規劃.md, P1): one Claude
//! agent and one Codex agent per workspace, pre-wired so they can hand work
//! to each other without the user drawing anything on agent-canvas first.

use crate::{
    AgentLinkRepository, AgentPolicyRepository, AgentProfile, AgentRepository, AgentResult,
    AgentScope, AgentState, CreateAgentInput,
};

/// Fixed ids make `ensure_code_bot_team` idempotent: the agents table key is
/// (id, workspace_id), so every workspace gets its own pair under the same ids.
pub const CODE_BOT_CLAUDE_AGENT_ID: &str = "codebot-claude";
pub const CODE_BOT_CODEX_AGENT_ID: &str = "codebot-codex";

pub fn is_code_bot_member(agent_id: &str) -> bool {
    agent_id == CODE_BOT_CLAUDE_AGENT_ID || agent_id == CODE_BOT_CODEX_AGENT_ID
}

/// Whether a dispatch belongs to Code Bot and so is subject to its loop
/// guard: a team member sends it, or it targets a team member. Other agents'
/// traffic (e.g. a pipeline drawn on agent-canvas) is never counted or paused.
pub fn is_code_bot_traffic(sender_agent_id: Option<&str>, target_agent_ids: &[String]) -> bool {
    sender_agent_id.is_some_and(is_code_bot_member)
        || target_agent_ids
            .iter()
            .any(|target| is_code_bot_member(target))
}

#[derive(Debug, Clone)]
pub struct CodeBotTeam {
    pub claude: AgentProfile,
    pub codex: AgentProfile,
    /// Ids of agents this call actually created (empty when the team existed).
    pub created_agent_ids: Vec<String>,
}

struct TeamMember {
    agent_id: &'static str,
    name: &'static str,
    tool: &'static str,
    /// Initial agent-canvas position, side by side, applied only on creation.
    layout: (f64, f64),
}

const CLAUDE_MEMBER: TeamMember = TeamMember {
    agent_id: CODE_BOT_CLAUDE_AGENT_ID,
    name: "Claude",
    tool: "claude",
    layout: (120.0, 160.0),
};

const CODEX_MEMBER: TeamMember = TeamMember {
    agent_id: CODE_BOT_CODEX_AGENT_ID,
    name: "Codex",
    tool: "codex",
    layout: (520.0, 160.0),
};

/// Creates (or reuses) the Claude + Codex pair, makes sure both may send to
/// other agents, and links them with one authored edge. Authored edges are
/// direction-agnostic for authorization (`has_authored_edge`), so one edge
/// lets either side dispatch to the other; the edge is also flagged
/// bidirectional so the canvas draws both arrowheads.
///
/// Safe to call repeatedly: existing agents, policies and the edge are kept;
/// only missing pieces are added. A user who renamed a team agent keeps the
/// new name. A user who switched an agent's policy to deny sending gets it
/// re-enabled, since a Code Bot member that cannot send defeats the team.
pub fn ensure_code_bot_team<R>(repo: &R, workspace_id: &str) -> AgentResult<CodeBotTeam>
where
    R: AgentRepository + AgentPolicyRepository + AgentLinkRepository,
{
    let mut created_agent_ids = Vec::new();
    let claude = ensure_member(repo, workspace_id, &CLAUDE_MEMBER, &mut created_agent_ids)?;
    let codex = ensure_member(repo, workspace_id, &CODEX_MEMBER, &mut created_agent_ids)?;

    for agent in [&claude, &codex] {
        let mut policy = repo.get_agent_policy(workspace_id, &agent.id)?;
        if !policy.agent.allow_gto_send {
            policy.agent.allow_gto_send = true;
            repo.save_agent_policy(workspace_id, &agent.id, &policy)?;
        }
    }

    repo.create_authored_link(workspace_id, &claude.id, &codex.id)?;
    repo.set_link_bidirectional(workspace_id, &claude.id, &codex.id, true)?;

    Ok(CodeBotTeam {
        claude,
        codex,
        created_agent_ids,
    })
}

fn ensure_member<R: AgentRepository + AgentLinkRepository>(
    repo: &R,
    workspace_id: &str,
    member: &TeamMember,
    created_agent_ids: &mut Vec<String>,
) -> AgentResult<AgentProfile> {
    if let Some(existing) = repo
        .list_agents(workspace_id)?
        .into_iter()
        .find(|agent| agent.id == member.agent_id)
    {
        return Ok(existing);
    }
    let created = repo.create_agent(CreateAgentInput {
        workspace_id: workspace_id.to_string(),
        agent_id: Some(member.agent_id.to_string()),
        name: member.name.to_string(),
        tool: member.tool.to_string(),
        // Both members code against the project itself, so they work from the
        // workspace root rather than a per-agent subfolder.
        workdir: Some(".".to_string()),
        custom_workdir: true,
        scope: AgentScope::default(),
        employee_no: None,
        state: AgentState::Ready,
        launch_command: None,
        output_collection_enabled: false,
        session_boundary_auto_split_enabled: false,
        communicate_with_all: false,
        order_index: None,
        parent_agent_id: None,
        external_template_path: None,
    });
    let agent = match created {
        Ok(agent) => agent,
        // Two concurrent setups can both see "missing"; the loser hits the
        // (id, workspace_id) key. If the agent is there now, use it.
        Err(error) => {
            tracing::warn!(
                workspace_id,
                agent_id = member.agent_id,
                %error,
                "code bot member create failed; checking whether it already exists"
            );
            return repo
                .list_agents(workspace_id)?
                .into_iter()
                .find(|agent| agent.id == member.agent_id)
                .ok_or(error);
        }
    };
    let (x, y) = member.layout;
    repo.set_agent_layout(workspace_id, &agent.id, x, y)?;
    created_agent_ids.push(agent.id.clone());
    Ok(agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn code_bot_traffic_is_anything_touching_a_member() {
        assert!(is_code_bot_traffic(
            Some(CODE_BOT_CLAUDE_AGENT_ID),
            &ids(&["other"])
        ));
        assert!(is_code_bot_traffic(
            Some("other"),
            &ids(&[CODE_BOT_CODEX_AGENT_ID])
        ));
        assert!(is_code_bot_traffic(None, &ids(&[CODE_BOT_CLAUDE_AGENT_ID])));
    }

    #[test]
    fn other_agents_traffic_is_not_code_bot() {
        assert!(!is_code_bot_traffic(
            Some("planner"),
            &ids(&["builder", "reviewer"])
        ));
        assert!(!is_code_bot_traffic(None, &ids(&["builder"])));
        assert!(!is_code_bot_traffic(Some("codebot-claudette"), &ids(&[])));
    }
}
