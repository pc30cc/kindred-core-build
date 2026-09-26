import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Check,
  ChevronDown,
  Copy,
  Hand,
  Loader2,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  Phone,
  RotateCcw,
  Sparkles,
  Upload,
  Video,
  WifiOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { Conversation, ConversationStatus, Message } from '@/api/types'
import { useApp, currentUser, planValue, displayNameOf } from '@/store/app'
import { useT } from '@/hooks/useT'
import { callChannels } from '@/lib/entitlements'
import { contactName, dayHeader, errorText, parseDate, systemText, timeOfDay } from '@/lib/format'
import { AIAvatar, Avatar } from '@/components/Avatar'
import { Button, EmptyState, ErrorState, IconButton, Menu, Spinner } from '@/components/ui'
import { cx } from '@/lib/cx'
import { aiStateOf } from '@/features/inbox/inboxStore'
import { useConversationActions, useTranscript } from './useConversation'
import { AttachmentView } from './Attachments'
import { Composer, type PendingFile } from './Composer'
import { DetailsPanel } from './DetailsPanel'
import { STATUS_TITLE, viewing } from './status'


export function ChatPane({ conversation }: { conversation: Conversation }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const plan = useApp(planValue)
  const user = useApp(currentUser)
  const profile = useApp((s) => s.profile)
  const workspace = useApp((s) => s.workspace)
  const detailsOpen = useApp((s) => s.detailsOpen)
  const toggleDetails = useApp((s) => s.toggleDetails)
  const transcript = useTranscript(conversation)
  const actions = useConversationActions(conversation)
  const name = contactName(conversation.contacts, language)
  const aiManaged = aiStateOf(conversation) === 'ai_managed' && !actions.tookOver
  const channels = callChannels(plan)
  const visitor = transcript.visitor
  const [dragging, setDragging] = useState(false)
  const addFiles = useRef<((files: File[]) => void) | null>(null)

  // Only the AI owning the thread hides the composer's tools. The plan's widget_* keys govern the
  // customer-facing website widget, not the operator's composer, as on the web and the other apps.
  const capabilities = {
    canAttach: !aiManaged,
    canRecordVoice: !aiManaged,
    canUseEmoji: !aiManaged,
    aiManaged,
  }

  const onSend = useCallback(
    async (text: string, files: PendingFile[]) => {
      if (files.length === 0) return transcript.send(text)
      // One message per file; the caption rides with the first.
      for (let i = 0; i < files.length; i++) {
        const ok = await transcript.send(i === 0 ? text : '', { name: files[i].name, mime: files[i].mime, data: files[i].data })
        if (!ok) return false
      }
      return true
    },
    [transcript],
  )

  const onSayNow = useCallback(
    async (text: string, voice: 'specialist' | 'assistant') => {
      try {
        await api.aiSayNow(conversation.id, text, voice)
        toast.success(t('sayNowSent'))
        void transcript.reload(true)
        return true
      } catch {
        toast.error(t('sayNowFailed'))
        return false
      }
    },
    [conversation.id, t, transcript],
  )

  // The chat is what the notification poller should stay quiet about.
  useEffect(() => {
    viewing.id = conversation.id
    return () => {
      if (viewing.id === conversation.id) viewing.id = null
    }
  }, [conversation.id])

  return (
    <div className="flex h-full">
      <div
        className="relative flex min-w-0 flex-1 flex-col bg-bg"
        onDragOver={(e) => {
          if (capabilities.canAttach && e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles.current?.([...e.dataTransfer.files])
        }}
      >
        {/* Header */}
        <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
          <Avatar name={name} imageURL={conversation.contacts?.avatar_url} size={38} os={visitor?.device?.os} countryCode={visitor?.geo?.country_code} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span dir="auto" className="bidi-line truncate text-[15px] font-semibold">{name}</span>
              {aiManaged && <Sparkles className="size-3.5 text-brand" />}
            </div>
            <div dir="auto" className="bidi-line truncate text-[12px] text-fg-3">
              {[visitor?.geo?.city || visitor?.geo?.country, visitor?.device?.os, detailsOpen ? null : conversation.contacts?.email].filter(Boolean).join(' · ') || ' '}
            </div>
          </div>

          {aiManaged && (
            <Button size="sm" variant="soft" icon={Hand} loading={actions.busy} onClick={() => void actions.takeOver()}>
              {t('takeOver')}
            </Button>
          )}
          {channels.voice && <IconButton icon={Phone} label={t('voiceCall')} onClick={() => void actions.invite('audio')} />}
          {channels.video && <IconButton icon={Video} label={t('videoCall')} onClick={() => void actions.invite('video')} />}
          <Menu
            align="end"
            items={(['open', 'pending', 'resolved', 'closed'] as const).map((s) => ({ label: t(STATUS_TITLE[s]), checked: actions.status === s, onSelect: () => actions.setStatus(s) }))}
            trigger={({ ref, onClick }) => (
              <Button ref={ref} onClick={onClick} size="sm" variant="secondary" className="gap-1.5">
                <StatusDot status={actions.status} />
                {t(STATUS_TITLE[actions.status])}
                <ChevronDown className="size-3.5 text-fg-3" />
              </Button>
            )}
          />
          {actions.status === 'resolved' || actions.status === 'closed' ? (
            <IconButton icon={RotateCcw} label={t('reopen')} onClick={() => actions.setStatus('open')} />
          ) : (
            <IconButton icon={Check} label={t('markResolved')} tone="brand" onClick={() => actions.setStatus('resolved')} />
          )}
          <IconButton icon={detailsOpen ? PanelRightClose : PanelRightOpen} label={detailsOpen ? t('hideDetails') : t('details')} active={detailsOpen} onClick={toggleDetails} className="rtl:-scale-x-100" />
        </header>

        {aiManaged && (
          <div className="flex items-center gap-3 border-b border-line bg-brand-soft px-4 py-2 text-[12.5px] text-brand">
            <AIAvatar size={22} />
            <div className="min-w-0 flex-1">
              <span className="font-semibold">{t('aiHandling')}</span> <span className="opacity-80">{t('aiHandlingHint')}</span>
            </div>
          </div>
        )}

        <Transcript state={transcript.state} conversation={conversation} contactLabel={name} visitorOS={visitor?.device?.os} visitorCountry={visitor?.geo?.country_code} onRetry={() => void transcript.reload()} />

        <Composer
          key={conversation.id}
          draftKey={`conv:${conversation.id}`}
          capabilities={capabilities}
          sending={transcript.sending}
          onSend={onSend}
          onSayNow={onSayNow}
          onFilesRef={(add) => (addFiles.current = add)}
          canned={
            !aiManaged && workspace
              ? {
                  workspaceId: workspace.id,
                  context: {
                    contactName: conversation.contacts?.name,
                    contactEmail: conversation.contacts?.email,
                    workspaceName: workspace.name,
                    agentName: displayNameOf(user, profile),
                    agentEmail: user?.email,
                  },
                }
              : null
          }
        />

        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand bg-brand-soft/80 text-brand backdrop-blur-sm">
            <Upload className="size-8" />
            <div className="text-[14px] font-semibold">{t('dropToAttach')}</div>
            <div className="text-[12px] opacity-80">{t('attachmentsLimit')}</div>
          </div>
        )}
      </div>
      {detailsOpen && <DetailsPanel conversation={conversation} actions={actions} visitor={visitor} />}
    </div>
  )
}


