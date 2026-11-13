import type { ChannelMessagePayload } from '@shell/integration/desktop-api'

/** Per-target delivery state of one human message. `launching` covers the
 * wait while an offline agent's CLI is started before the dispatch. */
export type CodeBotDeliveryStatus = 'launching' | 'sending' | 'sent' | 'failed'

export interface CodeBotDelivery {
  status: CodeBotDeliveryStatus
  detail?: string
}

export interface CodeBotHumanMessage {
  kind: 'human'
  id: string
  tsMs: number
  text: string
  targets: string[]
  deliveries: Record<string, CodeBotDelivery>
}

/** One agent handing a task to another (`gto agent send-task`). The
 * dispatch event carries only the title, never the full markdown. */
export interface CodeBotDispatchItem {
  kind: 'dispatch'
  id: string
  tsMs: number
  from: string
  to: string
  title: string
}

/** A `status`/`handover` report. `to === from` is a reply addressed to the
 * Code Bot thread itself (see `buildReplyInstruction`). */
export interface CodeBotReplyItem {
  kind: 'reply'
  id: string
  tsMs: number
  from: string
  to: string
  replyKind: 'status' | 'handover'
  /** Status detail, or a handover's summary. */
  text: string
  /** Handover only; labelled by the UI so the text stays translatable. */
  blockers?: string[]
  nextSteps?: string[]
  conversationId: string | null
}

export type CodeBotThreadItem = CodeBotHumanMessage | CodeBotDispatchItem | CodeBotReplyItem

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : []
}

/** Maps a channel message into a thread item, or `null` when it does not
 * belong in the Code Bot thread: human-sent instructions (the thread keeps
 * its own copy with the full text) and anything not involving a team member. */
export function channelMessageToThreadItem(
  message: ChannelMessagePayload,
  teamAgentIds: ReadonlySet<string>,
): CodeBotDispatchItem | CodeBotReplyItem | null {
  const from = message.senderAgentId?.trim() ?? ''
  if (!from) return null
  if (!teamAgentIds.has(from) && !teamAgentIds.has(message.targetAgentId)) return null
  const payload = message.payload ?? {}
  if (message.type === 'task_instruction') {
    return {
      kind: 'dispatch',
      id: message.messageId,
      tsMs: message.tsMs,
      from,
      to: message.targetAgentId,
      title: readString(payload.title).trim() || readString(payload.taskId),
    }
  }
  const isHandover = message.type === 'handover'
  const text = readString(isHandover ? payload.summary : payload.detail).trim()
  const blockers = isHandover ? readStringList(payload.blockers) : []
  const nextSteps = isHandover ? readStringList(payload.nextSteps) : []
  if (!text && blockers.length === 0 && nextSteps.length === 0) return null
  return {
    kind: 'reply',
    id: message.messageId,
    tsMs: message.tsMs,
    from,
    to: message.targetAgentId,
    replyKind: isHandover ? 'handover' : 'status',
    text,
    ...(blockers.length > 0 ? { blockers } : {}),
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
    conversationId: readString(payload.taskId) || null,
  }
}

/** Oldest first; ties keep insertion order. Deduplicates by id so a message
 * seen both in the initial list and as a live event appears once. */
export function mergeThreadItems(...groups: CodeBotThreadItem[][]): CodeBotThreadItem[] {
  const byId = new Map<string, CodeBotThreadItem>()
  for (const group of groups) {
    for (const item of group) {
      byId.set(`${item.kind}:${item.id}`, item)
    }
  }
  return [...byId.values()].sort((left, right) => left.tsMs - right.tsMs)
}

/** One reply's body as Markdown: its text plus labelled blocker / next-step
 * lists. Shared by the per-reply copy button and the thread export. */
export function replyBodyToMarkdown(
  item: CodeBotReplyItem,
  labels: { blockers: string; nextSteps: string },
): string {
  const parts: string[] = []
  if (item.text) parts.push(item.text)
  const list = (heading: string, entries: string[] | undefined) => {
    if (entries && entries.length > 0) parts.push([`${heading}:`, ...entries.map((entry) => `- ${entry}`)].join('\n'))
  }
  list(labels.blockers, item.blockers)
  list(labels.nextSteps, item.nextSteps)
  return parts.join('\n\n')
}

/** The thread as Markdown, oldest first, for saving or sharing a session.
 * `nameOf` maps agent ids to display names. */
