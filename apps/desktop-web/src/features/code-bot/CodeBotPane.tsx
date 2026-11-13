import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { t, type Locale, type TranslationKey } from '@shell/i18n/ui-locale'
import { AppIcon } from '@shell/ui/icons'
import type { AgentRuntimeState } from '@shell/integration/desktop-api'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { CODE_BOT_AGENT_IDS, useCodeBot, type CodeBotDispatchInput } from './controllers/useCodeBot'
import { CodeBotDashboard } from './components/CodeBotDashboard'
import { CodeBotPreflight } from './components/CodeBotPreflight'
import {
  applyMention,
  findActiveMention,
  mentionSuggestions,
  missingMemberMentions,
  preferredHandle,
  type ActiveMention,
  type CodeBotMember,
} from './model/code-bot-mentions'
import {
  filterThreadItems,
  replyBodyToMarkdown,
  silentRecipients,
  threadToMarkdown,
  type CodeBotDeliveryStatus,
  type CodeBotThreadItem,
} from './model/code-bot-thread'

const NO_AGENTS: string[] = []
const THREAD_PAGE_SIZE = 100
/** Re-evaluates "went quiet without replying" hints this often. */
const SILENT_CHECK_MS = 15_000
import type { TaskDispatchBatchResponse } from '@shell/integration/desktop-api'
import './CodeBotPane.scss'

export interface CodeBotPaneProps {
  locale: Locale
  workspaceId: string | null
  /** Polling pauses while the pane is not shown. */
  active: boolean
  /** Starts the agent's CLI in its station terminal. */
  onLaunchAgent?: (agentId: string) => Promise<void>
  /** Sends a human task to stations (the shell's dispatch path). */
  onDispatch?: (input: CodeBotDispatchInput) => Promise<TaskDispatchBatchResponse>
  /** Jumps to the agent's station terminal. */
  onOpenAgentTerminal?: (agentId: string) => void
  /** Interrupts what the agent is doing (sends Esc to its terminal). */
  onInterruptAgent?: (agentId: string) => void
  /** Called after the pane created agents (team setup). */
  onAgentsChanged?: () => void | Promise<void>
}

const STATUS_KEY: Record<AgentRuntimeState, TranslationKey> = {
  active: 'codeBot.status.active',
  idle: 'codeBot.status.idle',
  offline: 'codeBot.status.offline',
  unknown: 'codeBot.status.offline',
}

const DELIVERY_KEY: Record<CodeBotDeliveryStatus, TranslationKey> = {
  launching: 'codeBot.delivery.launching',
  sending: 'codeBot.delivery.sending',
  sent: 'codeBot.delivery.sent',
  failed: 'codeBot.delivery.failed',
}

const DASHBOARD_PREF_KEY = 'code-bot.dashboard-open'

function loadDashboardOpen(): boolean {
  try {
    return window.localStorage.getItem(DASHBOARD_PREF_KEY) !== '0'
  } catch {
    return true
  }
}

function saveDashboardOpen(open: boolean): void {
  try {
    window.localStorage.setItem(DASHBOARD_PREF_KEY, open ? '1' : '0')
  } catch {
    // Preference only; ignore storage failures.
  }
}

