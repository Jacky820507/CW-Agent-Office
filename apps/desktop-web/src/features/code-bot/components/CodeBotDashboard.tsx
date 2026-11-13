import { useEffect, useMemo, useRef, useState } from 'react'
import { t, type Locale } from '@shell/i18n/ui-locale'
import {
  desktopApi,
  type AgentRuntimeState,
  type CodeBotCollaborationGuardSnapshot,
  type SystemMetricsSnapshot,
} from '@shell/integration/desktop-api'
import type { CodeBotMember } from '../model/code-bot-mentions'
import type { CodeBotThreadItem } from '../model/code-bot-thread'
import { summarizeThread, recentFlows, type FlowKey } from '../model/code-bot-dashboard'

const METRICS_POLL_MS = 3000
/** A flow line animates while it carried a message this recently. */
const LIVE_FLOW_MS = 20000

interface CodeBotDashboardProps {
  locale: Locale
  active: boolean
  members: CodeBotMember[]
  runtimeStates: Record<string, AgentRuntimeState>
  items: CodeBotThreadItem[]
  guard: CodeBotCollaborationGuardSnapshot | null
  /** Changes the workspace's hand-off limit (−/+ on the hand-off tile). */
  onSetHopLimit?: (limit: number) => Promise<void>
}

/** Mirrors `MAX_AGENT_HOP_LIMIT` in crates/gt-task/src/collaboration_guard.rs. */
const MIN_HOP_LIMIT = 1
const MAX_HOP_LIMIT = 20

const GIB = 1024 ** 3

function formatGib(bytes: number | null | undefined): string {
  return bytes == null ? '—' : (bytes / GIB).toFixed(1)
}

function percentOf(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || total <= 0) return null
  return (used / total) * 100
}

