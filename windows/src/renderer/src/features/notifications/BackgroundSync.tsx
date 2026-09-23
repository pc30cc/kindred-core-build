import { useEffect, useRef } from 'react'
import { api } from '@/api/client'
import type { Conversation, NotificationPrefs } from '@/api/types'
import { isRTL, translate } from '@/i18n'
import { useApp, colleaguesVisible } from '@/store/app'
import { usePoll } from '@/hooks/usePoll'
import { attachmentPreview, contactName, parseDate, preview } from '@/lib/format'
import { viewing } from '@/features/chat/status'
import { colleagueName, refreshColleagues, useColleagues } from '@/features/colleagues/colleaguesStore'
import { reloadAvailability } from '@/features/settings/useAvailability'
import { INBOX_EVENT, useInboxRealtime } from './realtime'

// On a phone the server pushes. On Windows there is no APNs to push through, so
// the app listens on the workspace's realtime inbox channel instead and checks
// the main queue the moment anything happens there, with polling underneath in
// case the socket is down. A Windows notification is raised for each new visitor message,
// and the unread count is kept on the taskbar button and the tray icon. The
// operator's own notification preferences — the same row the web console reads —
// decide what is worth interrupting them for.

function inQuietHours(p: NotificationPrefs): boolean {
  if (!p.quiet_hours_enabled || !p.quiet_hours_start || !p.quiet_hours_end) return false
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: p.quiet_hours_timezone || undefined }).formatToParts(new Date())
  const now = Number(parts.find((x) => x.type === 'hour')?.value) * 60 + Number(parts.find((x) => x.type === 'minute')?.value)
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return h * 60 + (m || 0)
  }
  const start = toMin(p.quiet_hours_start)
  const end = toMin(p.quiet_hours_end)
  return start <= end ? now >= start && now < end : now >= start || now < end
}

function badgeImage(count: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#e5484d'
  ctx.beginPath()
  ctx.arc(16, 16, 15, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${count > 9 ? 15 : 19}px Segoe UI, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 99 ? '99+' : String(count), 16, 17)
  return canvas.toDataURL()
}

