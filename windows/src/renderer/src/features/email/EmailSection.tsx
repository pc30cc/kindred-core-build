import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUp, Mail, MailOpen, PenSquare, RefreshCw, Search, Star, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import type { EmailMessageView, EmailThreadSummary, GmailConnection } from '@/api/types'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'
import { usePoll } from '@/hooks/usePoll'
import { errorText, fullDateTime, listTimestamp } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { Button, Dialog, EmptyState, ErrorState, IconButton, Skeleton, Spinner, TextArea, TextField } from '@/components/ui'
import { cx } from '@/lib/cx'

function people(thread: EmailThreadSummary, mailbox: string | null | undefined): string {
  const all = (thread.participants ?? []).map((p) => p.email)
  const others = mailbox ? all.filter((e) => e.toLowerCase() !== mailbox.toLowerCase()) : all
  return (others.length ? others : all).join(', ')
}

/** HTML mail with its tags taken out, for the plain view and for previews. */
function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,head').forEach((n) => n.remove())
  doc.querySelectorAll('br,p,div,tr,li,h1,h2,h3,h4,h5,h6').forEach((n) => n.append('\n'))
  return (doc.body.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function bodyOf(m: EmailMessageView): string {
  const text = m.textBody?.trim()
  if (text) return text
  if (m.htmlBody) return plainText(m.htmlBody)
  return m.snippet ?? ''
}

export function EmailSection() {
  const t = useT()
  const language = useApp((s) => s.language)
  const workspaceId = useApp((s) => s.workspace?.id ?? null)
  const selected = useApp((s) => s.emailThreadId)
  const open = useApp((s) => s.openEmail)
  const [threads, setThreads] = useState<EmailThreadSummary[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [connection, setConnection] = useState<GmailConnection | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setSearch(query), 300)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    if (!workspaceId) return
    void api.gmailConnection(workspaceId).then(setConnection).catch(() => setConnection(null))
  }, [workspaceId])

  const load = useCallback(async () => {
    if (!workspaceId) return
    try {
      setThreads(await api.emailThreads(workspaceId, search))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('transport'))
    }
  }, [workspaceId, search])

  useEffect(() => {
    setThreads(null)
  }, [search])
  usePoll(load, 30_000, [load])

  const thread = threads?.find((x) => x.id === selected) ?? null
  const notConnected = connection !== undefined && (connection === null || connection.connected === false)

  return (
    <div className="flex h-full">
      <aside className="flex h-full w-[360px] shrink-0 flex-col bg-surface">
        <div className="px-4 pt-4 pb-3">
          <div className="mb-3 flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-bold">{t('emailInbox')}</h2>
              {connection?.emailAddress && <div className="truncate text-[12px] text-fg-3"><bdi>{connection.emailAddress}</bdi></div>}
            </div>
            <IconButton icon={RefreshCw} label={t('refresh')} onClick={load} />
            <Button size="sm" variant="primary" icon={PenSquare} onClick={() => setComposing(true)} disabled={notConnected}>
              {t('newEmail')}
            </Button>
          </div>
          <TextField icon={Search} placeholder={t('emailSearch')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          {notConnected && <EmptyState icon={Mail} title={t('emailNotConnectedTitle')} body={t('emailNotConnectedBody')} />}
          {!notConnected && !threads && !error && Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="space-y-2 px-4 py-3.5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-2.5 w-full" />
            </div>
          ))}
          {!notConnected && error && !threads && <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(error, language)} retryLabel={t('retry')} onRetry={load} />}
          {!notConnected && threads?.length === 0 && <EmptyState icon={Mail} title={search ? t('noResults') : t('emailEmptyTitle')} body={search ? undefined : t('emailEmptyBody')} />}
          {!notConnected &&
            threads?.map((th) => {
              const active = th.id === selected
              const unread = th.isRead === false
              return (
                <button key={th.id} onClick={() => open(th.id)} className={cx('relative flex w-full flex-col gap-0.5 border-b border-line/60 px-4 py-3 text-start transition-colors', active ? 'bg-selected' : 'hover:bg-hover')}>
                  {active && <span className="absolute inset-y-2 start-0 w-[3px] rounded-e-full bg-brand" />}
                  <div className="flex items-center gap-2">
                    {unread && <span className="size-2 shrink-0 rounded-full bg-brand" />}
                    <span dir="auto" className={cx('bidi-line min-w-0 flex-1 truncate text-[13.5px]', unread ? 'font-bold' : 'font-medium')}>
                      {people(th, connection?.emailAddress)}
                    </span>
                    {th.isStarred && <Star className="size-3.5 shrink-0 fill-warning text-warning" />}
                    <span className="shrink-0 text-[11.5px] text-fg-3">{listTimestamp(th.lastMessageAt, language)}</span>
                  </div>
                  <div dir="auto" className={cx('bidi-line truncate text-[13px]', unread ? 'font-semibold text-fg' : 'text-fg')}>{th.subject || t('emailNoSubject')}</div>
                  <div dir="auto" className="bidi-line truncate text-[12.5px] text-fg-2">{th.lastMessageSnippet}</div>
                </button>
              )
            })}
        </div>
      </aside>
      <div className="min-w-0 flex-1 border-s border-line">
        {thread && workspaceId ? (
          <EmailThread key={thread.id} summary={thread} workspaceId={workspaceId} mailbox={connection?.emailAddress ?? null} onChanged={load} />
        ) : (
          <div className="h-full bg-bg/50">
            <EmptyState icon={MailOpen} title={t('noEmailSelected')} body={t('noEmailSelectedBody')} />
          </div>
        )}
      </div>
      {workspaceId && <ComposeDialog open={composing} onClose={() => setComposing(false)} workspaceId={workspaceId} onSent={load} />}
    </div>
  )
}

