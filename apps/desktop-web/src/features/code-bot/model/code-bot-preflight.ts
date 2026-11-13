/** Pre-flight checks for Code Bot (docs/cw/22_Code_Bot規劃.md): everything
 * that must be true for "send → agent works → agent replies" to succeed,
 * with the fix the pane can offer for each. */

export type PreflightCheckId = 'gto-cli' | 'claude-skill' | 'codex-skill' | 'team'

/** What the pane can do about a failing check. */
export type PreflightFix = 'install-gto-cli' | 'install-claude-skill' | 'install-codex-skill' | 'restore-team'

export interface PreflightCheck {
  id: PreflightCheckId
  ok: boolean
  /** Extra detail from the backend (e.g. why the CLI is unusable). */
  detail?: string
  /** Installed but older than the bundled version (fix = update). */
  outdated?: boolean
  fix?: PreflightFix
}

export interface PreflightInputs {
  /** `null` when the status could not be read. */
  gtoCli: { installed: boolean; nodeReady: boolean; issue?: string | null } | null
  claudeSkill: { installed: boolean; outdated?: boolean } | null
  codexSkill: { installed: boolean; outdated?: boolean } | null
  teamMemberCount: number
  teamSize: number
}

/** A skill passes only when installed and current: an outdated copy lacks
 * newer instructions (such as the Code Bot reply convention). Reinstalling
 * fixes both cases. */
function skillCheck(
  id: 'claude-skill' | 'codex-skill',
  status: { installed: boolean; outdated?: boolean } | null,
  fix: 'install-claude-skill' | 'install-codex-skill',
): PreflightCheck {
  const ok = Boolean(status?.installed && !status.outdated)
  return { id, ok, outdated: Boolean(status?.installed && status.outdated), fix: ok ? undefined : fix }
}

/** Agents reply and hand off through the `gto` CLI and learn how from the
 * `gto-agent-communication` skill, so both must be in place, as must the
 * two team members. */
export function buildPreflightChecks(inputs: PreflightInputs): PreflightCheck[] {
  const cliOk = Boolean(inputs.gtoCli?.installed && inputs.gtoCli.nodeReady)
  return [
    {
      id: 'gto-cli',
      ok: cliOk,
      detail: cliOk ? undefined : inputs.gtoCli?.issue ?? undefined,
      fix: cliOk ? undefined : 'install-gto-cli',
    },
    skillCheck('claude-skill', inputs.claudeSkill, 'install-claude-skill'),
    skillCheck('codex-skill', inputs.codexSkill, 'install-codex-skill'),
    {
      id: 'team',
      ok: inputs.teamMemberCount >= inputs.teamSize,
      fix: inputs.teamMemberCount >= inputs.teamSize ? undefined : 'restore-team',
    },
  ]
}

export function failingChecks(checks: PreflightCheck[]): PreflightCheck[] {
  return checks.filter((check) => !check.ok)
}