function formatTime(tsMs: number): string {
  const date = new Date(tsMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function memberName(members: CodeBotMember[], agentId: string): string {
  return members.find((member) => member.agentId === agentId)?.name ?? agentId
}

function toolClass(members: CodeBotMember[], agentId: string): string {
  const tool = members.find((member) => member.agentId === agentId)?.tool ?? 'other'
  return `is-${tool}`
}

export function CodeBotPane({
  locale,
  workspaceId,
  active,
  onLaunchAgent,
  onDispatch,
  onOpenAgentTerminal,
  onInterruptAgent,
  onAgentsChanged,
}: CodeBotPaneProps) {
  const {
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
  } = useCodeBot({ workspaceId, active, onLaunchAgent, onDispatch, onAgentsChanged })
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [launching, setLaunching] = useState<Record<string, boolean>>({})
  const [dashboardOpen, setDashboardOpen] = useState(loadDashboardOpen)
  const [exported, setExported] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)
  useEffect(() => {
    if (!exported) return
    const timer = window.setTimeout(() => setExported(false), 1800)
    return () => window.clearTimeout(timer)
  }, [exported])
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNowMs(Date.now()), SILENT_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [active])
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const filteredItems = useMemo(
    () => filterThreadItems(items, filterAgentId, filterQuery),
    [items, filterAgentId, filterQuery],
  )
  // Large-list rule: only the newest page is rendered; older ones on demand.
  const [renderLimit, setRenderLimit] = useState(THREAD_PAGE_SIZE)
  useEffect(() => setRenderLimit(THREAD_PAGE_SIZE), [workspaceId, filterAgentId, filterQuery])
  const visibleItems = useMemo(
    () => (filteredItems.length > renderLimit ? filteredItems.slice(-renderLimit) : filteredItems),
    [filteredItems, renderLimit],
  )
  const hiddenOlderCount = filteredItems.length - visibleItems.length
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  // `@` position whose popup the user dismissed with Esc; it stays closed for
  // that mention, and a different `@` (or sending) brings suggestions back.
  const [dismissedMentionAt, setDismissedMentionAt] = useState<number | null>(null)

  const rawMention: ActiveMention | null = useMemo(() => findActiveMention(draft, caret), [draft, caret])
  const mention = rawMention && rawMention.start !== dismissedMentionAt ? rawMention : null
  const suggestions = useMemo(() => (mention ? mentionSuggestions(mention.query, members) : []), [mention, members])

  useEffect(() => setHighlight(0), [mention?.start, mention?.query])

  // Follow new messages only when the reader is already at the bottom, so
  // scrolling back through history isn't yanked away by an incoming reply.
  const stickToBottomRef = useRef(true)
  const newestVisible = visibleItems[visibleItems.length - 1]
  const newestVisibleId = newestVisible ? `${newestVisible.kind}:${newestVisible.id}` : ''
  // Set right before loading an older page: the scroll height before the
  // older rows were inserted, so the reader's position can be kept.
  const heightBeforeOlderRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    if (heightBeforeOlderRef.current !== null) {
      // Older rows went in above: shift by their height so the view stays put
      // (WebKit has no scroll anchoring to do this for us).
      thread.scrollTop += thread.scrollHeight - heightBeforeOlderRef.current
      heightBeforeOlderRef.current = null
      return
    }
    if (stickToBottomRef.current) thread.scrollTop = thread.scrollHeight
    // Keyed on the newest item too: past one page, a new message keeps the
    // visible window at the same length, but its last id changes.
  }, [visibleItems.length, newestVisibleId])
  // Coming back to the pane (it was display:none) or to another workspace:
  // start at the newest message again.
  useLayoutEffect(() => {
    if (!active) return
    stickToBottomRef.current = true
    const thread = threadRef.current
    if (thread) thread.scrollTop = thread.scrollHeight
  }, [active, workspaceId])

  // "Went idle without replying" hints, computed once per change instead of
  // per message per render.
  const repliedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const item of items) {
      if (item.kind === 'reply' && item.conversationId) keys.add(`${item.from}|${item.conversationId}`)
    }
    return keys
  }, [items])
  const silentByMessage = useMemo(() => {
    // Only the latest message sent to each agent can be "still waiting":
    // older ones were superseded, and hinting on every one of them would
    // turn the thread into a wall of warnings.
    const latestForAgent = new Map<string, string>()
    for (const item of items) {
      if (item.kind !== 'human') continue
      for (const agentId of item.targets) latestForAgent.set(agentId, item.id)
    }
    const result = new Map<string, string[]>()
    for (const item of items) {
      if (item.kind !== 'human') continue
      const silent = silentRecipients(
        item,
        (agentId, conversationId) => repliedKeys.has(`${agentId}|${conversationId}`),
        (agentId) => runtimeStates[agentId] === 'idle',
        nowMs,
      ).filter((agentId) => latestForAgent.get(agentId) === item.id)
      if (silent.length > 0) result.set(item.id, silent)
    }
    return result
  }, [items, repliedKeys, runtimeStates, nowMs])

  // Stable callbacks so memoized thread rows skip re-rendering while typing.
  const retryRef = useRef(retryDelivery)
  useLayoutEffect(() => {
    retryRef.current = retryDelivery
  }, [retryDelivery])
  const openTerminalRef = useRef(onOpenAgentTerminal)
  useLayoutEffect(() => {
    openTerminalRef.current = onOpenAgentTerminal
  }, [onOpenAgentTerminal])
  const handleRetry = useCallback((messageId: string, agentId: string) => void retryRef.current(messageId, agentId), [])
  const handleOpenTerminal = useCallback((agentId: string) => openTerminalRef.current?.(agentId), [])

  const insertMention = useCallback(
    (handle: string) => {
      if (!mention) return
      const next = applyMention(draft, mention, handle)
      setDraft(next.text)
      setCaret(next.caret)
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(next.caret, next.caret)
      })
    },
    [draft, mention],
  )

  const submit = useCallback(async () => {
    const text = draft
    if (!text.trim()) return
    // Only once the agent list is known; while loading, members is empty.
    const missing = agentsLoaded ? missingMemberMentions(text, members) : []
    if (missing.length > 0) {
      // Keep the draft: sending now would silently go to someone else.
      setComposerError(t(locale, 'codeBot.composer.missingMember', { handles: missing.map((h) => `@${h}`).join(', ') }))
      return
    }
    setComposerError(null)
    setDraft('')
    setCaret(0)
    setDismissedMentionAt(null)
    // Show the message just sent even if the reader had scrolled up.
    stickToBottomRef.current = true
    const sent = await send(text)
    // Put the text back only if the user hasn't started typing something new.
    if (!sent) setDraft((current) => (current ? current : text))
  }, [draft, send, members, locale, agentsLoaded])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // keyCode 229: WebKit (macOS WKWebView) reports the Enter that confirms
      // an IME candidate with isComposing=false, so check both.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (suggestions.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setHighlight((index) => (index + step + suggestions.length) % suggestions.length)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          insertMention(suggestions[highlight]?.handle ?? suggestions[0].handle)
          return
        }
        if (event.key === 'Escape' && mention) {
          event.preventDefault()
          setDismissedMentionAt(mention.start)
          return
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void submit()
      }
    },
    [suggestions, highlight, insertMention, submit, mention],
  )

  const handleLaunch = useCallback(
    async (agentId: string) => {
      setLaunching((current) => ({ ...current, [agentId]: true }))
      try {
        await launchAgent(agentId)
      } finally {
        setLaunching((current) => ({ ...current, [agentId]: false }))
      }
    },
    [launchAgent],
  )

  const addressMember = useCallback(
    (member: CodeBotMember) => {
      const handle = `@${preferredHandle(member, members)} `
      const next = draft.startsWith(handle) ? draft : handle + draft
      setDraft(next)
      setCaret(next.length)
      textareaRef.current?.focus()
    },
    [draft, members],
  )

  if (!workspaceId) {
    return (
      <div className="code-bot code-bot--empty">
        <p>{t(locale, 'codeBot.noWorkspace')}</p>
      </div>
    )
  }

  if (agentsLoaded && members.length === 0) {
    return (
      <div className="code-bot code-bot--empty">
        <AppIcon name="sparkles" aria-hidden="true" />
        <h2>{t(locale, 'codeBot.title')}</h2>
        <p>{t(locale, 'codeBot.setupIntro')}</p>
        <button type="button" className="code-bot-primary" onClick={() => void setupTeam()} disabled={settingUpTeam}>
          {t(locale, settingUpTeam ? 'agentCanvas.codeBot.working' : 'agentCanvas.codeBot.setup')}
        </button>
      </div>
    )
  }

  const recipientHint =
    lastRecipients.length > 0
      ? t(locale, 'codeBot.composer.defaultTarget', {
          names: lastRecipients.map((id) => memberName(members, id)).join(', '),
        })
      : t(locale, 'codeBot.composer.hint')

  return (
    <div className="code-bot">
      <header className="code-bot-header">
        <div className="code-bot-title">
          <span className="code-bot-logo" aria-hidden="true">
            {'>_'}
          </span>
          <div>
            <h2>{t(locale, 'codeBot.title')}</h2>
            <p>{t(locale, 'codeBot.subtitle')}</p>
          </div>
        </div>
        <div className="code-bot-members">
          <CodeBotPreflight
            locale={locale}
            active={active}
            // Until the agent list loads, assume the team is complete rather
            // than flash a false warning.
            teamMemberCount={agentsLoaded ? members.length : CODE_BOT_AGENT_IDS.length}
            teamSize={CODE_BOT_AGENT_IDS.length}
            onRestoreTeam={setupTeam}
          />
          {members.map((member) => {
            const state = runtimeStates[member.agentId] ?? 'offline'
            const online = state === 'idle' || state === 'active'
            return (
              <div key={member.agentId} className={`code-bot-member ${toolClass(members, member.agentId)} is-${state}`}>
                <button
                  type="button"
                  className="code-bot-member-main"
                  onClick={() => addressMember(member)}
                  title={t(locale, 'codeBot.member.mentionTitle', { name: member.name })}
                >
                  <span className="code-bot-dot" aria-hidden="true" />
                  <span className="code-bot-member-name">{member.name}</span>
                  <span className="code-bot-member-state">{t(locale, STATUS_KEY[state])}</span>
                </button>
                {state === 'active' && onInterruptAgent ? (
                  <button
                    type="button"
                    className="code-bot-icon-button is-danger"
                    onClick={() => onInterruptAgent(member.agentId)}
                    title={t(locale, 'codeBot.member.interrupt')}
                    aria-label={t(locale, 'codeBot.member.interrupt')}
                  >
                    <AppIcon name="stop" aria-hidden="true" />
                  </button>
                ) : null}
                {online ? (
                  <button
                    type="button"
                    className="code-bot-icon-button"
                    onClick={() => onOpenAgentTerminal?.(member.agentId)}
                    title={t(locale, 'codeBot.member.openTerminal')}
                    aria-label={t(locale, 'codeBot.member.openTerminal')}
                  >
                    <AppIcon name="terminal" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="code-bot-icon-button"
                    onClick={() => void handleLaunch(member.agentId)}
                    disabled={launching[member.agentId]}
                    title={t(locale, 'codeBot.member.launch')}
                    aria-label={t(locale, 'codeBot.member.launch')}
                  >
                    <AppIcon name="play" aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            className={`code-bot-icon-button${dashboardOpen ? ' is-active' : ''}`}
            onClick={() => {
              setDashboardOpen((open) => {
                saveDashboardOpen(!open)
                return !open
              })
            }}
            title={t(locale, dashboardOpen ? 'codeBot.dash.hide' : 'codeBot.dash.show')}
            aria-label={t(locale, dashboardOpen ? 'codeBot.dash.hide' : 'codeBot.dash.show')}
            aria-pressed={dashboardOpen}
          >
            <AppIcon name="activity" aria-hidden="true" />
          </button>
          {guard ? (
            <button
              type="button"
              className={`code-bot-collab-toggle${guard.paused ? ' is-paused' : ''}`}
              onClick={() => void setCollaborationPaused(!guard.paused)}
              title={t(locale, guard.paused ? 'codeBot.collab.resumeTitle' : 'codeBot.collab.pauseTitle')}
              aria-pressed={guard.paused}
            >
              <span className="code-bot-dot" aria-hidden="true" />
              {guard.paused
                ? t(locale, 'codeBot.collab.paused')
                : t(locale, 'codeBot.collab.hops', { count: guard.agentHops, limit: guard.hopLimit })}
            </button>
          ) : null}
          <button
            type="button"
            className={`code-bot-icon-button${exported ? ' is-active' : ''}`}
            disabled={items.length === 0}
            onClick={() => {
              const markdown = threadToMarkdown(items, (agentId) => memberName(members, agentId), {
                title: t(locale, 'codeBot.title'),
                you: t(locale, 'codeBot.dash.you'),
                handoff: t(locale, 'codeBot.export.handoff'),
                blockers: t(locale, 'codeBot.reply.blockers'),
                nextSteps: t(locale, 'codeBot.reply.nextSteps'),
              })
              void copyText(markdown).then((ok) => {
                if (ok) setExported(true)
              })
            }}
            title={t(locale, exported ? 'codeBot.export.done' : 'codeBot.export.title')}
            aria-label={t(locale, exported ? 'codeBot.export.done' : 'codeBot.export.title')}
          >
            <AppIcon name={exported ? 'check' : 'copy'} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="code-bot-icon-button"
            onClick={() => {
              if (window.confirm(t(locale, 'codeBot.clearConfirm'))) clearThread()
            }}
            title={t(locale, 'codeBot.clear')}
            aria-label={t(locale, 'codeBot.clear')}
          >
            <AppIcon name="trash" aria-hidden="true" />
          </button>
        </div>
      </header>

      {agentsLoaded && members.length < CODE_BOT_AGENT_IDS.length ? (
        <div className="code-bot-banner" role="status">
          <span>{t(locale, 'codeBot.team.incomplete')}</span>
          <button type="button" className="code-bot-primary" onClick={() => void setupTeam()} disabled={settingUpTeam}>
            {t(locale, settingUpTeam ? 'agentCanvas.codeBot.working' : 'codeBot.team.restore')}
          </button>
        </div>
      ) : null}

      {dashboardOpen ? (
        <CodeBotDashboard
          locale={locale}
          active={active}
          members={members}
          runtimeStates={runtimeStates}
          items={items}
          guard={guard}
          onSetHopLimit={setHopLimit}
        />
      ) : null}

      {guard && !guard.paused && guard.hopLimitReached ? (
        <div className="code-bot-banner" role="status">
          <span>{t(locale, 'codeBot.collab.limitReached', { limit: guard.hopLimit })}</span>
          <button type="button" className="code-bot-primary" onClick={() => void setCollaborationPaused(false)}>
            {t(locale, 'codeBot.collab.continue')}
          </button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="code-bot-filters" role="toolbar" aria-label={t(locale, 'codeBot.filter.label')}>
          {[null, ...members.map((member) => member.agentId)].map((agentId) => (
            <button
              key={agentId ?? 'all'}
              type="button"
              className={`code-bot-chip${filterAgentId === agentId ? ' is-active' : ''}`}
              onClick={() => setFilterAgentId(agentId)}
              aria-pressed={filterAgentId === agentId}
            >
              {agentId ? memberName(members, agentId) : t(locale, 'codeBot.filter.all')}
            </button>
          ))}
          <input
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder={t(locale, 'codeBot.filter.search')}
            aria-label={t(locale, 'codeBot.filter.search')}
          />
          {filteredItems.length !== items.length ? (
            <span className="code-bot-filter-count">
              {t(locale, 'codeBot.filter.count', { shown: filteredItems.length, total: items.length })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={threadRef}
        className="code-bot-thread"
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const thread = event.currentTarget
          stickToBottomRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48
        }}
      >
        {items.length === 0 ? (
          <div className="code-bot-thread-empty">
            <p>{t(locale, 'codeBot.thread.empty')}</p>
            <ul>
              <li>{t(locale, 'codeBot.thread.example1')}</li>
              <li>{t(locale, 'codeBot.thread.example2')}</li>
            </ul>
          </div>
        ) : (
          <>
            {hiddenOlderCount > 0 ? (
              <button
                type="button"
                className="code-bot-load-older"
                onClick={() => {
                  stickToBottomRef.current = false
                  heightBeforeOlderRef.current = threadRef.current?.scrollHeight ?? null
                  setRenderLimit((limit) => limit + THREAD_PAGE_SIZE)
                }}
              >
                {t(locale, 'codeBot.thread.loadOlder', { count: hiddenOlderCount })}
              </button>
            ) : null}
            {visibleItems.map((item) => (
            <ThreadItem
              key={`${item.kind}:${item.id}`}
              item={item}
              locale={locale}
              members={members}
              onRetry={handleRetry}
              silentAgentIds={silentByMessage.get(item.id) ?? NO_AGENTS}
              onOpenTerminal={handleOpenTerminal}
            />
            ))}
          </>
        )}
      </div>

      <div className="code-bot-composer">
        {suggestions.length > 0 ? (
          <ul className="code-bot-suggestions" role="listbox">
            {suggestions.map((suggestion, index) => (
              <li key={suggestion.handle} role="option" aria-selected={index === highlight}>
                <button
                  type="button"
                  className={index === highlight ? 'is-highlighted' : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertMention(suggestion.handle)
                  }}
                >
                  <strong>@{suggestion.handle}</strong>
                  <span>{suggestion.agentId ? suggestion.label : t(locale, 'codeBot.mention.all')}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={3}
          placeholder={t(locale, 'codeBot.composer.placeholder')}
          onChange={(event) => {
            setComposerError(null)
            setDraft(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={handleKeyDown}
          aria-label={t(locale, 'codeBot.composer.placeholder')}
        />
        <div className="code-bot-composer-footer">
          {composerError ? (
            <span className="code-bot-composer-error" role="alert">
              {composerError}
            </span>
          ) : (
            <span>{recipientHint}</span>
          )}
          <button type="button" className="code-bot-primary" onClick={() => void submit()} disabled={!draft.trim()}>
            <AppIcon name="send" aria-hidden="true" />
            {t(locale, 'codeBot.composer.send')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Clipboard write that never throws: `navigator.clipboard` is undefined
 * outside a secure context, which would otherwise throw synchronously. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function CopyButton({ text, locale }: { text: string; locale: Locale }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (!text) return null
  return (
    <button
      type="button"
      className="code-bot-copy"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) setCopied(true)
        })
      }}
      title={t(locale, copied ? 'codeBot.reply.copied' : 'codeBot.reply.copy')}
      aria-label={t(locale, copied ? 'codeBot.reply.copied' : 'codeBot.reply.copy')}
    >
      <AppIcon name={copied ? 'check' : 'copy'} aria-hidden="true" />
    </button>
  )
}

/** Memoized: rows re-render only when their own data changes, not on every
 * keystroke in the composer (agent replies render Markdown, which is costly). */
const ThreadItem = memo(function ThreadItem({
  item,
  locale,
  members,
  onRetry,
  silentAgentIds,
  onOpenTerminal,
}: {
  item: CodeBotThreadItem
  locale: Locale
  members: CodeBotMember[]
  onRetry: (messageId: string, agentId: string) => void
  /** Recipients that went idle without posting a reply (see `silentRecipients`). */
  silentAgentIds: string[]
  onOpenTerminal: (agentId: string) => void
}) {
  if (item.kind === 'human') {
    return (
      <div className="code-bot-row is-human">
        <div className="code-bot-bubble is-human">
          <p className="code-bot-text">{item.text}</p>
          <div className="code-bot-deliveries">
            {item.targets.map((agentId) => {
              const delivery = item.deliveries[agentId]
              return (
                <span
                  key={agentId}
                  className={`code-bot-delivery is-${delivery?.status ?? 'sending'}`}
                  title={delivery?.detail}
                >
                  {memberName(members, agentId)} · {t(locale, DELIVERY_KEY[delivery?.status ?? 'sending'])}
                  {delivery?.status === 'failed' ? (
                    <button type="button" className="code-bot-retry" onClick={() => onRetry(item.id, agentId)}>
                      {t(locale, 'codeBot.delivery.retry')}
                    </button>
                  ) : null}
                </span>
              )
            })}
            <time>{formatTime(item.tsMs)}</time>
          </div>
        </div>
        {silentAgentIds.length > 0 ? (
          <div className="code-bot-silent-hint">
            {silentAgentIds.map((agentId) => (
              <span key={agentId}>
                {t(locale, 'codeBot.silent.hint', { name: memberName(members, agentId) })}
                <button type="button" onClick={() => onOpenTerminal(agentId)}>
                  {t(locale, 'codeBot.member.openTerminal')}
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    )
  }
  if (item.kind === 'dispatch') {
    return (
      <div className="code-bot-row is-system">
        <span className="code-bot-handoff">
          <strong className={toolClass(members, item.from)}>{memberName(members, item.from)}</strong>
          <AppIcon name="arrow-right" aria-hidden="true" />
          <strong className={toolClass(members, item.to)}>{memberName(members, item.to)}</strong>
          <span>{item.title}</span>
          <time>{formatTime(item.tsMs)}</time>
        </span>
      </div>
    )
  }
  const toSelf = item.to === item.from
  return (
    <div className="code-bot-row is-agent">
      <div className={`code-bot-avatar ${toolClass(members, item.from)}`} aria-hidden="true">
        {memberName(members, item.from).slice(0, 1)}
      </div>
      <div className={`code-bot-bubble is-agent ${toolClass(members, item.from)}`}>
        <div className="code-bot-bubble-meta">
          <strong>{memberName(members, item.from)}</strong>
          {toSelf ? null : <span>{t(locale, 'codeBot.reply.to', { name: memberName(members, item.to) })}</span>}
          {item.replyKind === 'handover' ? <span className="code-bot-tag">{t(locale, 'codeBot.reply.handover')}</span> : null}
          <time>{formatTime(item.tsMs)}</time>
          <CopyButton
            text={replyBodyToMarkdown(item, {
              blockers: t(locale, 'codeBot.reply.blockers'),
              nextSteps: t(locale, 'codeBot.reply.nextSteps'),
            })}
            locale={locale}
          />
        </div>
        <div className="code-bot-markdown">
          {item.text ? <MarkdownRenderer content={item.text} filePath="code-bot-reply.md" workspaceRoot={null} /> : null}
          {item.blockers ? (
            <div className="code-bot-reply-list is-blockers">
              <strong>{t(locale, 'codeBot.reply.blockers')}</strong>
              <ul>
                {item.blockers.map((entry, index) => (
                  <li key={index}>{entry}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {item.nextSteps ? (
            <div className="code-bot-reply-list">
              <strong>{t(locale, 'codeBot.reply.nextSteps')}</strong>
              <ul>
                {item.nextSteps.map((entry, index) => (
                  <li key={index}>{entry}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
})
