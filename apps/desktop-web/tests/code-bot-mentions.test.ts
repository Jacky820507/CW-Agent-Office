import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMention,
  findActiveMention,
  mentionSuggestions,
  missingMemberMentions,
  resolveRecipients,
  type CodeBotMember,
} from '../src/features/code-bot/model/code-bot-mentions.js'

const members: CodeBotMember[] = [
  { agentId: 'codebot-claude', name: 'Claude', tool: 'claude' },
  { agentId: 'codebot-codex', name: 'Codex', tool: 'codex' },
]

test('leading mentions pick recipients; later mentions stay instructions', () => {
  assert.deepEqual(resolveRecipients('@claude 實作 X，寫完 @codex review', members), ['codebot-claude'])
  assert.deepEqual(resolveRecipients('@claude @codex 各自看看', members), ['codebot-claude', 'codebot-codex'])
})

test('without leading mentions every mention is a recipient', () => {
  assert.deepEqual(resolveRecipients('幫我 review @codex', members), ['codebot-codex'])
})

test('@all, case-insensitive handles, and non-mentions', () => {
  assert.deepEqual(resolveRecipients('@all 說明目錄', members), ['codebot-claude', 'codebot-codex'])
  assert.deepEqual(resolveRecipients('@Codex，幫忙', members), ['codebot-codex'])
  assert.deepEqual(resolveRecipients('寄信給 a@codex.com', members), [])
  assert.deepEqual(resolveRecipients('沒有提到任何人', members), [])
})

test('trailing punctuation does not break a mention', () => {
  assert.deepEqual(resolveRecipients('請 @codex.', members), ['codebot-codex'])
  assert.deepEqual(resolveRecipients('@claude- 幫忙', members), ['codebot-claude'])
})

test('mentions of a deleted team member are reported, other names are not', () => {
  const codexOnly = members.filter((member) => member.tool === 'codex')
  assert.deepEqual(missingMemberMentions('@claude 幫忙', codexOnly), ['claude'])
  assert.deepEqual(missingMemberMentions('@codex 幫忙', codexOnly), [])
  assert.deepEqual(missingMemberMentions('@octocat 你好', codexOnly), [])
})

test('a negative or out-of-range caret has no active mention', () => {
  assert.equal(findActiveMention('@co', -1), null)
  assert.equal(findActiveMention('@co', 10), null)
})

test('autocomplete finds the partial mention and replaces it', () => {
  const mention = findActiveMention('請 @co', 5)
  assert.deepEqual(mention, { start: 2, query: 'co' })
  assert.deepEqual(
    mentionSuggestions(mention!.query, members).map((suggestion) => suggestion.handle),
    ['codex'],
  )
  assert.deepEqual(applyMention('請 @co', mention!, 'codex'), { text: '請 @codex ', caret: 9 })
})
