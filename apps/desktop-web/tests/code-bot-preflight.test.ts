import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPreflightChecks, failingChecks } from '../src/features/code-bot/model/code-bot-preflight.js'

const healthy = {
  gtoCli: { installed: true, nodeReady: true, issue: null },
  claudeSkill: { installed: true },
  codexSkill: { installed: true },
  teamMemberCount: 2,
  teamSize: 2,
}

test('a healthy setup has no failing checks', () => {
  assert.deepEqual(failingChecks(buildPreflightChecks(healthy)), [])
})

test('each problem maps to its own fix', () => {
  const checks = buildPreflightChecks({
    gtoCli: { installed: true, nodeReady: false, issue: 'node not found' },
    claudeSkill: { installed: false },
    codexSkill: null,
    teamMemberCount: 1,
    teamSize: 2,
  })
  assert.deepEqual(
    failingChecks(checks).map((check) => [check.id, check.fix]),
    [
      ['gto-cli', 'install-gto-cli'],
      ['claude-skill', 'install-claude-skill'],
      ['codex-skill', 'install-codex-skill'],
      ['team', 'restore-team'],
    ],
  )
  assert.equal(checks[0].detail, 'node not found')
})

test('an outdated managed skill fails and is offered as an update', () => {
  const checks = buildPreflightChecks({ ...healthy, codexSkill: { installed: true, outdated: true } })
  const codex = checks.find((check) => check.id === 'codex-skill')
  assert.equal(codex?.ok, false)
  assert.equal(codex?.outdated, true)
  assert.equal(codex?.fix, 'install-codex-skill')
  assert.equal(checks.find((check) => check.id === 'claude-skill')?.outdated, false)
})

test('an unreadable status counts as failing, not as passing', () => {
  const checks = buildPreflightChecks({ ...healthy, gtoCli: null })
  assert.equal(checks.find((check) => check.id === 'gto-cli')?.ok, false)
})
