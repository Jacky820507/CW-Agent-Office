---
name: gto-agent-communication
description: Use when a GT Office agent must send work to another agent, reply on an existing task thread, wait for a task reply, or inspect inbox and thread state through the local gto CLI.
---

# GT Office Agent CLI Communication

Use `gto` as the default communication interface for GT Office agent collaboration. If `gto` is not on `PATH`, run `node tools/gto/bin/gto.mjs` from the GT Office repository instead.

## Quick Rules

- Prefer `gto send <from> <to> <text>` for normal one-shot task dispatch.
- Use `gto send ... --wait` when the sender explicitly needs the next reply in the same task thread.
- Use `gto wait <taskId> --from <agent>` when you already have a task id and only need to wait for the next reply.
- Use `gto inbox <agent>` to inspect open task threads for one agent.
- Use `gto thread <taskId>` to inspect the full conversation history for one task.
- Use `gto agent send-task`, `gto agent reply-status`, or `gto agent handover` only when you need the lower-level explicit form.
- Always carry forward the returned `taskId` from the original task dispatch.
- Do not send follow-up updates without `taskId`.

## Environment Defaults

When GT Office launched the terminal, prefer the injected defaults:

- `GTO_WORKSPACE_ID`
- `GTO_AGENT_ID`

If those variables are present, you can omit `--workspace-id` and `--agent-id`.

## Core Commands

Send a task:

```bash
gto send manager build "Review the migration plan and reply with blockers." --json
```

Send and wait for the next reply:

```bash
gto send manager build "Review the migration plan and reply with blockers." --wait --timeout-sec 120 --json
```

Reply with a status update:

```bash
gto agent reply-status --task-id task_123 --target-agent-id agent-01 --detail "Blocked on the storage migration test." --json
```

Send a handover:

```bash
gto agent handover --task-id task_123 --target-agent-id agent-01 --summary "Implementation is complete and ready for review." --blocker "Need final product sign-off." --next-step "Review the diff." --json
```

Inspect an inbox:

```bash
gto inbox build --limit 20 --json
```

Inspect one task thread:

```bash
gto thread task_123 --json
```

Wait for the next reply on an existing task:

```bash
gto wait task_123 --from manager --timeout-sec 120 --json
```

## Workflow

1. If you do not know the target agent id or exact agent name, run `gto agents` or `gto directory snapshot --workspace-id <id> --json`.
2. Dispatch with `gto send` and save the returned `taskId`.
3. Use `gto send ... --wait` or `gto wait <taskId>` when you need synchronous follow-up behavior.
4. Use `gto agent reply-status` for interim progress.
5. Use `gto agent handover` when the work is ready to return.
6. Use `gto inbox` or `gto thread` whenever you need to rebuild context from the task conversation history.

## Code Bot Thread

Tasks sent from the Code Bot pane end with a `## Code Bot reply` section that names a `cb-…` id and your own agent id as the target. When you finish (or need the user to decide something), post your answer exactly as that section shows — that is how the user sees it; they are not watching your terminal. The `cb-…` id is given to you, so using it is not inventing a task id.

For a multi-line reply or one containing quotes, write it to a file and use `--detail-file <path>` instead of `--detail "<text>"` (and `--summary-file` instead of `--summary` for `gto agent handover`); this avoids shell quoting problems (PowerShell especially):

```bash
gto agent reply-status --task-id cb-abc --target-agent-id <your-agent-id> --detail-file reply.md --workspace-id <id> --json
```

If a hand-off to another agent fails with `AGENT_COLLAB_HOP_LIMIT` or `AGENT_COLLAB_PAUSED`, the user has capped or paused agent-to-agent delegation. Do not retry the hand-off; finish what you can yourself and report back in the Code Bot thread.

## Avoid

- Do not invent a new `taskId`; only reuse the one returned by the original dispatch (or the `cb-…` id a Code Bot task gives you).
- Do not treat plain terminal output as a reply unless `gto --wait` captured and returned it. Explicit CLI replies remain the preferred path for thread history.
