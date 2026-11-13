import { useEffect, useLayoutEffect, useRef } from 'react'
import { t, type Locale } from '@shell/i18n/ui-locale'
import { desktopApi, type ChannelMessagePayload } from '@shell/integration/desktop-api'
import { addNotification } from '@/stores/notification'
import { CODE_BOT_AGENT_IDS } from './useCodeBot'
import { channelMessageToThreadItem } from '../model/code-bot-thread'

const TEAM = new Set<string>(CODE_BOT_AGENT_IDS)
const PREVIEW_CHARS = 80

/** Agent names by id for the workspace, refreshed whenever a notification is
 * about to be shown, so a renamed agent is announced by its new name. */
async function loadAgentNames(workspaceId: string): Promise<Record<string, string>> {
  try {
    const response = await desktopApi.agentList(workspaceId)
    return Object.fromEntries(response.agents.map((agent) => [agent.id, agent.name]))
  } catch {
    return {}
  }
}

/** Shows a toast when a Code Bot agent replies to the thread while the
 * Code Bot pane is hidden. (The pane stays mounted and records the reply
 * itself; this hook only tells the user something arrived.) */
export function useCodeBotReplyNotifier(locale: Locale, workspaceId: string | null, paneVisible: boolean) {
  const paneVisibleRef = useRef(paneVisible)
  const localeRef = useRef(locale)
  useLayoutEffect(() => {
    paneVisibleRef.current = paneVisible
    localeRef.current = locale
  })

  useEffect(() => {
    if (!workspaceId) return
    let disposed = false
    let unlisten: (() => void) | null = null
    const onMessage = (message: ChannelMessagePayload) => {
      if (paneVisibleRef.current || message.workspaceId !== workspaceId) return
      const item = channelMessageToThreadItem(message, TEAM)
      // Only replies meant for the user: agent-to-agent traffic stays quiet.
      if (!item || item.kind !== 'reply' || item.to !== item.from) return
      // Only Code Bot conversations (ids from newConversationId), not an
      // agent's self-reports from other task-center flows.
      if (!item.conversationId?.startsWith('cb-')) return
      const preview = item.text.replace(/\s+/g, ' ').trim()
      void loadAgentNames(workspaceId).then((names) => {
        if (disposed) return
        addNotification({
          type: 'info',
          message: t(localeRef.current, 'codeBot.notify.reply', {
            name: names[item.from] ?? item.from,
            text: preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS)}…` : preview,
          }),
          duration: 8000,
        })
      })
    }
    desktopApi
      .subscribeChannelEvents({ onMessage, onAck: () => {}, onDispatchProgress: () => {} })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [workspaceId])
}
