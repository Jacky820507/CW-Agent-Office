/** A Code Bot team member as the composer sees it (docs/cw/22_Code_Bot規劃.md, P2). */
export interface CodeBotMember {
  agentId: string
  name: string
  /** `claude` or `codex` — also usable as a mention handle (`@codex`). */
  tool: string
}

export const CODE_BOT_ALL_HANDLE = 'all'

const MENTION_PATTERN = /(^|[\s(（，,、])@([\p{L}\p{N}_.-]+)/gu

function handleKeys(member: CodeBotMember): string[] {
  return [member.tool, member.name, member.agentId].map((value) => value.trim().toLowerCase()).filter(Boolean)
}

/** The handle the composer inserts for a member: its tool when unique on the
 * team (`@codex`), otherwise its agent id, which always is. */
export function preferredHandle(member: CodeBotMember, members: CodeBotMember[]): string {
  const sameTool = members.filter((other) => other.tool === member.tool).length
  return sameTool === 1 ? member.tool : member.agentId
}

/** Agent ids addressed by `@handle`s in `text`, in team order, deduplicated.
 * `@all` addresses everyone. Unknown handles are ignored (so an email-like
 * `a@b` or a stray `@foo` never sends anywhere). */
export function resolveMentionTargets(text: string, members: CodeBotMember[]): string[] {
  const addressed = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    // "請 @codex." / "@claude-": trailing punctuation is not part of the handle.
    const handle = match[2].toLowerCase().replace(/[.-]+$/, '')
    if (handle === CODE_BOT_ALL_HANDLE) {
      return members.map((member) => member.agentId)
    }
    for (const member of members) {
      if (handleKeys(member).includes(handle)) {
        addressed.add(member.agentId)
      }
    }
  }
  return members.filter((member) => addressed.has(member.agentId)).map((member) => member.agentId)
}

/** Who receives a message. Mentions at the very start ("@claude @codex …")
 * name the recipients; any later mention is left in the text as an
 * instruction for them — "@claude build X, then @codex reviews it" goes to
 * Claude only, and Claude delegates. Without leading mentions, every mention
 * in the text is a recipient. Returns `[]` when nothing is addressed, so the
 * caller can fall back to the last recipient. */
export function resolveRecipients(text: string, members: CodeBotMember[]): string[] {
  const leading = /^\s*((?:@[\p{L}\p{N}_.-]+[\s,，、]*)+)/u.exec(text)
  if (leading) {
    const recipients = resolveMentionTargets(leading[1], members)
    if (recipients.length > 0) return recipients
  }
  return resolveMentionTargets(text, members)
}

/** Handles that always mean a Code Bot member, even after it was deleted. */
const CODE_BOT_HANDLES = ['claude', 'codex', 'codebot-claude', 'codebot-codex']

/** Code Bot handles mentioned in `text` whose agent is not on the team
 * (e.g. deleted on agent-canvas). Sending would otherwise silently fall back
 * to another recipient. Unrelated `@names` are not reported. */
export function missingMemberMentions(text: string, members: CodeBotMember[]): string[] {
  const missing = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[2].toLowerCase().replace(/[.-]+$/, '')
    if (!CODE_BOT_HANDLES.includes(handle)) continue
    if (!members.some((member) => handleKeys(member).includes(handle))) missing.add(handle)
  }
  return [...missing]
}

export interface ActiveMention {
  /** Index of the `@` character. */
  start: number
  /** Text typed after `@` up to the caret. */
  query: string
}

/** The `@partial` the caret is currently inside, if any — drives the
 * autocomplete popup. */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null
  const before = text.slice(0, caret)
  const match = /(^|[\s(（，,、])@([\p{L}\p{N}_.-]*)$/u.exec(before)
  if (!match) return null
  const query = match[2]
  return { start: caret - query.length - 1, query }
}

export interface MentionSuggestion {
  handle: string
  label: string
  agentId: string | null
}

export function mentionSuggestions(query: string, members: CodeBotMember[]): MentionSuggestion[] {
  const needle = query.toLowerCase()
  const suggestions: MentionSuggestion[] = members.map((member) => ({
    handle: preferredHandle(member, members),
    label: member.name,
    agentId: member.agentId,
  }))
  if (members.length > 1) {
    // The UI shows its own translated label when agentId is null.
    suggestions.push({ handle: CODE_BOT_ALL_HANDLE, label: CODE_BOT_ALL_HANDLE, agentId: null })
  }
  return suggestions.filter(
    (suggestion) =>
      suggestion.handle.toLowerCase().startsWith(needle) || suggestion.label.toLowerCase().startsWith(needle),
  )
}

/** Replaces the active `@partial` with `@handle ` and returns the new text
 * and caret position. */
export function applyMention(text: string, mention: ActiveMention, handle: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length
  const inserted = `@${handle} `
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(end),
    caret: mention.start + inserted.length,
  }
}