export function BackgroundSync() {
  const workspaceId = useApp((s) => s.workspace?.id ?? null)
  const showColleagues = useApp(colleaguesVisible)
  const inboxUnread = useApp((s) => s.inboxUnread)
  const colleaguesUnread = useApp((s) => s.colleaguesUnread)
  const seen = useRef<Map<string, number> | null>(null)
  const seenTeam = useRef<Map<string, number> | null>(null)
  const prefs = useRef<NotificationPrefs | null>(null)
  const prefsAt = useRef(0)

  useInboxRealtime(workspaceId)

  // A new workspace starts from a fresh baseline: nothing already there is "new".
  useEffect(() => {
    seen.current = null
    seenTeam.current = null
  }, [workspaceId])

  // Clicking a notification opens what it was about, in the right workspace.
  useEffect(
    () =>
      window.webyar.app.onNotificationClick((payload) => {
        const s = useApp.getState()
        if (payload.workspaceId && payload.workspaceId !== s.workspace?.id) {
          const ws = s.workspaces.find((w) => w.id === payload.workspaceId)
          if (ws) s.selectWorkspace(ws)
        }
        if (payload.kind === 'conversation') s.openConversation(payload.id)
        else if (payload.kind === 'colleague') s.openColleague(payload.id)
        else if (payload.kind === 'email') s.openEmail(payload.id)
      }),
    [],
  )

  // Presence is recomputed from app use, so ask again when the window comes back.
  useEffect(() => window.webyar.app.onFocusChange((focused) => focused && void reloadAvailability()), [])

  useEffect(() => {
    const total = inboxUnread + colleaguesUnread
    void window.webyar.app.setBadge(total, total > 0 ? badgeImage(total) : null)
  }, [inboxUnread, colleaguesUnread])

  async function preferences(): Promise<NotificationPrefs | null> {
    if (prefs.current && Date.now() - prefsAt.current < 5 * 60_000) return prefs.current
    try {
      prefs.current = await api.notificationPrefs()
      prefsAt.current = Date.now()
    } catch {
      // Without the row, fall back to the defaults the server itself would use.
    }
    return prefs.current
  }

  async function shouldNotify(): Promise<{ ok: boolean; silent: boolean; showPreview: boolean; scope: NotificationPrefs['push_scope'] }> {
    const desktop = await window.webyar.app.getSettings()
    const p = await preferences()
    if (!desktop.desktopNotifications || p?.disable_all || p?.push_scope === 'none' || (p && inQuietHours(p))) {
      return { ok: false, silent: true, showPreview: false, scope: 'none' }
    }
    return { ok: true, silent: !desktop.notificationSound || p?.play_sound === false, showPreview: p?.push_preview !== false, scope: p?.push_scope ?? 'all' }
  }

  usePoll(
    async () => {
      if (!workspaceId) return
      const conversations = await api.conversations(workspaceId, 'open')
      const unread = conversations.reduce((n, c) => n + (c.unread_count ?? 0), 0)
      useApp.getState().setUnread('inbox', unread)

      const stamp = (c: Conversation) => parseDate(c.last_message?.created_at)?.getTime() ?? 0
      if (!seen.current) {
        seen.current = new Map(conversations.map((c) => [c.id, stamp(c)]))
        return
      }
      const fresh = conversations.filter((c) => {
        const before = seen.current!.get(c.id) ?? 0
        return stamp(c) > before && c.last_message?.sender_type === 'contact' && (c.unread_count ?? 1) > 0
      })
      for (const c of conversations) seen.current.set(c.id, stamp(c))
      if (!fresh.length) return

      const focused = await window.webyar.app.isFocused()
      const gate = await shouldNotify()
      if (!gate.ok) return
      const s = useApp.getState()
      const me = s.session.kind === 'signedIn' ? s.session.user.id : null
      const language = s.language
      for (const c of fresh.slice(0, 3)) {
        // The thread already on screen needs no banner — unless nobody is looking at the window.
        if (focused && viewing.id === c.id && s.section === 'inbox') continue
        // "Assigned" and "mentions" both mean: not every thread in the workspace.
        if (gate.scope !== 'all' && c.assigned_to !== me) continue
        const name = contactName(c.contacts, language)
        const last = c.last_message
        const body = gate.showPreview
          ? last?.attachment_kind && !preview(last.body)
            ? attachmentPreview(last.attachment_kind, false, name, language)
            : preview(last?.body).slice(0, 180)
          : translate(language, 'newMessage')
        void window.webyar.app.notify({
          title: translate(language, 'newMessageFrom', { name }),
          body,
          silent: gate.silent,
          rtl: isRTL(language),
          payload: { kind: 'conversation', id: c.id, workspaceId },
        })
      }
    },
    12_000,
    [workspaceId],
    // In the background too: a minimised window is exactly when a notification matters.
    { backgroundMs: 12_000, wakeOn: INBOX_EVENT },
  )

  usePoll(
    async () => {
      if (!workspaceId || !showColleagues) {
        useApp.getState().setUnread('colleagues', 0)
        return
      }
      await refreshColleagues(workspaceId)
      const data = useColleagues.getState().data
      if (!data) return
      const stamp = (t?: string | null) => parseDate(t)?.getTime() ?? 0
      if (!seenTeam.current) {
        seenTeam.current = new Map(data.colleagues.map((c) => [c.user_id, stamp(c.last_message?.created_at)]))
        return
      }
      const fresh = data.colleagues.filter((c) => stamp(c.last_message?.created_at) > (seenTeam.current!.get(c.user_id) ?? 0) && !c.last_message?.outgoing && (c.unread ?? 0) > 0)
      for (const c of data.colleagues) seenTeam.current.set(c.user_id, stamp(c.last_message?.created_at))
      if (!fresh.length) return
      const gate = await shouldNotify()
      if (!gate.ok) return
      const focused = await window.webyar.app.isFocused()
      const s = useApp.getState()
      for (const c of fresh.slice(0, 3)) {
        if (focused && s.section === 'colleagues' && s.colleagueId === c.user_id) continue
        void window.webyar.app.notify({
          title: translate(s.language, 'newColleagueMessage', { name: colleagueName(c) }),
          body: gate.showPreview ? preview(c.last_message?.body).slice(0, 180) || translate(s.language, 'newMessage') : translate(s.language, 'newMessage'),
          silent: gate.silent,
          rtl: isRTL(s.language),
          payload: { kind: 'colleague', id: c.user_id, workspaceId },
        })
      }
    },
    15_000,
    [workspaceId, showColleagues],
    { backgroundMs: 30_000 },
  )

  return null
}
