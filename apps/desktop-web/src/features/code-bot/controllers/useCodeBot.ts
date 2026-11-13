import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  desktopApi,
  type AgentProfile,
  type AgentRuntimeState,
  type ChannelMessagePayload,
  type CodeBotCollaborationGuardSnapshot,
  type TaskDispatchBatchResponse,
} from '@shell/integration/desktop-api'
import { placeAgentsOnStoredCanvas } from '@features/agent-canvas'
import { resolveRecipients, type CodeBotMember } from '../model/code-bot-mentions'
import {
  buildReplyInstruction,
  channelMessageToThreadItem,
  clearStoredThread,
  appendStoredAgentItem,
  isStoredAgentItem,
  markDeliveryInFlight,
  updateStoredDelivery,
  isStoredHumanMessage,
  settleStoredMessage,
  loadAgentItems,
  loadClearedAt,
  loadHumanMessages,
  mergeThreadItems,
  MAX_STORED_THREAD_ITEMS,
  saveAgentItems,
  saveClearedAt,
  saveHumanMessages,
  type CodeBotDelivery,
  type CodeBotDispatchItem,
  type CodeBotHumanMessage,
  type CodeBotReplyItem,
  type CodeBotThreadItem,
} from '../model/code-bot-thread'

/** Fixed ids from `gt_agent::ensure_code_bot_team` (crates/gt-agent/src/code_bot.rs). */
export const CODE_BOT_AGENT_IDS = ['codebot-claude', 'codebot-codex'] as const
const ALL_CODE_BOT_IDS: ReadonlySet<string> = new Set(CODE_BOT_AGENT_IDS)

const STATUS_POLL_MS = 3000
const LAUNCH_ONLINE_TIMEOUT_MS = 30000
/** After the runtime registers online, the CLI still needs a moment to draw
 * its prompt before typed input is accepted. */
const CLI_READY_GRACE_MS = 4000
const DATABASE_SAVE_DEBOUNCE_MS = 1000

type AgentItem = CodeBotDispatchItem | CodeBotReplyItem

export interface CodeBotDispatchInput {
  workspaceId: string
  title: string
  markdown: string
  targetStationIds: string[]
  /** Code Bot passes false so the task center's own checkbox never leaks in. */
  suppressOutputCollectionInstructions?: boolean
}

