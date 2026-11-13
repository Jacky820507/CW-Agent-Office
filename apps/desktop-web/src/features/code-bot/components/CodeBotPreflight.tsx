import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t, type Locale, type TranslationKey } from '@shell/i18n/ui-locale'
import { AppIcon } from '@shell/ui/icons'
import { desktopApi } from '@shell/integration/desktop-api'
import {
  buildPreflightChecks,
  failingChecks,
  type PreflightCheck,
  type PreflightCheckId,
  type PreflightFix,
  type PreflightInputs,
} from '../model/code-bot-preflight'

const CHECK_LABEL: Record<PreflightCheckId, TranslationKey> = {
  'gto-cli': 'codeBot.preflight.gtoCli',
  'claude-skill': 'codeBot.preflight.claudeSkill',
  'codex-skill': 'codeBot.preflight.codexSkill',
  team: 'codeBot.preflight.team',
}

const FIX_LABEL: Record<PreflightFix, TranslationKey> = {
  'install-gto-cli': 'codeBot.preflight.install',
  'install-claude-skill': 'codeBot.preflight.install',
  'install-codex-skill': 'codeBot.preflight.install',
  'restore-team': 'codeBot.team.restore',
}

interface CodeBotPreflightProps {
  locale: Locale
  active: boolean
  teamMemberCount: number
  teamSize: number
  onRestoreTeam: () => Promise<void>
}

async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/** Header chip + expandable checklist: is everything in place for agents to
 * hand off and reply? Mirrors the "重新檢查" control of the dashboard the
 * feature was modelled on. */
export function CodeBotPreflight({ locale, active, teamMemberCount, teamSize, onRestoreTeam }: CodeBotPreflightProps) {
  // Only the fetched statuses live in state; the checklist is derived at
  // render time from the latest team count, so a team change needs no new
  // requests and can never be overwritten by an older response.
  const [statuses, setStatuses] = useState<Omit<PreflightInputs, 'teamMemberCount' | 'teamSize'> | null>(null)
  const [checking, setChecking] = useState(false)
  const [fixing, setFixing] = useState<PreflightFix | null>(null)
  const [open, setOpen] = useState(false)
  const requestSeqRef = useRef(0)

  const runChecks = useCallback(async () => {
    if (!desktopApi.isTauriRuntime()) return
    const seq = ++requestSeqRef.current
    setChecking(true)
    const [gtoCli, claudeSkill, codexSkill] = await Promise.all([
      readOrNull(() => desktopApi.systemGtoCliStatus()),
      readOrNull(() => desktopApi.systemGtoSkillStatus('claude')),
      readOrNull(() => desktopApi.systemGtoSkillStatus('codex')),
    ])
    // A newer run started meanwhile: its result wins.
    if (seq !== requestSeqRef.current) return
    setStatuses({ gtoCli, claudeSkill, codexSkill })
    setChecking(false)
  }, [])

  // Check whenever the pane is shown.
  useEffect(() => {
    if (active) void runChecks()
  }, [active, runChecks])

  const checks: PreflightCheck[] | null = useMemo(
    () => (statuses ? buildPreflightChecks({ ...statuses, teamMemberCount, teamSize }) : null),
    [statuses, teamMemberCount, teamSize],
  )

  const applyFix = useCallback(
    async (fix: PreflightFix) => {
      setFixing(fix)
      try {
        if (fix === 'install-gto-cli') await desktopApi.systemGtoCliInstall()
        else if (fix === 'install-claude-skill') await desktopApi.systemGtoSkillInstall('claude')
        else if (fix === 'install-codex-skill') await desktopApi.systemGtoSkillInstall('codex')
        else await onRestoreTeam()
      } catch (error) {
        window.alert(`${t(locale, 'codeBot.preflight.fixFailed')}: ${String(error)}`)
      } finally {
        setFixing(null)
        await runChecks()
      }
    },
    [locale, onRestoreTeam, runChecks],
  )

  if (!checks) return null
  const failing = failingChecks(checks)

  return (
    <div className="code-bot-preflight">
      <button
        type="button"
        className={`code-bot-preflight-chip${failing.length > 0 ? ' is-warn' : ' is-ok'}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={t(locale, 'codeBot.preflight.title')}
      >
        <AppIcon name={failing.length > 0 ? 'alert-triangle' : 'check-circle'} aria-hidden="true" />
        {failing.length > 0
          ? t(locale, 'codeBot.preflight.failing', { count: failing.length })
          : t(locale, 'codeBot.preflight.ok')}
      </button>
      {open ? (
        <div className="code-bot-preflight-panel" role="dialog" aria-label={t(locale, 'codeBot.preflight.title')}>
          <ul>
            {checks.map((check) => (
              <li key={check.id} className={check.ok ? 'is-ok' : 'is-warn'}>
                <AppIcon name={check.ok ? 'check' : 'alert-circle'} aria-hidden="true" />
                <span>
                  {t(locale, CHECK_LABEL[check.id])}
                  {check.detail ? <small>{check.detail}</small> : null}
                  {check.outdated ? <small>{t(locale, 'codeBot.preflight.outdated')}</small> : null}
                </span>
                {check.fix ? (
                  <button
                    type="button"
                    onClick={() => void applyFix(check.fix!)}
                    disabled={fixing !== null}
                  >
                    {fixing === check.fix
                      ? t(locale, 'agentCanvas.codeBot.working')
                      : t(locale, check.outdated ? 'codeBot.preflight.update' : FIX_LABEL[check.fix])}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <button type="button" className="code-bot-preflight-recheck" onClick={() => void runChecks()} disabled={checking}>
            <AppIcon name="refresh" aria-hidden="true" />
            {t(locale, checking ? 'codeBot.preflight.checking' : 'codeBot.preflight.recheck')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
