//! Loop guard for agent-to-agent hand-offs (docs/cw/22_Code_Bot規劃.md, P3).
//!
//! Two agents that may @ each other can ping-pong forever. The guard counts
//! agent-initiated dispatches since the user's last message in a workspace;
//! past the limit, further agent dispatches are refused until the user writes
//! again or explicitly resumes. The user can also pause agent dispatch
//! outright. Human dispatches are never blocked — they reset the count.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

/// Hand-offs allowed per user message before the guard pauses the chain.
pub const DEFAULT_AGENT_HOP_LIMIT: u32 = 6;
/// Upper bound for a user-chosen limit: past this, the guard stops being a guard.
pub const MAX_AGENT_HOP_LIMIT: u32 = 20;

pub const COLLAB_PAUSED_CODE: &str = "AGENT_COLLAB_PAUSED";
pub const COLLAB_HOP_LIMIT_CODE: &str = "AGENT_COLLAB_HOP_LIMIT";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationGuardSnapshot {
    pub workspace_id: String,
    /// Set by the user ("pause collaboration").
    pub paused: bool,
    /// Agent dispatches since the user's last message.
    pub agent_hops: u32,
    pub hop_limit: u32,
    /// True once `agent_hops` reached `hop_limit`: agent dispatch is refused
    /// until the user sends a message or resumes.
    pub hop_limit_reached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollaborationDenied {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Default)]
struct WorkspaceGuardState {
    paused: bool,
    agent_hops: u32,
    /// User-chosen limit for this workspace; None uses the guard default.
    hop_limit: Option<u32>,
}

#[derive(Debug)]
pub struct CollaborationGuard {
    hop_limit: u32,
    workspaces: Mutex<HashMap<String, WorkspaceGuardState>>,
}

impl Default for CollaborationGuard {
    fn default() -> Self {
        Self::new(DEFAULT_AGENT_HOP_LIMIT)
    }
}

impl CollaborationGuard {
    pub fn new(hop_limit: u32) -> Self {
        Self {
            hop_limit: hop_limit.max(1),
            workspaces: Mutex::new(HashMap::new()),
        }
    }

    fn with_state<T>(
        &self,
        workspace_id: &str,
        f: impl FnOnce(&mut WorkspaceGuardState) -> T,
    ) -> T {
        // A poisoned lock only means another thread panicked mid-update; the
        // counters are still usable, so recover instead of failing dispatch.
        let mut workspaces = match self.workspaces.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(workspaces.entry(workspace_id.to_string()).or_default())
    }

    fn limit_for(&self, state: &WorkspaceGuardState) -> u32 {
        state.hop_limit.unwrap_or(self.hop_limit)
    }

    fn snapshot_of(
        &self,
        workspace_id: &str,
        state: &WorkspaceGuardState,
    ) -> CollaborationGuardSnapshot {
        CollaborationGuardSnapshot {
            workspace_id: workspace_id.to_string(),
            paused: state.paused,
            agent_hops: state.agent_hops,
            hop_limit: self.limit_for(state),
            hop_limit_reached: state.agent_hops >= self.limit_for(state),
        }
    }

    pub fn snapshot(&self, workspace_id: &str) -> CollaborationGuardSnapshot {
        self.with_state(workspace_id, |state| self.snapshot_of(workspace_id, state))
    }

    /// A user message starts a fresh chain.
    pub fn record_human_dispatch(&self, workspace_id: &str) -> CollaborationGuardSnapshot {
        self.with_state(workspace_id, |state| {
            state.agent_hops = 0;
            self.snapshot_of(workspace_id, state)
        })
    }

    /// Call before an agent-initiated dispatch. On success the hop is counted.
    pub fn admit_agent_dispatch(
        &self,
        workspace_id: &str,
    ) -> Result<CollaborationGuardSnapshot, CollaborationDenied> {
        self.with_state(workspace_id, |state| {
            if state.paused {
                return Err(CollaborationDenied {
                    code: COLLAB_PAUSED_CODE,
                    message: "the user paused agent collaboration in this workspace; finish your own part and report back instead of delegating".to_string(),
                });
            }
            if state.agent_hops >= self.limit_for(state) {
                return Err(CollaborationDenied {
                    code: COLLAB_HOP_LIMIT_CODE,
                    message: format!(
                        "agents already handed work off {} times since the user's last message; stop delegating and report back to the user",
                        state.agent_hops
                    ),
                });
            }
            state.agent_hops += 1;
            Ok(self.snapshot_of(workspace_id, state))
        })
    }

