import type { AgentRuntimeState } from '@shell/integration/desktop-api'
import type { CodeBotMember } from './code-bot-mentions'
import type { CodeBotThreadItem } from './code-bot-thread'

export interface CodeBotThreadSummary {
  online: number
  total: number
  messages: number
  /** Failed deliveries — things the user should look at. */
  attention: number
}

export function summarizeThread(
  items: CodeBotThreadItem[],
  members: CodeBotMember[],
  runtimeStates: Record<string, AgentRuntimeState>,
): CodeBotThreadSummary {
  const online = members.filter((member) => {
    const state = runtimeStates[member.agentId]
    return state === 'idle' || state === 'active'
  }).length
  const attention = items.reduce(
    (count, item) =>
      item.kind === 'human'
        ? count + Object.values(item.deliveries).filter((delivery) => delivery.status === 'failed').length
        : count,
    0,
  )
  return { online, total: members.length, messages: items.length, attention }
}

export type FlowKey = 'you->claude' | 'you->codex' | 'claude->codex' | 'codex->claude'

function toolOf(agentId: string): 'claude' | 'codex' | null {
  if (agentId.includes('claude')) return 'claude'
  if (agentId.includes('codex')) return 'codex'
  return null
}

/** Flow lines that carried a message at or after `sinceMs`. Agent replies
 * addressed to themselves (thread replies) don't light a line. */
export function recentFlows(items: CodeBotThreadItem[], sinceMs: number): Set<FlowKey> {
  const flows = new Set<FlowKey>()
  for (const item of items) {
    if (item.tsMs < sinceMs) continue
    if (item.kind === 'human') {
      for (const target of item.targets) {
        const tool = toolOf(target)
        if (tool) flows.add(`you->${tool}`)
      }
      continue
    }
    const from = toolOf(item.from)
    const to = toolOf(item.to)
    if (from && to && from !== to) flows.add(`${from}->${to}` as FlowKey)
  }
  return flows
}