export interface UseCodeBotOptions {
  workspaceId: string | null
  /** True while the pane is on screen. The hook stays mounted while hidden
   * (so in-flight sends and incoming replies are never lost) but only polls
   * runtime status while active. */
  active: boolean
  onLaunchAgent?: (agentId: string) => Promise<void>
  onDispatch?: (input: CodeBotDispatchInput) => Promise<TaskDispatchBatchResponse>
  onAgentsChanged?: () => void | Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function newConversationId(): string {
  return `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function messageTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? ''
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine || 'Code Bot'
}

function isOnlineState(state: AgentRuntimeState | undefined): boolean {
  return state === 'idle' || state === 'active'
}

export function useCodeBot({ workspaceId, active, onLaunchAgent, onDispatch, onAgentsChanged }: UseCodeBotOptions) {
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [runtimeStates, setRuntimeStates] = useState<Record<string, AgentRuntimeState>>({})
  const [humanMessages, setHumanMessages] = useState<CodeBotHumanMessage[]>([])
  const [channelItems, setChannelItems] = useState<AgentItem[]>([])
  const [clearedAtMs, setClearedAtMs] = useState(0)
  const [lastRecipients, setLastRecipients] = useState<string[]>([])
  const [settingUpTeam, setSettingUpTeam] = useState(false)
  const [hydratedWorkspaceId, setHydratedWorkspaceId] = useState<string | null>(null)

  // Every async result is checked against the *current* workspace before it
  // touches state: a reply for workspace A must never land in B's view.
  const workspaceIdRef = useRef(workspaceId)
  useLayoutEffect(() => {
    workspaceIdRef.current = workspaceId
  }, [workspaceId])
  // Set by the reset effect once state holds *this* workspace's thread.
  // Between the switch commit and that effect, state still belongs to the
  // previous workspace, so a result for the new one must go to storage (the
  // reset effect then loads it) rather than into the stale state.
  const hydratedRef = useRef<string | null>(null)
  const isCurrent = useCallback(
    (id: string) => workspaceIdRef.current === id && hydratedRef.current === id,
    [],
  )

  const runtimeStatesRef = useRef(runtimeStates)
  useLayoutEffect(() => {
    runtimeStatesRef.current = runtimeStates
  }, [runtimeStates])
  const humanMessagesRef = useRef(humanMessages)
  useLayoutEffect(() => {
    humanMessagesRef.current = humanMessages
  }, [humanMessages])
  // Callbacks from the shell are new on every render; read them through refs
  // so the long-lived async flows below always call the latest one.
  const callbacksRef = useRef({ onLaunchAgent, onDispatch, onAgentsChanged })
  useLayoutEffect(() => {
    callbacksRef.current = { onLaunchAgent, onDispatch, onAgentsChanged }
  })

  // Keyed by content, so re-fetching an identical agent list keeps the same
  // `members` array and memoized thread rows don't all re-render.
  const membersKey = CODE_BOT_AGENT_IDS.map((id) => {
    const agent = agents.find((entry) => entry.id === id)
    return agent ? `${agent.id}\u0000${agent.name}\u0000${agent.tool}` : ''
  }).join('\u0001')
  const members: CodeBotMember[] = useMemo(
    () =>
      membersKey
        .split('\u0001')
        .filter(Boolean)
        .map((entry) => {
          const [agentId, name, tool] = entry.split('\u0000')
          return { agentId, name, tool }
        }),
    [membersKey],
  )
  // A string key, so effects keyed on the team don't re-run every time the
  // agent list is re-fetched into a new (but identical) array.
  const teamKey = members.map((member) => member.agentId).join(',')
  const teamIds = useMemo(() => new Set(teamKey ? teamKey.split(',') : []), [teamKey])
  const teamIdsRef = useRef(teamIds)
  useLayoutEffect(() => {
    teamIdsRef.current = teamIds
  }, [teamIds])

  const reloadAgents = useCallback(async () => {
    if (!workspaceId) return
    try {
      const response = await desktopApi.agentList(workspaceId)
      if (isCurrent(workspaceId)) {
        setAgents(response.agents)
        setAgentsLoaded(true)
      }
    } catch {
      // Keep the previous list and stay "not loaded": a transient failure
      // must not look like "this workspace has no team".
    }
  }, [workspaceId, isCurrent])

  const refreshStatuses = useCallback(async () => {
    if (!workspaceId) return
    try {
      const response = await desktopApi.agentCanvasRuntimeStatus(workspaceId)
      if (!isCurrent(workspaceId)) return
      const next: Record<string, AgentRuntimeState> = Object.fromEntries(
        response.statuses.map((status) => [status.agentId, status.state]),
      )
      const previous = runtimeStatesRef.current
      const unchanged =
        Object.keys(next).length === Object.keys(previous).length &&
        Object.entries(next).every(([agentId, state]) => previous[agentId] === state)
      // Polled every few seconds: skip identical results so the pane doesn't
      // re-render on every poll.
      if (unchanged) return
      runtimeStatesRef.current = next
      setRuntimeStates(next)
    } catch {
      // Keep the last known states on a transient failure.
    }
  }, [workspaceId, isCurrent])

  // Per-workspace state reset + initial loads.
  useEffect(() => {
    setAgents([])
    setAgentsLoaded(false)
    setRuntimeStates({})
    runtimeStatesRef.current = {}
    setChannelItems(workspaceId ? loadAgentItems(workspaceId) : [])
    setClearedAtMs(workspaceId ? loadClearedAt(workspaceId) : 0)
    setLastRecipients([])
    setHumanMessages(workspaceId ? loadHumanMessages(workspaceId) : [])
    setHydratedWorkspaceId(workspaceId)
    hydratedRef.current = workspaceId
    if (!workspaceId) return
    void reloadAgents()
    void refreshStatuses()
  }, [workspaceId, reloadAgents, refreshStatuses])

  // Saves only once state was loaded for *this* workspace — on the render
  // right after a switch, state still holds the previous workspace's thread.
  useEffect(() => {
    if (workspaceId && hydratedWorkspaceId === workspaceId) saveHumanMessages(workspaceId, humanMessages)
  }, [workspaceId, hydratedWorkspaceId, humanMessages])

  useEffect(() => {
    if (workspaceId && hydratedWorkspaceId === workspaceId) saveAgentItems(workspaceId, channelItems)
  }, [workspaceId, hydratedWorkspaceId, channelItems])

  // SQLite copy (P5). localStorage above is the instant cache; the database
  // is the durable store. On load the two are merged by item id (local wins
  // on conflicts — it is at least as fresh). Saving to the database waits
  // until that merge happened, so a fresh cache can never overwrite a
  // fuller database copy.
  const [databaseLoadedFor, setDatabaseLoadedFor] = useState<string | null>(null)
  useEffect(() => {
    setDatabaseLoadedFor(null)
    if (!workspaceId || !desktopApi.isTauriRuntime()) return
    let disposed = false
    desktopApi
      .codeBotThreadLoad(workspaceId)
      .then((record) => {
        if (disposed || !isCurrent(workspaceId)) return
        const storedHuman = (record.humanItems ?? []).filter(isStoredHumanMessage)
          .map((message) => settleStoredMessage(workspaceId, message))
        const storedAgent = (record.agentItems ?? []).filter(isStoredAgentItem)
        // A clear done while this load was in flight must win over the
        // database's older copy.
        const clearedAt = Math.max(record.clearedAtMs, loadClearedAt(workspaceId))
        setHumanMessages(
          (current) =>
            mergeThreadItems(
              storedHuman.filter((message) => message.tsMs > clearedAt),
              current,
            ) as CodeBotHumanMessage[],
        )
        setChannelItems((current) => mergeThreadItems(storedAgent, current) as AgentItem[])
        setClearedAtMs((current) => Math.max(current, record.clearedAtMs))
        // Only a successful merge opens database saves. If the load fails,
        // this session keeps saving to localStorage only, so the cache can
        // never overwrite a fuller database copy it never saw.
        setDatabaseLoadedFor(workspaceId)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [workspaceId, isCurrent])

  useEffect(() => {
    if (!workspaceId || databaseLoadedFor !== workspaceId || hydratedWorkspaceId !== workspaceId) return
    const timer = window.setTimeout(() => {
      desktopApi
        .codeBotThreadSave(
          workspaceId,
          humanMessages.slice(-MAX_STORED_THREAD_ITEMS),
          channelItems.slice(-MAX_STORED_THREAD_ITEMS),
          clearedAtMs,
        )
        .catch(() => {})
    }, DATABASE_SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [workspaceId, databaseLoadedFor, hydratedWorkspaceId, humanMessages, channelItems, clearedAtMs])

  useEffect(() => {
    if (!active || !workspaceId) return
    // Coming back to the pane: pick up agent renames and status at once.
    void reloadAgents()
    void refreshStatuses()
    const timer = window.setInterval(() => void refreshStatuses(), STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [active, workspaceId, reloadAgents, refreshStatuses])

  // Channel messages: initial snapshot (the store keeps the latest 512 in
  // memory) plus live events. Runs while hidden too, so replies that arrive
  // off-screen are persisted before the backend drops them.
  useEffect(() => {
    if (!workspaceId || !teamKey) return
    let disposed = false
    void desktopApi
      .channelListMessages({ workspaceId, limit: 200 })
      .then((response) => {
        if (disposed || !isCurrent(workspaceId)) return
        const items = response.messages
          .map((message) => channelMessageToThreadItem(message, teamIdsRef.current))
          .filter((item): item is AgentItem => item !== null)
        setChannelItems((current) => mergeThreadItems(current, items) as AgentItem[])
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [workspaceId, teamKey, isCurrent])

  useEffect(() => {
    if (!workspaceId) return
    let unlisten: (() => void) | null = null
    let disposed = false
    const onMessage = (message: ChannelMessagePayload) => {
      // `isCurrent` (not just the id) so a message arriving in the switch gap
      // goes to storage instead of into state about to be replaced.
      if (!isCurrent(message.workspaceId)) {
        // Another workspace's Code Bot traffic: keep it in that workspace's
        // stored thread, since the backend may drop it before the user
        // switches back.
        const item = channelMessageToThreadItem(message, ALL_CODE_BOT_IDS)
        if (item) appendStoredAgentItem(message.workspaceId, item)
        return
      }
      const item = channelMessageToThreadItem(message, teamIdsRef.current)
      if (!item) return
      setChannelItems((current) => mergeThreadItems(current, [item]) as AgentItem[])
    }
    desktopApi
      .subscribeChannelEvents({ onMessage, onAck: () => {}, onDispatchProgress: () => {} })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [workspaceId, isCurrent])

  // Loop guard (P3): pause flag and agent hand-offs since the last user message.
  const [guard, setGuard] = useState<CodeBotCollaborationGuardSnapshot | null>(null)
  useEffect(() => {
    setGuard(null)
    if (!workspaceId) return
    let disposed = false
    let unlisten: (() => void) | null = null
    desktopApi
      .codeBotCollaborationState(workspaceId)
      .then(async (snapshot) => {
        if (disposed) return
        setGuard(snapshot)
        // The guard is in-memory: after an app restart, re-apply the limit
        // the user chose for this workspace.
        const preferred = loadHopLimitPreference(workspaceId)
        if (preferred !== null && preferred !== snapshot.hopLimit) {
          const updated = await desktopApi.codeBotSetHopLimit(workspaceId, preferred)
          if (!disposed) setGuard(updated)
        }
      })
      .catch(() => {})
    desktopApi
      .subscribeCodeBotCollaborationGuard((snapshot) => {
        if (snapshot.workspaceId === workspaceId) setGuard(snapshot)
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [workspaceId])

  const setCollaborationPaused = useCallback(
    async (paused: boolean) => {
      if (!workspaceId) return
      const snapshot = await desktopApi.codeBotSetCollaborationPaused(workspaceId, paused)
      if (isCurrent(workspaceId)) setGuard(snapshot)
    },
    [workspaceId, isCurrent],
  )

  const setHopLimit = useCallback(
    async (limit: number) => {
      if (!workspaceId) return
      const snapshot = await desktopApi.codeBotSetHopLimit(workspaceId, limit)
      saveHopLimitPreference(workspaceId, snapshot.hopLimit)
      if (isCurrent(workspaceId)) setGuard(snapshot)
    },
    [workspaceId, isCurrent],
  )

  const items: CodeBotThreadItem[] = useMemo(
    () =>
      mergeThreadItems(
        humanMessages,
        clearedAtMs > 0 ? channelItems.filter((item) => item.tsMs > clearedAtMs) : channelItems,
      ),
    [humanMessages, channelItems, clearedAtMs],
  )

  const setupTeam = useCallback(async () => {
    if (!workspaceId) return
    setSettingUpTeam(true)
    try {
      const team = await desktopApi.codeBotEnsureTeam(workspaceId)
      placeAgentsOnStoredCanvas(workspaceId, [team.claudeAgentId, team.codexAgentId])
      if (!isCurrent(workspaceId)) return
      await reloadAgents()
      await callbacksRef.current.onAgentsChanged?.()
    } finally {
      setSettingUpTeam(false)
    }
  }, [workspaceId, reloadAgents, isCurrent])

  const updateDelivery = useCallback((messageId: string, agentId: string, delivery: CodeBotDelivery) => {
    setHumanMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, deliveries: { ...message.deliveries, [agentId]: delivery } }
          : message,
      ),
    )
  }, [])

  /** Polls the *target* workspace directly (not the on-screen one), so a
   * launch keeps being tracked if the user switches workspaces meanwhile. */
  const waitUntilOnline = useCallback(
    async (targetWorkspaceId: string, agentId: string): Promise<boolean> => {
      const deadline = Date.now() + LAUNCH_ONLINE_TIMEOUT_MS
      while (Date.now() < deadline) {
        try {
          const response = await desktopApi.agentCanvasRuntimeStatus(targetWorkspaceId)
          const state = response.statuses.find((status) => status.agentId === agentId)?.state
          if (isOnlineState(state)) {
            if (isCurrent(targetWorkspaceId)) void refreshStatuses()
            return true
          }
        } catch {
          // Transient; keep polling until the deadline.
        }
        await sleep(1000)
      }
      return false
    },
    [refreshStatuses, isCurrent],
  )

  // One "start it and wait until it can take input" run per agent at a
  // time. Concurrent sends, retries and the header's Start button all await
  // the same promise, so a CLI is never launched twice and nothing is typed
  // into it during its start-up grace period.
  const readinessRef = useRef(new Map<string, Promise<boolean>>())
  const ensureReady = useCallback(
    (targetWorkspaceId: string, agentId: string): Promise<boolean> => {
      const key = `${targetWorkspaceId}:${agentId}`
      const pending = readinessRef.current.get(key)
      if (pending) return pending
      // The cached states belong to the on-screen workspace only.
      if (isCurrent(targetWorkspaceId) && isOnlineState(runtimeStatesRef.current[agentId])) {
        return Promise.resolve(true)
      }
      const run = (async () => {
        try {
          await callbacksRef.current.onLaunchAgent?.(agentId)
          const online = await waitUntilOnline(targetWorkspaceId, agentId)
          if (online) await sleep(CLI_READY_GRACE_MS)
          return online
        } finally {
          readinessRef.current.delete(key)
        }
      })()
      readinessRef.current.set(key, run)
      return run
    },
    [waitUntilOnline, isCurrent],
  )

  const launchAgent = useCallback(
    async (agentId: string) => {
      if (workspaceId) await ensureReady(workspaceId, agentId)
    },
    [workspaceId, ensureReady],
  )

  /** Records a delivery outcome: into state when its workspace is on screen,
   * otherwise straight into that workspace's stored thread. */
  const recordDelivery = useCallback(
    (targetWorkspaceId: string, conversationId: string, agentId: string, delivery: CodeBotDelivery) => {
      if (isCurrent(targetWorkspaceId)) updateDelivery(conversationId, agentId, delivery)
      else updateStoredDelivery(targetWorkspaceId, conversationId, agentId, delivery)
    },
    [isCurrent, updateDelivery],
  )

  /** Delivers one message to one agent, starting its CLI first if needed,
   * and records the outcome on the message — even if the user switched to
   * another workspace meanwhile. */
  const deliver = useCallback(
    async (targetWorkspaceId: string, conversationId: string, agentId: string, text: string) => {
      const dispatch = callbacksRef.current.onDispatch
      if (!dispatch) return
      markDeliveryInFlight(targetWorkspaceId, conversationId, agentId, true)
      try {
        const ready = await ensureReady(targetWorkspaceId, agentId)
        if (!ready) {
          recordDelivery(targetWorkspaceId, conversationId, agentId, { status: 'failed', detail: 'AGENT_OFFLINE' })
          return
        }
        // The shell presses Enter in the *on-screen* workspace's terminal for
        // that agent id (same ids in every workspace). If the user switched
        // away meanwhile, sending now could submit into the wrong workspace,
        // so stop here and let them retry from the original workspace.
        if (!isCurrent(targetWorkspaceId)) {
          recordDelivery(targetWorkspaceId, conversationId, agentId, {
            status: 'failed',
            detail: 'WORKSPACE_SWITCHED',
          })
          return
        }
        recordDelivery(targetWorkspaceId, conversationId, agentId, { status: 'sending' })
        const response = await dispatch({
          workspaceId: targetWorkspaceId,
          title: messageTitle(text),
          markdown: `${text}\n\n${buildReplyInstruction({ workspaceId: targetWorkspaceId, agentId, conversationId })}`,
          targetStationIds: [agentId],
          suppressOutputCollectionInstructions: false,
        })
        const result = response.results.find((entry) => entry.targetAgentId === agentId)
        recordDelivery(
          targetWorkspaceId,
          conversationId,
          agentId,
          result?.status === 'sent'
            ? { status: 'sent' }
            : { status: 'failed', detail: result?.detail ?? 'DISPATCH_FAILED' },
        )
      } catch (error) {
        recordDelivery(targetWorkspaceId, conversationId, agentId, { status: 'failed', detail: String(error) })
      } finally {
        markDeliveryInFlight(targetWorkspaceId, conversationId, agentId, false)
      }
    },
    [ensureReady, recordDelivery, isCurrent],
  )

  const lastRecipientsRef = useRef(lastRecipients)
  useLayoutEffect(() => {
    lastRecipientsRef.current = lastRecipients
  }, [lastRecipients])

  /** Sends `text` to the recipients it addresses (see `resolveRecipients`),
   * starting any offline recipient's CLI first. Returns false when there was
   * nobody to send to. */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim()
      if (!workspaceId || !trimmed || !callbacksRef.current.onDispatch || members.length === 0) return false
      let recipients = resolveRecipients(trimmed, members)
      if (recipients.length === 0) {
        recipients = lastRecipientsRef.current.filter((id) => teamIdsRef.current.has(id))
      }
      if (recipients.length === 0) recipients = [members[0].agentId]
      setLastRecipients(recipients)

      const conversationId = newConversationId()
      const message: CodeBotHumanMessage = {
        kind: 'human',
        id: conversationId,
        tsMs: Date.now(),
        text: trimmed,
        targets: recipients,
        deliveries: Object.fromEntries(
          recipients.map((id) => [
            id,
            { status: isOnlineState(runtimeStatesRef.current[id]) ? 'sending' : 'launching' } satisfies CodeBotDelivery,
          ]),
        ),
      }
      setHumanMessages((current) => [...current, message])
      await Promise.all(recipients.map((agentId) => deliver(workspaceId, conversationId, agentId, trimmed)))
      return true
    },
    [workspaceId, members, deliver],
  )

  /** Re-sends one failed delivery of an earlier message, keeping its
   * conversation id so the agent's reply still lines up with it. */
  const retryDelivery = useCallback(
    async (messageId: string, agentId: string) => {
      if (!workspaceId) return
      const message = humanMessagesRef.current.find((entry) => entry.id === messageId)
      if (!message || message.deliveries[agentId]?.status !== 'failed') return
      updateDelivery(messageId, agentId, {
        status: isOnlineState(runtimeStatesRef.current[agentId]) ? 'sending' : 'launching',
      })
      await deliver(workspaceId, messageId, agentId, message.text)
    },
    [workspaceId, deliver, updateDelivery],
  )

  /** Clears the thread for this workspace. Agent items still held by the
   * backend's in-memory store would come back on the next snapshot, so the
   * clear time is remembered and older items stay hidden. */
  const clearThread = useCallback(() => {
    if (!workspaceId) return
    const now = Date.now()
    clearStoredThread(workspaceId)
    saveClearedAt(workspaceId, now)
    setClearedAtMs(now)
    setHumanMessages([])
    setChannelItems([])
  }, [workspaceId])

  return {
    agentsLoaded,
    members,
    runtimeStates,
    items,
    lastRecipients,
    settingUpTeam,
    setupTeam,
    launchAgent,
    send,
    retryDelivery,
    clearThread,
    guard,
    setCollaborationPaused,
    setHopLimit,
  }
}

const HOP_LIMIT_PREFIX = 'code-bot.hop-limit'

function loadHopLimitPreference(workspaceId: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(`${HOP_LIMIT_PREFIX}:${workspaceId}`))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function saveHopLimitPreference(workspaceId: string, limit: number): void {
  try {
    window.localStorage.setItem(`${HOP_LIMIT_PREFIX}:${workspaceId}`, String(limit))
  } catch {
    // Preference only.
  }
}