export function StatusDot({ status }: { status: ConversationStatus }) {
  const color = status === 'open' ? 'bg-brand' : status === 'pending' ? 'bg-warning' : status === 'resolved' ? 'bg-success' : 'bg-fg-3'
  return <span className={cx('size-2 rounded-full', color)} />
}

interface Day {
  key: string
  date: Date
  messages: Message[]
}

function groupByDay(messages: Message[]): Day[] {
  const sorted = [...messages].filter((m) => parseDate(m.created_at)).sort((a, b) => parseDate(a.created_at)!.getTime() - parseDate(b.created_at)!.getTime())
  const days: Day[] = []
  for (const m of sorted) {
    const d = parseDate(m.created_at)!
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const last = days[days.length - 1]
    if (last?.key === key) last.messages.push(m)
    else days.push({ key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), messages: [m] })
  }
  return days
}

function Transcript({
  state,
  conversation,
  contactLabel,
  visitorOS,
  visitorCountry,
  onRetry,
}: {
  state: ReturnType<typeof useTranscript>['state']
  conversation: Conversation
  contactLabel: string
  visitorOS?: string | null
  visitorCountry?: string | null
  onRetry: () => void
}) {
  const t = useT()
  const language = useApp((s) => s.language)
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const days = useMemo(() => (state.kind === 'loaded' ? groupByDay(state.value) : []), [state])
  const lastId = days.at(-1)?.messages.at(-1)?.id
  const firstLoad = useRef(true)

  // Pinned to the newest message: on open, and whenever something arrives while already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !lastId) return
    if (firstLoad.current || atBottom) {
      el.scrollTop = el.scrollHeight
      firstLoad.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId])

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className="flex-1">
        <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(state.error, language)} retryLabel={t('retry')} onRetry={onRetry} />
      </div>
    )
  }
  if (days.length === 0) {
    return (
      <div className="flex-1">
        <EmptyState icon={MessagesSquare} title={t('chatEmpty')} />
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="selectable h-full overflow-y-auto px-5 py-4"
        onScroll={(e) => {
          const el = e.currentTarget
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
        }}
      >
        <div className="mx-auto max-w-[860px]">
          {days.map((day) => (
            <section key={day.key}>
              <div className="sticky top-0 z-[1] flex justify-center py-2">
                <span className="rounded-full border border-line bg-surface/90 px-3 py-0.5 text-[11.5px] font-medium text-fg-2 shadow-card backdrop-blur">{dayHeader(day.date, language)}</span>
              </div>
              {day.messages.map((m, i) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  endsRun={i + 1 >= day.messages.length || day.messages[i + 1].sender_type !== m.sender_type || day.messages[i + 1].sender_name !== m.sender_name}
                  startsRun={i === 0 || day.messages[i - 1].sender_type !== m.sender_type || day.messages[i - 1].sender_name !== m.sender_name}
                  contactLabel={contactLabel}
                  contactAvatar={conversation.contacts?.avatar_url}
                  visitorOS={visitorOS}
                  visitorCountry={visitorCountry}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
      {!atBottom && (
        <button
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
          className="pop-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-fg-2 shadow-pop hover:text-fg"
        >
          <ArrowDown className="size-3.5" />
          {t('jumpToLatest')}
        </button>
      )}
    </div>
  )
}

function MessageRow({
  message: m,
  endsRun,
  startsRun,
  contactLabel,
  contactAvatar,
  visitorOS,
  visitorCountry,
}: {
  message: Message
  endsRun: boolean
  startsRun: boolean
  contactLabel: string
  contactAvatar?: string | null
  visitorOS?: string | null
  visitorCountry?: string | null
}) {
  const t = useT()
  const language = useApp((s) => s.language)

  if (m.sender_type === 'system') {
    return (
      <div className="my-2 flex justify-center">
        <span className="max-w-[80%] rounded-lg bg-elevated px-3 py-1 text-center text-[12px] text-fg-2">{systemText(m.metadata, language) ?? m.body}</span>
      </div>
    )
  }

  const outgoing = m.sender_type === 'agent' || m.sender_type === 'ai' || m.sender_type === 'bot'
  const ai = m.sender_type === 'ai' || m.sender_type === 'bot'
  const pending = m.metadata?.pending === true
  const attachments = m.attachments ?? []
  const hasText = m.body.trim().length > 0

  // Bubbles stay on the side the conversation expects — visitor left, team right — in both
  // directions, the way the iOS app keeps them; the text inside follows its own language.
  return (
    <div dir="ltr" className={cx('group flex items-end gap-2', startsRun ? 'mt-3' : 'mt-0.5', outgoing ? 'justify-end' : 'justify-start')}>
      {!outgoing && (
        <div className="w-8 shrink-0">
          {endsRun && <Avatar name={contactLabel} imageURL={contactAvatar} size={30} os={visitorOS} countryCode={visitorCountry} />}
        </div>
      )}
      <div className={cx('flex max-w-[72%] flex-col gap-1', outgoing ? 'items-end' : 'items-start')}>
        {startsRun && outgoing && m.sender_name && !ai && <span className="px-1 text-[11px] font-medium text-fg-3" dir="auto">{m.sender_name}</span>}
        {attachments.map((a) => (
          <AttachmentView key={a.id} attachment={a} outgoing={outgoing} />
        ))}
        {hasText && (
          <div
            dir="auto"
            className={cx(
              'relative px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap',
              outgoing ? (ai ? 'text-white' : 'bg-brand text-on-brand') : 'bg-bubble-in text-fg shadow-card ring-1 ring-line/70',
              'rounded-2xl',
              endsRun && (outgoing ? 'rounded-br-md' : 'rounded-bl-md'),
              pending && 'opacity-70',
            )}
            style={ai ? { background: 'linear-gradient(135deg, var(--ai-1), var(--ai-2))' } : undefined}
          >
            {m.body}
            <button
              onClick={() => {
                void navigator.clipboard.writeText(m.body)
                toast.success(t('copied'))
              }}
              className={cx(
                'absolute top-1/2 hidden size-7 -translate-y-1/2 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 shadow-card group-hover:flex hover:text-fg',
                outgoing ? '-left-9' : '-right-9',
              )}
              title={t('copy')}
            >
              <Copy className="size-3.5" />
            </button>
          </div>
        )}
        {endsRun && (
          <span className="flex items-center gap-1 px-1 text-[10.5px] text-fg-3" dir={language === 'fa' ? 'rtl' : 'ltr'}>
            {ai && (
              <>
                <Sparkles className="size-3" /> {t('aiReply')} ·
              </>
            )}
            {pending ? <Loader2 className="size-3 animate-spin" /> : timeOfDay(m.created_at, language)}
          </span>
        )}
      </div>
      {outgoing && (
        <div className="w-8 shrink-0">
          {endsRun && (ai ? <AIAvatar size={30} /> : <Avatar name={m.sender_name ?? '—'} imageURL={m.sender_avatar} size={30} />)}
        </div>
      )}
    </div>
  )
}