function useSystemMetrics(active: boolean): SystemMetricsSnapshot | null {
  const [metrics, setMetrics] = useState<SystemMetricsSnapshot | null>(null)
  useEffect(() => {
    if (!active || !desktopApi.isTauriRuntime()) return
    let disposed = false
    const poll = () => {
      void desktopApi
        .systemMetricsSnapshot()
        .then((snapshot) => {
          if (!disposed) setMetrics(snapshot)
        })
        .catch(() => {})
    }
    poll()
    const timer = window.setInterval(poll, METRICS_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [active])
  return metrics
}

/** Re-renders every few seconds so "live" flow lines fade out on time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function ResourceCard({
  label,
  value,
  unit,
  percent,
  caption,
  tone,
}: {
  label: string
  value: string
  unit?: string
  percent: number | null
  caption: string
  tone: 'cpu' | 'memory' | 'gpu' | 'vram'
}) {
  return (
    <div className={`code-bot-resource is-${tone}`}>
      <span className="code-bot-resource-label">{label}</span>
      <strong>
        {value}
        {unit ? <small>{unit}</small> : null}
      </strong>
      <div className="code-bot-meter" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
      </div>
      <span className="code-bot-resource-caption">{caption}</span>
    </div>
  )
}

export function CodeBotDashboard({
  locale,
  active,
  members,
  runtimeStates,
  items,
  guard,
  onSetHopLimit,
}: CodeBotDashboardProps) {
  const metrics = useSystemMetrics(active)
  const now = useNow(active)
  const summary = useMemo(() => summarizeThread(items, members, runtimeStates), [items, members, runtimeStates])
  const live = useMemo(() => recentFlows(items, now - LIVE_FLOW_MS), [items, now])
  const unavailable = t(locale, 'codeBot.dash.unavailable')
  // One change at a time: a second click before the first returns would
  // otherwise send the same new value twice.
  // The ref blocks a second click in the same tick (state would still read
  // false until re-render); the state only drives the disabled look.
  const limitPendingRef = useRef(false)
  const [limitPending, setLimitPending] = useState(false)
  const changeLimit = (limit: number) => {
    if (!onSetHopLimit || limitPendingRef.current) return
    limitPendingRef.current = true
    setLimitPending(true)
    onSetHopLimit(limit)
      .catch(() => {})
      .finally(() => {
        limitPendingRef.current = false
        setLimitPending(false)
      })
  }
  // Failed deliveries, plus one when agent collaboration is stopped (paused
  // or at its limit) — both need the user to act.
  const attention = summary.attention + (guard && (guard.paused || guard.hopLimitReached) ? 1 : 0)

  const claude = members.find((member) => member.tool === 'claude')
  const codex = members.find((member) => member.tool === 'codex')
  const stateOf = (member: CodeBotMember | undefined) => (member ? runtimeStates[member.agentId] ?? 'offline' : 'offline')
  const flowClass = (key: FlowKey) => `code-bot-flow-line${live.has(key) ? ' is-live' : ''}`
  const memoryPercent = percentOf(metrics?.memoryUsedBytes, metrics?.memoryTotalBytes)
  const vramPercent = percentOf(metrics?.gpu?.memoryUsedBytes, metrics?.gpu?.memoryTotalBytes)

  return (
    <section className="code-bot-dashboard" aria-label={t(locale, 'codeBot.dash.title')}>
      <div className="code-bot-kpis">
        <div className="code-bot-kpi is-ok">
          <strong>
            {summary.online}
            <small>/{summary.total}</small>
          </strong>
          <span>{t(locale, 'codeBot.dash.online')}</span>
        </div>
        <div className="code-bot-kpi">
          <strong>{summary.messages}</strong>
          <span>{t(locale, 'codeBot.dash.messages')}</span>
        </div>
        <div className="code-bot-kpi">
          <strong>
            {guard?.agentHops ?? 0}
            <small>/{guard?.hopLimit ?? '—'}</small>
          </strong>
          <span className="code-bot-kpi-row">
            {t(locale, 'codeBot.dash.handoffs')}
            {guard && onSetHopLimit ? (
              <span className="code-bot-stepper" role="group" aria-label={t(locale, 'codeBot.dash.hopLimit')}>
                <button
                  type="button"
                  onClick={() => changeLimit(guard.hopLimit - 1)}
                  disabled={limitPending || guard.hopLimit <= MIN_HOP_LIMIT}
                  aria-label={t(locale, 'codeBot.dash.hopLimitDown')}
                  title={t(locale, 'codeBot.dash.hopLimitDown')}
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => changeLimit(guard.hopLimit + 1)}
                  disabled={limitPending || guard.hopLimit >= MAX_HOP_LIMIT}
                  aria-label={t(locale, 'codeBot.dash.hopLimitUp')}
                  title={t(locale, 'codeBot.dash.hopLimitUp')}
                >
                  +
                </button>
              </span>
            ) : null}
          </span>
        </div>
        <div className={`code-bot-kpi${attention > 0 ? ' is-alert' : ''}`}>
          <strong>{attention}</strong>
          <span>{t(locale, 'codeBot.dash.attention')}</span>
        </div>
      </div>

      <div className="code-bot-flow" aria-hidden="true">
        <span className="code-bot-flow-caption">{t(locale, 'codeBot.dash.flow')}</span>
        <svg viewBox="0 0 400 120" preserveAspectRatio="xMidYMid meet">
          <path className={flowClass('you->claude')} d="M60 60 C 120 60, 140 28, 200 28" />
          <path className={flowClass('you->codex')} d="M60 60 C 120 60, 140 92, 200 92" />
          <path className={flowClass('claude->codex')} d="M216 36 C 300 36, 300 84, 216 84" />
          <path className={flowClass('codex->claude')} d="M216 84 C 340 92, 340 28, 216 36" />
          <g className="code-bot-flow-node is-you">
            <circle cx="48" cy="60" r="16" />
            <text x="48" y="96">{t(locale, 'codeBot.dash.you')}</text>
          </g>
          <g className={`code-bot-flow-node is-claude is-${stateOf(claude)}`}>
            <circle cx="208" cy="28" r="14" />
            <text x="208" y="10">{claude?.name ?? 'Claude'}</text>
          </g>
          <g className={`code-bot-flow-node is-codex is-${stateOf(codex)}`}>
            <circle cx="208" cy="92" r="14" />
            <text x="208" y="118">{codex?.name ?? 'Codex'}</text>
          </g>
        </svg>
      </div>

      <div className="code-bot-resources">
        <ResourceCard
          tone="cpu"
          label="CPU"
          value={metrics?.cpuPercent == null ? '—' : String(Math.round(metrics.cpuPercent))}
          unit={metrics?.cpuPercent == null ? undefined : '%'}
          percent={metrics?.cpuPercent ?? null}
          caption={metrics?.cpuPercent == null ? unavailable : t(locale, 'codeBot.dash.cpuCaption')}
        />
        <ResourceCard
          tone="memory"
          label={t(locale, 'codeBot.dash.memory')}
          value={memoryPercent == null ? '—' : String(Math.round(memoryPercent))}
          unit={memoryPercent == null ? undefined : '%'}
          percent={memoryPercent}
          caption={
            memoryPercent == null
              ? unavailable
              : `${formatGib(metrics?.memoryUsedBytes)} / ${formatGib(metrics?.memoryTotalBytes)} GB`
          }
        />
        <ResourceCard
          tone="gpu"
          label="GPU"
          value={metrics?.gpu?.utilizationPercent == null ? '—' : String(Math.round(metrics.gpu.utilizationPercent))}
          unit={metrics?.gpu?.utilizationPercent == null ? undefined : '%'}
          percent={metrics?.gpu?.utilizationPercent ?? null}
          caption={
            metrics?.gpu
              ? `${metrics.gpu.name}${metrics.gpu.temperatureC == null ? '' : ` · ${Math.round(metrics.gpu.temperatureC)}°C`}`
              : t(locale, 'codeBot.dash.noGpu')
          }
        />
        <ResourceCard
          tone="vram"
          label={t(locale, 'codeBot.dash.vram')}
          value={formatGib(metrics?.gpu?.memoryUsedBytes)}
          unit={metrics?.gpu?.memoryTotalBytes == null ? undefined : `/${formatGib(metrics.gpu.memoryTotalBytes)}G`}
          percent={vramPercent}
          caption={metrics?.gpu ? t(locale, 'codeBot.dash.vramCaption') : t(locale, 'codeBot.dash.noGpu')}
        />
      </div>
    </section>
  )
}
