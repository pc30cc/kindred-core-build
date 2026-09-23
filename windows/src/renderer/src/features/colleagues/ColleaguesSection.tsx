import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Search, Users, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import type { Colleague, TeamMessage } from '@/api/types'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'
import { usePoll } from '@/hooks/usePoll'
import { attachmentPreview, dayHeader, errorText, listTimestamp, parseDate, preview, timeOfDay } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { CountBadge, EmptyState, ErrorState, Skeleton, Spinner, TextField } from '@/components/ui'
import { cx } from '@/lib/cx'
import { AttachmentView } from '@/features/chat/Attachments'
import { Composer, type PendingFile } from '@/features/chat/Composer'
import { colleagueName, refreshColleagues, useColleagues } from './colleaguesStore'

export function ColleaguesSection() {
  const t = useT()
  const language = useApp((s) => s.language)
  const workspaceId = useApp((s) => s.workspace?.id ?? null)
  const selected = useApp((s) => s.colleagueId)
  const open = useApp((s) => s.openColleague)
  const { data, error } = useColleagues()
  const [query, setQuery] = useState('')

  usePoll(async () => {
    if (workspaceId) await refreshColleagues(workspaceId)
  }, 15_000, [workspaceId])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.colleagues ?? [])
      .filter((c) => !q || colleagueName(c).toLowerCase().includes(q) || c.email?.toLowerCase().includes(q))
      .sort((a, b) => (parseDate(b.last_message?.created_at)?.getTime() ?? 0) - (parseDate(a.last_message?.created_at)?.getTime() ?? 0))
  }, [data, query])

  const colleague = data?.colleagues.find((c) => c.user_id === selected) ?? null

  return (
    <div className="flex h-full">
      <aside className="flex h-full w-[340px] shrink-0 flex-col bg-surface">
        <div className="px-4 pt-4 pb-3">
          <h2 className="mb-3 text-[17px] font-bold">{t('colleagues')}</h2>
          <TextField icon={Search} placeholder={t('colleaguesSearch')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          {!data && !error && Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3 px-4 py-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2.5 w-44" />
              </div>
            </div>
          ))}
          {error && !data && workspaceId && (
            <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(error, language)} retryLabel={t('retry')} onRetry={() => void refreshColleagues(workspaceId)} />
          )}
          {data && list.length === 0 && <EmptyState icon={Users} title={query ? t('noResults') : t('colleaguesEmptyTitle')} body={query ? undefined : t('colleaguesEmptyBody')} />}
          {list.map((c) => {
            const last = c.last_message
            const text = last?.attachment_kind && !preview(last.body) ? attachmentPreview(last.attachment_kind, !!last.outgoing, colleagueName(c), language) : preview(last?.body)
            const active = c.user_id === selected
            return (
              <button key={c.user_id} onClick={() => open(c.user_id)} className={cx('relative flex w-full gap-3 border-b border-line/60 px-4 py-3 text-start transition-colors', active ? 'bg-selected' : 'hover:bg-hover')}>
                {active && <span className="absolute inset-y-2 start-0 w-[3px] rounded-e-full bg-brand" />}
                <Avatar name={colleagueName(c)} imageURL={c.avatar_url} size={42} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={cx('truncate text-[14px]', c.unread ? 'font-bold' : 'font-semibold')}><bdi>{colleagueName(c)}</bdi></span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-[11.5px] text-fg-3">{listTimestamp(last?.created_at, language)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className={cx('min-w-0 flex-1 truncate text-[13px]', c.unread ? 'text-fg' : 'text-fg-2')}>
                      {last?.outgoing && text ? `${t('you')}: ` : ''}
                      <bdi>{text || c.role || ''}</bdi>
                    </span>
                    <CountBadge count={c.unread ?? 0} language={language} />
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </aside>
      <div className="min-w-0 flex-1 border-s border-line">
        {colleague && workspaceId ? (
          <TeamThread key={colleague.user_id} colleague={colleague} workspaceId={workspaceId} />
        ) : (
          <div className="h-full bg-bg/50">
            <EmptyState icon={AtSign} title={t('noColleagueSelected')} body={t('noColleagueSelectedBody')} />
          </div>
        )}
      </div>
    </div>
  )
}

function TeamThread({ colleague, workspaceId }: { colleague: Colleague; workspaceId: string }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [messages, setMessages] = useState<TeamMessage[] | null>(null)
  const [me, setMe] = useState<string | null>(null)
  const [failed, setFailed] = useState<ApiError | null>(null)
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const lastUnread = useRef(-1)

  const load = useCallback(async () => {
    try {
      const r = await api.teamThread(workspaceId, colleague.user_id)
      setMessages(r.messages)
      setMe(r.me ?? null)
      setFailed(null)
      const unread = r.messages.filter((m) => m.sender_id === colleague.user_id && !m.read_at).length
      if (unread > 0 && unread !== lastUnread.current && document.hasFocus()) {
        lastUnread.current = unread
        await api.markTeamRead(workspaceId, colleague.user_id).catch(() => undefined)
        void refreshColleagues(workspaceId)
      }
    } catch (e) {
      if (!messages) setFailed(e instanceof ApiError ? e : new ApiError('transport'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, colleague.user_id])

  // The console polls a thread every ten seconds; so does this.
  usePoll(load, 10_000, [workspaceId, colleague.user_id], { backgroundMs: 20_000 })

  const lastId = messages?.at(-1)?.id
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])

  const onSend = useCallback(
    async (text: string, files: PendingFile[]) => {
      setSending(true)
      try {
        if (files.length === 0) {
          await api.sendTeamMessage(workspaceId, colleague.user_id, text)
        } else {
          for (let i = 0; i < files.length; i++) {
            // A file between operators is reserved against the workspace, never bound to a visitor's thread.
            const id = await api.uploadAttachment({ workspaceId, conversationId: null, fileName: files[i].name, mimeType: files[i].mime, data: files[i].data })
            await api.sendTeamMessage(workspaceId, colleague.user_id, i === 0 ? text : '', id)
          }
        }
        await load()
        void refreshColleagues(workspaceId)
        return true
      } catch {
        toast.error(t('offlineTitle'), { description: t('offlineBody') })
        return false
      } finally {
        setSending(false)
      }
    },
    [workspaceId, colleague.user_id, load, t],
  )

  const days = useMemo(() => {
    const out: { key: string; date: Date; items: TeamMessage[] }[] = []
    for (const m of [...(messages ?? [])].sort((a, b) => (parseDate(a.created_at)?.getTime() ?? 0) - (parseDate(b.created_at)?.getTime() ?? 0))) {
      const d = parseDate(m.created_at) ?? new Date()
      const key = d.toDateString()
      const last = out.at(-1)
      if (last?.key === key) last.items.push(m)
      else out.push({ key, date: d, items: [m] })
    }
    return out
  }, [messages])

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <Avatar name={colleagueName(colleague)} imageURL={colleague.avatar_url} size={38} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold"><bdi>{colleagueName(colleague)}</bdi></div>
          <div className="truncate text-[12px] text-fg-3"><bdi>{[colleague.role, colleague.email].filter(Boolean).join(' · ')}</bdi></div>
        </div>
      </header>
      <div ref={scroller} className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!messages && !failed && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {failed && !messages && <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(failed, language)} retryLabel={t('retry')} onRetry={load} />}
        {messages && messages.length === 0 && <EmptyState icon={AtSign} title={t('colleagueThreadEmpty')} />}
        <div className="mx-auto max-w-[860px]">
          {days.map((day) => (
            <section key={day.key}>
              <div className="sticky top-0 z-[1] flex justify-center py-2">
                <span className="rounded-full border border-line bg-surface/90 px-3 py-0.5 text-[11.5px] font-medium text-fg-2 shadow-card">{dayHeader(day.date, language)}</span>
              </div>
              {day.items.map((m, i) => {
                const mine = m.sender_id === me || (me === null && m.sender_id !== colleague.user_id)
                const endsRun = i + 1 >= day.items.length || day.items[i + 1].sender_id !== m.sender_id
                return (
                  <div key={m.id} dir="ltr" className={cx('flex flex-col gap-1', mine ? 'items-end' : 'items-start', i > 0 && day.items[i - 1].sender_id === m.sender_id ? 'mt-0.5' : 'mt-3')}>
                    {m.attachment && <AttachmentView attachment={m.attachment} outgoing={mine} />}
                    {m.body?.trim() && (
                      <div dir="auto" className={cx('max-w-[72%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap', mine ? 'bg-brand text-on-brand' : 'bg-bubble-in text-fg shadow-card ring-1 ring-line/70', endsRun && (mine ? 'rounded-br-md' : 'rounded-bl-md'))}>
                        {m.body}
                      </div>
                    )}
                    {endsRun && <span className="px-1 text-[10.5px] text-fg-3">{timeOfDay(m.created_at, language)}</span>}
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      </div>
      <Composer
        key={colleague.user_id}
        draftKey={`team:${colleague.user_id}`}
        capabilities={{ canAttach: true, canRecordVoice: true, canUseEmoji: true, aiManaged: false }}
        sending={sending}
        onSend={onSend}
      />
    </div>
  )
}