function EmailThread({ summary, workspaceId, mailbox, onChanged }: { summary: EmailThreadSummary; workspaceId: string; mailbox: string | null; onChanged: () => void }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [data, setData] = useState<{ thread: EmailThreadSummary; messages: EmailMessageView[] } | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [starred, setStarred] = useState(!!summary.isStarred)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.emailThread(workspaceId, summary.id)
      setData(d)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('transport'))
    }
  }, [workspaceId, summary.id])

  useEffect(() => {
    void load()
    if (summary.isRead === false) {
      void api.setEmailRead(workspaceId, summary.id, true).then(onChanged).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.id])

  const replyTo = useMemo(() => {
    const last = [...(data?.messages ?? [])].reverse().find((m) => m.direction !== 'outbound')
    const from = last?.fromAddress?.match(/<([^>]+)>/)?.[1] ?? last?.fromAddress
    return from ? [from] : (summary.participants ?? []).map((p) => p.email).filter((e) => e.toLowerCase() !== mailbox?.toLowerCase())
  }, [data, summary.participants, mailbox])

  async function send() {
    if (!reply.trim() || !replyTo.length) return
    setSending(true)
    try {
      const subject = summary.subject ? (/^re:/i.test(summary.subject) ? summary.subject : `Re: ${summary.subject}`) : ''
      await api.sendEmail(workspaceId, { threadId: summary.id, to: replyTo, subject, body: reply.trim() })
      setReply('')
      toast.success(t('emailSent'))
      await load()
      onChanged()
    } catch {
      toast.error(t('emailSendFailed'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex min-h-[60px] shrink-0 items-center gap-2 border-b border-line bg-surface px-5 py-2">
        <h3 className="min-w-0 flex-1 truncate text-[16px] font-semibold"><bdi>{summary.subject || t('emailNoSubject')}</bdi></h3>
        <IconButton
          icon={Star}
          label={starred ? t('unstar') : t('emailStar')}
          active={starred}
          className={starred ? '[&_svg]:fill-warning [&_svg]:text-warning' : ''}
          onClick={async () => {
            const next = !starred
            setStarred(next)
            try {
              await api.setEmailStarred(workspaceId, summary.id, next)
              onChanged()
            } catch {
              setStarred(!next)
            }
          }}
        />
        <IconButton
          icon={Mail}
          label={t('emailMarkUnread')}
          onClick={async () => {
            await api.setEmailRead(workspaceId, summary.id, false).catch(() => undefined)
            onChanged()
          }}
        />
      </header>
      <div className="selectable min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {!data && !error && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {error && !data && <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(error, language)} retryLabel={t('retry')} onRetry={load} />}
        {data?.messages.map((m) => <EmailMessage key={m.id} message={m} />)}
      </div>
      <div className="border-t border-line bg-surface p-4">
        <div className="mb-2 truncate text-[12px] text-fg-3">
          {t('emailTo')}: <bdi>{replyTo.join(', ')}</bdi>
        </div>
        <div className="flex items-end gap-2">
          <TextArea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('emailReplyPlaceholder')} dir="auto" onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void send()} />
          <Button variant="primary" icon={ArrowUp} loading={sending} disabled={!reply.trim()} onClick={send}>
            {t('emailSend')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function EmailMessage({ message: m }: { message: EmailMessageView }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [formatted, setFormatted] = useState(!!m.htmlBody)
  const outbound = m.direction === 'outbound'
  const from = m.fromAddress ?? ''
  // Rendered with no scripts, no forms and no navigation: an HTML mail is somebody else's document.
  const srcDoc = useMemo(
    () =>
      m.htmlBody
        ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:Segoe UI,Vazirmatn,sans-serif;font-size:14px;color:#0f1729;margin:0;padding:0;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${m.htmlBody}</body></html>`
        : '',
    [m.htmlBody],
  )
  return (
    <article className={cx('overflow-hidden rounded-xl border bg-surface shadow-card', outbound ? 'border-brand/30' : 'border-line')}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar name={from.replace(/<.*>/, '').trim() || from} size={34} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold"><bdi>{from}</bdi></div>
          <div className="truncate text-[12px] text-fg-3">
            {t('emailTo')}: <bdi>{(m.toAddresses ?? []).map((a) => a.email).join(', ')}</bdi>
          </div>
        </div>
        <div className="shrink-0 text-[12px] text-fg-3">{fullDateTime(m.sentAt, language)}</div>
        {m.htmlBody && (
          <button onClick={() => setFormatted((f) => !f)} className="rounded-md px-2 py-1 text-[11.5px] text-brand hover:bg-brand-soft">
            {formatted ? t('showPlain') : t('showOriginal')}
          </button>
        )}
      </div>
      {formatted && m.htmlBody ? (
        <iframe
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          className="h-[420px] w-full bg-white"
          title={m.id}
          onLoad={(e) => {
            const doc = e.currentTarget.contentDocument
            if (doc) e.currentTarget.style.height = Math.min(1600, doc.documentElement.scrollHeight + 24) + 'px'
          }}
        />
      ) : (
        <div className="px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap" dir="auto">{bodyOf(m)}</div>
      )}
      {m.deliveryError && <div className="border-t border-line bg-danger-soft px-4 py-2 text-[12px] text-danger">{m.deliveryError}</div>}
    </article>
  )
}

function ComposeDialog({ open, onClose, workspaceId, onSent }: { open: boolean; onClose: () => void; workspaceId: string; onSent: () => void }) {
  const t = useT()
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const recipients = to.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s))

  async function send() {
    setSending(true)
    try {
      await api.sendEmail(workspaceId, { to: recipients, subject, body })
      toast.success(t('emailSent'))
      setTo('')
      setSubject('')
      setBody('')
      onClose()
      onSent()
    } catch {
      toast.error(t('emailSendFailed'))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('newEmail')}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" icon={ArrowUp} loading={sending} disabled={!recipients.length || !body.trim()} onClick={send}>
            {t('emailSend')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-5">
        <TextField placeholder={t('emailTo')} dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
        <TextField placeholder={t('emailSubject')} dir="auto" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <TextArea rows={10} placeholder={t('emailReplyPlaceholder')} dir="auto" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
    </Dialog>
  )
}
