import test from 'node:test'
import assert from 'node:assert/strict'
import {
  channelMessageToThreadItem,
  filterThreadItems,
  mergeThreadItems,
  settleInterruptedDeliveries,
  silentRecipients,
  SILENT_AGENT_AFTER_MS,
  threadToMarkdown,
  type CodeBotThreadItem,
} from '../src/features/code-bot/model/code-bot-thread.js'
import { recentFlows, summarizeThread } from '../src/features/code-bot/model/code-bot-dashboard.js'

const team = new Set(['codebot-claude', 'codebot-codex'])

function message(overrides: Record<string, unknown>) {
  return {
    workspaceId: 'ws',
    channelId: 'direct://x',
    messageId: 'm1',
    seq: 1,
    senderAgentId: 'codebot-claude',
    targetAgentId: 'codebot-codex',
    type: 'task_instruction' as const,
    payload: { title: 'Review README', taskId: 't1' },
    tsMs: 1000,
    ...overrides,
  }
}

test('agent dispatches become hand-off items; human instructions are skipped', () => {
  const item = channelMessageToThreadItem(message({}), team)
  assert.equal(item?.kind, 'dispatch')
  assert.equal(channelMessageToThreadItem(message({ senderAgentId: null }), team), null)
})

test('status and handover become replies with readable text', () => {
  const status = channelMessageToThreadItem(
    message({ type: 'status', targetAgentId: 'codebot-claude', payload: { taskId: 'cb-1', detail: '完成' } }),
    team,
  )
  assert.equal(status?.kind, 'reply')
  assert.equal(status?.kind === 'reply' ? status.text : '', '完成')
  const handover = channelMessageToThreadItem(
    message({ type: 'handover', payload: { summary: 'Done', blockers: ['none yet'], nextSteps: [] } }),
    team,
  )
  assert.equal(handover?.kind === 'reply' ? handover.text : '', 'Done')
  assert.deepEqual(handover?.kind === 'reply' ? handover.blockers : undefined, ['none yet'])
  assert.equal(handover?.kind === 'reply' ? handover.nextSteps : 'absent', undefined)
})

test('deliveries cut off mid-send become retryable failures', () => {
  const settled = settleInterruptedDeliveries({
    kind: 'human',
    id: 'cb-2',
    tsMs: 1,
    text: 'x',
    targets: ['codebot-claude', 'codebot-codex'],
    deliveries: { 'codebot-claude': { status: 'sending' }, 'codebot-codex': { status: 'sent' } },
  })
  assert.deepEqual(settled.deliveries, {
    'codebot-claude': { status: 'failed', detail: 'INTERRUPTED' },
    'codebot-codex': { status: 'sent' },
  })
})

test('idle recipients without a thread reply are flagged as silent', () => {
  const human = {
    kind: 'human' as const,
    id: 'cb-3',
    tsMs: 0,
    text: 'x',
    targets: ['codebot-claude', 'codebot-codex'],
    deliveries: { 'codebot-claude': { status: 'sent' as const }, 'codebot-codex': { status: 'sent' as const } },
  }
  const reply = channelMessageToThreadItem(
    message({
      type: 'status',
      senderAgentId: 'codebot-codex',
      targetAgentId: 'codebot-codex',
      payload: { taskId: 'cb-3', detail: 'ok' },
    }),
    team,
  )!
  const later = SILENT_AGENT_AFTER_MS + 1
  const hasReplied = (agentId: string, conversationId: string) =>
    reply.kind === 'reply' && reply.from === agentId && reply.conversationId === conversationId
  assert.deepEqual(silentRecipients(human, hasReplied, () => true, later), ['codebot-claude'])
  assert.deepEqual(silentRecipients(human, hasReplied, () => true, 10), [])
  assert.deepEqual(silentRecipients(human, hasReplied, () => false, later), [])
})

test('thread exports to readable Markdown in order', () => {
  const human = {
    kind: 'human' as const,
    id: 'cb-9',
    tsMs: new Date(2026, 10, 12, 10, 0).getTime(),
    text: '@claude hi',
    targets: ['codebot-claude'],
    deliveries: {},
  }
  const dispatch = channelMessageToThreadItem(message({ tsMs: new Date(2026, 10, 12, 10, 1).getTime() }), team)!
  const names: Record<string, string> = { 'codebot-claude': 'Claude', 'codebot-codex': 'Codex' }
  const markdown = threadToMarkdown([human, dispatch], (id) => names[id] ?? id, {
    title: 'Code Bot',
    you: 'You',
    handoff: 'Hand-off',
    blockers: 'Blockers',
    nextSteps: 'Next steps',
  })
  assert.match(markdown, /^# Code Bot\n/)
  assert.match(markdown, /\*\*You → Claude\*\* · 2026-11-12 10:00\n\n@claude hi/)
  assert.match(markdown, /> Hand-off: Claude → Codex — Review README/)
  assert.ok(markdown.indexOf('@claude hi') < markdown.indexOf('Hand-off'))
})

test('messages outside the team are ignored', () => {
  assert.equal(
    channelMessageToThreadItem(message({ senderAgentId: 'other', targetAgentId: 'another' }), team),
    null,
  )
})

test('merge dedupes by id and sorts by time; dashboard summarizes it', () => {
  const human: CodeBotThreadItem = {
    kind: 'human',
    id: 'cb-1',
    tsMs: 500,
    text: '@claude hi',
    targets: ['codebot-claude'],
    deliveries: { 'codebot-claude': { status: 'failed', detail: 'AGENT_OFFLINE' } },
  }
  const dispatch = channelMessageToThreadItem(message({}), team)!
  const merged = mergeThreadItems([dispatch], [human, dispatch])
  assert.deepEqual(
    merged.map((item) => item.id),
    ['cb-1', 'm1'],
  )
  const summary = summarizeThread(merged, [
    { agentId: 'codebot-claude', name: 'Claude', tool: 'claude' },
    { agentId: 'codebot-codex', name: 'Codex', tool: 'codex' },
  ], { 'codebot-claude': 'idle' })
  assert.deepEqual(summary, { online: 1, total: 2, messages: 2, attention: 1 })
  assert.deepEqual([...recentFlows(merged, 0)].sort(), ['claude->codex', 'you->claude'])
  assert.deepEqual([...recentFlows(merged, 600)], ['claude->codex'])

  assert.equal(filterThreadItems(merged, 'codebot-codex', '').length, 1)
  assert.equal(filterThreadItems(merged, 'codebot-claude', '').length, 2)
  assert.deepEqual(
    filterThreadItems(merged, null, 'readme').map((item) => item.id),
    ['m1'],
  )
  assert.equal(filterThreadItems(merged, null, '').length, 2)
})