    /// Sets this workspace's hand-off limit, clamped to 1..=MAX_AGENT_HOP_LIMIT.
    /// Raising it above the current count lets a stopped chain continue.
    pub fn set_hop_limit(&self, workspace_id: &str, limit: u32) -> CollaborationGuardSnapshot {
        self.with_state(workspace_id, |state| {
            state.hop_limit = Some(limit.clamp(1, MAX_AGENT_HOP_LIMIT));
            self.snapshot_of(workspace_id, state)
        })
    }

    pub fn set_paused(&self, workspace_id: &str, paused: bool) -> CollaborationGuardSnapshot {
        self.with_state(workspace_id, |state| {
            state.paused = paused;
            if !paused {
                // Resuming is an explicit "carry on", so the chain gets a full budget.
                state.agent_hops = 0;
            }
            self.snapshot_of(workspace_id, state)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_hops_up_to_the_limit_then_refuses() {
        let guard = CollaborationGuard::new(2);
        assert!(guard.admit_agent_dispatch("ws").is_ok());
        let second = guard.admit_agent_dispatch("ws").expect("second hop");
        assert!(second.hop_limit_reached);
        let denied = guard
            .admit_agent_dispatch("ws")
            .expect_err("third hop refused");
        assert_eq!(denied.code, COLLAB_HOP_LIMIT_CODE);
    }

    #[test]
    fn a_human_message_resets_the_chain() {
        let guard = CollaborationGuard::new(1);
        guard.admit_agent_dispatch("ws").expect("first hop");
        assert!(guard.admit_agent_dispatch("ws").is_err());
        guard.record_human_dispatch("ws");
        assert!(guard.admit_agent_dispatch("ws").is_ok());
    }

    #[test]
    fn pause_blocks_agents_and_resume_restores_a_full_budget() {
        let guard = CollaborationGuard::new(3);
        guard.admit_agent_dispatch("ws").expect("hop");
        guard.set_paused("ws", true);
        let denied = guard.admit_agent_dispatch("ws").expect_err("paused");
        assert_eq!(denied.code, COLLAB_PAUSED_CODE);
        let resumed = guard.set_paused("ws", false);
        assert_eq!(resumed.agent_hops, 0);
        assert!(guard.admit_agent_dispatch("ws").is_ok());
    }

    #[test]
    fn per_workspace_limit_is_clamped_and_applies_only_there() {
        let guard = CollaborationGuard::new(2);
        assert_eq!(guard.set_hop_limit("ws", 0).hop_limit, 1);
        assert_eq!(guard.set_hop_limit("ws", 99).hop_limit, MAX_AGENT_HOP_LIMIT);
        let snapshot = guard.set_hop_limit("ws", 3);
        assert_eq!(snapshot.hop_limit, 3);
        for _ in 0..3 {
            guard
                .admit_agent_dispatch("ws")
                .expect("within raised limit");
        }
        assert!(guard.admit_agent_dispatch("ws").is_err());
        assert_eq!(guard.snapshot("other").hop_limit, 2);
    }

    #[test]
    fn raising_the_limit_lets_a_stopped_chain_continue() {
        let guard = CollaborationGuard::new(1);
        guard.admit_agent_dispatch("ws").expect("first hop");
        assert!(guard.admit_agent_dispatch("ws").is_err());
        assert!(!guard.set_hop_limit("ws", 2).hop_limit_reached);
        assert!(guard.admit_agent_dispatch("ws").is_ok());
    }

    #[test]
    fn workspaces_are_independent() {
        let guard = CollaborationGuard::new(1);
        guard.admit_agent_dispatch("a").expect("a hop");
        assert!(guard.admit_agent_dispatch("a").is_err());
        assert!(guard.admit_agent_dispatch("b").is_ok());
    }
}