export function threadToMarkdown(
  items: CodeBotThreadItem[],
  nameOf: (agentId: string) => string,
  labels: { title: string; you: string; handoff: string; blockers: string; nextSteps: string },
): string {
  // Local time, matching what the thread shows on screen.
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = (tsMs: number) => {
    const date = new Date(tsMs)
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const lines = [`# ${labels.title}`, '']
  for (const item of items) {
    if (item.kind === 'human') {
      lines.push(`**${labels.you} → ${item.targets.map(nameOf).join(', ')}** · ${time(item.tsMs)}`, '', item.text, '')
    } else if (item.kind === 'dispatch') {
      // A multi-line title would break out of the `> ` quote line.
      const title = item.title.replace(/\s*\n\s*/g, ' ')
      lines.push(`> ${labels.handoff}: ${nameOf(item.from)} → ${nameOf(item.to)} — ${title} · ${time(item.tsMs)}`, '')
    } else {
      const header = item.to === item.from ? nameOf(item.from) : `${nameOf(item.from)} → ${nameOf(item.to)}`
      lines.push(`**${header}** · ${time(item.tsMs)}`, '', replyBodyToMarkdown(item, labels), '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** How long after a delivery an idle, silent agent counts as "finished
 * without reporting back". */
export const SILENT_AGENT_AFTER_MS = 60_000

/** Recipients of `message` that got it, have gone idle, and never posted a
 * thread reply for it — most likely they finished but skipped the
 * `reply-status` step, so the answer is only in their terminal. */
export function silentRecipients(
  message: CodeBotHumanMessage,
  hasReplied: (agentId: string, conversationId: string) => boolean,
  isIdle: (agentId: string) => boolean,
  nowMs: number,
): string[] {
  if (nowMs - message.tsMs < SILENT_AGENT_AFTER_MS) return []
  return message.targets.filter(
    (agentId) =>
      message.deliveries[agentId]?.status === 'sent' && isIdle(agentId) && !hasReplied(agentId, message.id),
  )
}

/** Items involving `agentId` (sent to, from, or handed between) whose text
 * contains `query` (case-insensitive). `null`/empty means no filter. */
export function filterThreadItems(
  items: CodeBotThreadItem[],
  agentId: string | null,
  query: string,
): CodeBotThreadItem[] {
  const needle = query.trim().toLowerCase()
  return items.filter((item) => {
    if (agentId) {
      const involved =
        item.kind === 'human' ? item.targets.includes(agentId) : item.from === agentId || item.to === agentId
      if (!involved) return false
    }
    if (!needle) return true
    const parts =
      item.kind === 'dispatch'
        ? [item.title]
        : item.kind === 'reply'
          ? [item.text, ...(item.blockers ?? []), ...(item.nextSteps ?? [])]
          : [item.text]
    return parts.some((part) => part.toLowerCase().includes(needle))
  })
}

/** Appended to every human message so the agent reports its result back to
 * the thread. The agent publishes a `status` to itself: the bridge allows
 * self-messages without a canvas edge, stores them, and never types them
 * into a terminal — so the reply shows up here without new backend work. */
export function buildReplyInstruction(input: {
  workspaceId: string
  agentId: string
  conversationId: string
}): string {
  return [
    '## Code Bot reply',
    'When you finish (or need the user to decide something), post your answer to the Code Bot thread — the user reads it there, not in this terminal. Keep it short and use the language the user wrote in:',
    `\`gto agent reply-status --task-id ${input.conversationId} --target-agent-id ${input.agentId} --detail "<your reply>" --workspace-id ${input.workspaceId} --json\``,
    'For a multi-line reply, or one with quotes in it, write it to a file and pass --detail-file <path> instead of --detail — no shell quoting needed.',
    'If you hand part of the work to a collaborator, still post your own reply when your part is done.',
  ].join('\n')
}

// Stored data can be stale or hand-edited; anything malformed is dropped
// rather than crashing the pane later (e.g. `text.toLowerCase()` in search).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isStoredHumanMessage(value: unknown): value is CodeBotHumanMessage {
  return (
    isRecord(value) &&
    value.kind === 'human' &&
    typeof value.id === 'string' &&
    typeof value.tsMs === 'number' &&
    typeof value.text === 'string' &&
    Array.isArray(value.targets) &&
    value.targets.every((target) => typeof target === 'string') &&
    isRecord(value.deliveries)
  )
}

export function isStoredAgentItem(value: unknown): value is CodeBotDispatchItem | CodeBotReplyItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.tsMs !== 'number') return false
  if (typeof value.from !== 'string' || typeof value.to !== 'string') return false
  if (value.kind === 'dispatch') return typeof value.title === 'string'
  const isOptionalStringList = (list: unknown) =>
    list === undefined || (Array.isArray(list) && list.every((entry) => typeof entry === 'string'))
  return (
    value.kind === 'reply' &&
    typeof value.text === 'string' &&
    isOptionalStringList(value.blockers) &&
    isOptionalStringList(value.nextSteps)
  )
}

const STORAGE_PREFIX = 'code-bot.thread'
/** Per list, in localStorage and in the database copy. */
export const MAX_STORED_THREAD_ITEMS = 200

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}:${workspaceId}`
}

/** Human messages persist per workspace in localStorage — the backend's
 * channel store is in-memory and never had the human text anyway. */
/** Deliveries currently being worked on in this window, as
 * `workspace:message:agent`. A pending delivery found in storage is only
 * "interrupted" if it is not in here. */
const inFlightDeliveries = new Set<string>()

function deliveryKey(workspaceId: string, messageId: string, agentId: string): string {
  return `${workspaceId}:${messageId}:${agentId}`
}

export function markDeliveryInFlight(workspaceId: string, messageId: string, agentId: string, inFlight: boolean) {
  const key = deliveryKey(workspaceId, messageId, agentId)
  if (inFlight) inFlightDeliveries.add(key)
  else inFlightDeliveries.delete(key)
}

function loadHumanMessagesRaw(workspaceId: string): CodeBotHumanMessage[] {
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isStoredHumanMessage) : []
  } catch {
    return []
  }
}

/** `settleInterruptedDeliveries` for a stored message of `workspaceId`,
 * sparing deliveries still in flight in this window. */
export function settleStoredMessage(workspaceId: string, message: CodeBotHumanMessage): CodeBotHumanMessage {
  return settleInterruptedDeliveries(message, (agentId) =>
    inFlightDeliveries.has(deliveryKey(workspaceId, message.id, agentId)),
  )
}

/** Stored messages, with deliveries that were cut off (not in flight in
 * this window) turned into retryable failures. */
export function loadHumanMessages(workspaceId: string): CodeBotHumanMessage[] {
  return loadHumanMessagesRaw(workspaceId).map((message) => settleStoredMessage(workspaceId, message))
}

/** A delivery still `launching`/`sending` in storage was cut off (the app
 * closed mid-send). Mark it failed so the thread offers a retry instead of
 * spinning forever. */
export function settleInterruptedDeliveries(
  message: CodeBotHumanMessage,
  isInFlight: (agentId: string) => boolean = () => false,
): CodeBotHumanMessage {
  const cutOff = (agentId: string, delivery: CodeBotDelivery) =>
    (delivery.status === 'launching' || delivery.status === 'sending') && !isInFlight(agentId)
  if (!Object.entries(message.deliveries).some(([agentId, delivery]) => cutOff(agentId, delivery))) return message
  return {
    ...message,
    deliveries: Object.fromEntries(
      Object.entries(message.deliveries).map(([agentId, delivery]) => [
        agentId,
        cutOff(agentId, delivery) ? { status: 'failed', detail: 'INTERRUPTED' } : delivery,
      ]),
    ),
  }
}

export function saveHumanMessages(workspaceId: string, messages: CodeBotHumanMessage[]): void {
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(messages.slice(-MAX_STORED_THREAD_ITEMS)))
  } catch {
    // Storage full or unavailable: the thread still works for this session.
  }
}

const AGENT_STORAGE_PREFIX = 'code-bot.agent-items'

/** Agent replies and hand-offs persist too: the backend drops an agent's
 * channel messages when it goes offline and keeps nothing across restarts,
 * so without this a restarted agent's earlier replies would vanish. */
export function loadAgentItems(workspaceId: string): (CodeBotDispatchItem | CodeBotReplyItem)[] {
  try {
    const raw = window.localStorage.getItem(`${AGENT_STORAGE_PREFIX}:${workspaceId}`)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredAgentItem)
  } catch {
    return []
  }
}

export function saveAgentItems(workspaceId: string, items: (CodeBotDispatchItem | CodeBotReplyItem)[]): void {
  try {
    window.localStorage.setItem(
      `${AGENT_STORAGE_PREFIX}:${workspaceId}`,
      JSON.stringify(items.slice(-MAX_STORED_THREAD_ITEMS)),
    )
  } catch {
    // Same as above: best effort.
  }
}

/** Records a delivery result for a workspace that is not on screen (its
 * React state is gone), so a send that finishes after the user switched
 * workspaces isn't later mistaken for an interrupted one. */
export function updateStoredDelivery(
  workspaceId: string,
  messageId: string,
  agentId: string,
  delivery: CodeBotDelivery,
): void {
  // Raw load: other deliveries of that workspace may still be in flight and
  // must not be settled as interrupted by this write.
  const messages = loadHumanMessagesRaw(workspaceId)
  if (!messages.some((message) => message.id === messageId)) return
  saveHumanMessages(
    workspaceId,
    messages.map((message) =>
      message.id === messageId ? { ...message, deliveries: { ...message.deliveries, [agentId]: delivery } } : message,
    ),
  )
}

/** Keeps an agent reply/hand-off that arrived for a workspace not on screen;
 * the backend may drop it before the user switches back. */
export function appendStoredAgentItem(workspaceId: string, item: CodeBotDispatchItem | CodeBotReplyItem): void {
  saveAgentItems(workspaceId, mergeThreadItems(loadAgentItems(workspaceId), [item]) as (CodeBotDispatchItem | CodeBotReplyItem)[])
}

const CLEARED_AT_PREFIX = 'code-bot.cleared-at'

/** When the user last cleared this workspace's thread (0 = never). */
export function loadClearedAt(workspaceId: string): number {
  try {
    const value = Number(window.localStorage.getItem(`${CLEARED_AT_PREFIX}:${workspaceId}`))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

export function saveClearedAt(workspaceId: string, tsMs: number): void {
  try {
    window.localStorage.setItem(`${CLEARED_AT_PREFIX}:${workspaceId}`, String(tsMs))
  } catch {
    // Best effort.
  }
}

export function clearStoredThread(workspaceId: string): void {
  try {
    window.localStorage.removeItem(storageKey(workspaceId))
    window.localStorage.removeItem(`${AGENT_STORAGE_PREFIX}:${workspaceId}`)
  } catch {
    // Best effort.
  }
}
