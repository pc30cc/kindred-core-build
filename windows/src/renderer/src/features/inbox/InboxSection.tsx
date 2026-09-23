import { useEffect, useMemo, useState } from 'react'
import {
  AlertOctagon,
  Check,
  CheckCircle2,
  ChevronDown,
  Hourglass,
  Inbox,
  ListFilter,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  UserCheck,
  UserRoundCog,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { InboxFilter } from '@/api/client'
import type { Conversation } from '@/api/types'
import { useApp, currentUser, planValue } from '@/store/app'
import { useT } from '@/hooks/useT'
import { usePoll } from '@/hooks/usePoll'
import { INBOX_EVENT } from '@/features/notifications/realtime'
import { pollInterval } from '@/features/notifications/pollBudget'
import { inboxChips, inboxFilters } from '@/lib/entitlements'
import { channelTitle, contactName, errorText, listTimestamp } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { Button, CountBadge, EmptyState, ErrorState, IconButton, MenuList, Pill, Popover, Skeleton, TextField, type MenuItem } from '@/components/ui'
import { cx } from '@/lib/cx'
import { ChatPane } from '@/features/chat/ChatPane'
import { PromoBanner } from '@/features/promotions/Promotions'
import { conversationPreview, useInbox, visibleConversations, type Quick } from './inboxStore'
import type { StringKey } from '@/i18n'

const FILTER_ICON: Record<InboxFilter, LucideIcon> = {
  open: Inbox,
  needsHuman: UserRoundCog,
  pending: Hourglass,
  ai: Sparkles,
  resolved: CheckCircle2,
  spam: AlertOctagon,
}

const FILTER_TITLE: Record<InboxFilter, StringKey> = {
  open: 'filterOpen',
  needsHuman: 'filterNeedsHuman',
  pending: 'filterPending',
  ai: 'filterAI',
  resolved: 'filterResolved',
  spam: 'filterSpam',
}

export function InboxSection() {
  const workspaceId = useApp((s) => s.workspace?.id ?? null)
  const conversationId = useApp((s) => s.conversationId)
  const filter = useInbox((s) => s.filter)
  const channel = useInbox((s) => s.channel)
  const load = useInbox((s) => s.load)
  const loadChannels = useInbox((s) => s.loadChannels)
  const planState = useApp(planValue)
  const available = useMemo(() => inboxFilters(planState), [planState])
  const setFilter = useInbox((s) => s.setFilter)

  // A queue that has just left the plan must not stay selected with nothing behind it.
  useEffect(() => {
    if (!available.includes(filter)) setFilter(available[0])
  }, [available, filter, setFilter])

  useEffect(() => {
    if (workspaceId) void loadChannels(workspaceId)
  }, [workspaceId, loadChannels])

  usePoll(
    async () => {
      if (workspaceId) await load(workspaceId, { quiet: true })
    },
    pollInterval(10_000),
    [workspaceId, filter, channel],
    { wakeOn: INBOX_EVENT },
  )

  const conversation = useInbox((s) => (s.state.kind === 'loaded' ? s.state.conversations.find((c) => c.id === conversationId) ?? null : null))
  // Keep the open conversation on screen even when a refresh moves it out of the current queue.
  const [pinned, setPinned] = useState<Conversation | null>(null)
  useEffect(() => {
    if (conversation) setPinned(conversation)
    else if (!conversationId) setPinned(null)
  }, [conversation, conversationId])
  const shown = conversation ?? (pinned?.id === conversationId ? pinned : null)

  return (
    <div className="flex h-full">
      <InboxList />
      <div className="min-w-0 flex-1 border-s border-line">
        {shown ? <ChatPane key={shown.id} conversation={shown} /> : <NoSelection />}
      </div>
    </div>
  )
}

function NoSelection() {
  const t = useT()
  return (
    <div className="h-full bg-bg/50">
      <EmptyState icon={MessageSquare} title={t('noConversationSelected')} body={t('noConversationSelectedBody')} />
    </div>
  )
}

function InboxList() {
  const t = useT()
  const language = useApp((s) => s.language)
  const workspaceId = useApp((s) => s.workspace?.id ?? null)
  const me = useApp(currentUser)?.id ?? null
  const conversationId = useApp((s) => s.conversationId)
  const openConversation = useApp((s) => s.openConversation)
  const plan = useApp(planValue)
  const store = useInbox()
  const visible = useMemo(() => visibleConversations(store, me), [store, me])
  const [searching, setSearching] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [fieldsAnchor, setFieldsAnchor] = useState<HTMLElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const filters = inboxFilters(plan)
  const chips = inboxChips(plan)
  const fieldsActive = [store.fields.name, store.fields.email, store.fields.subject].filter((f) => f.trim()).length

  // Alt+↑ / Alt+↓ walk the list without the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      e.preventDefault()
      const i = visible.findIndex((c) => c.id === conversationId)
      const next = e.key === 'ArrowDown' ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1)
      if (visible[next]) openConversation(visible[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, conversationId, openConversation])

  const title = store.channel ? channelTitle(store.channel, language) : store.filter === 'open' ? t('tabInbox') : t(FILTER_TITLE[store.filter])

  const menuItems: MenuItem[] = [
    ...filters.map((f) => ({
      label: t(FILTER_TITLE[f]),
      icon: FILTER_ICON[f],
      checked: !store.channel && store.filter === f,
      hint: countFor(f) ? String(countFor(f)) : undefined,
      onSelect: () => store.setFilter(f),
    })),
    ...(store.channels.length
      ? [
          { kind: 'separator' as const, label: '' },
          { kind: 'header' as const, label: t('otherInboxes') },
          ...store.channels.map((c) => ({ label: channelTitle(c, language), icon: Send, checked: store.channel === c, onSelect: () => store.setChannel(c) })),
        ]
      : []),
  ]

  function countFor(f: InboxFilter): number | undefined {
    const c = store.counts
    if (!c) return undefined
    return { open: c.open, ai: c.automated, needsHuman: c.needs_human, pending: c.pending, resolved: c.resolved, spam: undefined }[f] ?? undefined
  }

  async function refresh() {
    if (!workspaceId) return
    setRefreshing(true)
    await store.load(workspaceId)
    setRefreshing(false)
  }

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col bg-surface">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <button
          ref={setMenuAnchor}
          onClick={() => setMenuOpen((o) => !o)}
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[17px] font-bold text-fg hover:bg-hover"
          title={t('allInboxes')}
        >
          <span className="truncate">{title}</span>
          <ChevronDown className="size-4 text-fg-3" strokeWidth={2.4} />
        </button>
        <div className="flex-1" />
        <IconButton icon={Search} label={t('search')} active={searching} onClick={() => setSearching((s) => !s)} />
        <IconButton ref={setFieldsAnchor} icon={ListFilter} label={t('filters')} active={fieldsActive > 0} onClick={() => setFieldsOpen((o) => !o)} />
        <IconButton icon={RefreshCw} label={t('refresh')} onClick={refresh} className={refreshing ? '[&_svg]:animate-spin' : ''} />
      </div>
      <Popover anchor={menuAnchor} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <MenuList items={menuItems} onClose={() => setMenuOpen(false)} className="min-w-[240px]" />
      </Popover>
      <Popover anchor={fieldsAnchor} open={fieldsOpen} onClose={() => setFieldsOpen(false)} align="end">
        <FieldFilterForm onDone={() => setFieldsOpen(false)} />
      </Popover>

      {(searching || store.search) && (
        <div className="px-3 pb-2">
          <TextField
            icon={Search}
            autoFocus
            value={store.search}
            placeholder={t('search')}
            onChange={(e) => store.setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                store.setSearch('')
                setSearching(false)
              }
            }}
            trailing={store.search ? <IconButton size="sm" icon={X} label={t('clear')} onClick={() => store.setSearch('')} /> : undefined}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2.5">
        {chips.map((f) => {
          const active = !store.channel && store.filter === f
          const count = countFor(f)
          return (
            <button
              key={f}
              onClick={() => store.setFilter(f)}
              className={cx(
                'flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold transition-colors',
                active ? 'bg-brand text-on-brand' : 'bg-elevated text-fg-2 hover:text-fg',
              )}
            >
              {t(FILTER_TITLE[f])}
              {count !== undefined && count > 0 && (
                <span className={cx('rounded-full px-1.5 text-[11px]', active ? 'bg-white/25' : 'bg-surface text-fg-2')}>
                  {new Intl.NumberFormat(language === 'fa' ? 'fa-IR' : 'en-US').format(count)}
                </span>
              )}
            </button>
          )
        })}
        <div className="flex-1" />
        <QuickToggle value={store.quick} onChange={store.setQuick} />
      </div>

      {fieldsActive > 0 && (
        <div className="mx-3 mb-2 flex items-center justify-between rounded-lg bg-brand-soft px-2.5 py-1.5 text-[12px] font-medium text-brand">
          {t('activeFilters', { n: fieldsActive })}
          <button className="hover:underline" onClick={() => store.setFields({ name: '', email: '', subject: '' })}>{t('clearFilters')}</button>
        </div>
      )}

      <PromoBanner />

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
        {store.state.kind === 'loading' && Array.from({ length: 9 }, (_, i) => <RowSkeleton key={i} />)}
        {store.state.kind === 'failed' && (
          <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(store.state.error, language)} retryLabel={t('retry')} onRetry={refresh} />
        )}
        {store.state.kind === 'loaded' && visible.length === 0 && (
          <EmptyState
            icon={store.search ? Search : Inbox}
            title={store.search || fieldsActive || store.quick !== 'all' ? t('noResults') : t('inboxEmptyTitle')}
            body={store.search || fieldsActive || store.quick !== 'all' ? t('emptySearch') : t('inboxEmptyBody')}
          />
        )}
        {store.state.kind === 'loaded' &&
          visible.map((c) => (
            <ConversationRow key={c.id} conversation={c} selected={c.id === conversationId} me={me} onOpen={() => openConversation(c.id)} />
          ))}
      </div>
    </aside>
  )
}

function QuickToggle({ value, onChange }: { value: Quick; onChange: (q: Quick) => void }) {
  const t = useT()
  const options: { id: Quick; label: string }[] = [
    { id: 'all', label: t('selectAll') },
    { id: 'unread', label: t('unreadOnly') },
    { id: 'mine', label: t('mineOnly') },
  ]
  return (
    <div className="flex shrink-0 rounded-full bg-elevated p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cx('h-6 rounded-full px-2 text-[11.5px] font-medium transition-colors', value === o.id ? 'bg-surface text-fg shadow-card' : 'text-fg-2 hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function FieldFilterForm({ onDone }: { onDone: () => void }) {
  const t = useT()
  const fields = useInbox((s) => s.fields)
  const setFields = useInbox((s) => s.setFields)
  const [draft, setDraft] = useState(fields)
  return (
    <form
      className="w-[280px] space-y-2.5 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        setFields(draft)
        onDone()
      }}
    >
      <div className="text-[13px] font-semibold">{t('filters')}</div>
      <TextField autoFocus placeholder={t('filterByName')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      <TextField placeholder={t('filterByEmail')} dir="ltr" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
      <TextField placeholder={t('filterBySubject')} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setFields({ name: '', email: '', subject: '' })
            onDone()
          }}
        >
          {t('clearFilters')}
        </Button>
        <Button type="submit" size="sm" variant="primary">
          {t('apply')}
        </Button>
      </div>
    </form>
  )
}

function RowSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-3.5">
      <Skeleton className="size-11 rounded-full" />
      <div className="flex-1 space-y-2 pt-1">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-44" />
      </div>
    </div>
  )
}

function ConversationRow({ conversation: c, selected, me, onOpen }: { conversation: Conversation; selected: boolean; me: string | null; onOpen: () => void }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const visitor = useInbox((s) => s.visitors[c.id])
  const setStatus = useInbox((s) => s.setStatus)
  const claim = useInbox((s) => s.claim)
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  const name = contactName(c.contacts, language)
  const isMine = !!me && c.assigned_to === me
  const unread = c.unread_count ?? 0
  const resolved = c.status === 'resolved' || c.status === 'closed'
  const ai = (typeof c.metadata?.ai_state === 'string' ? c.metadata.ai_state : c.ai_state) === 'ai_managed'

  const doStatus = async () => {
    if (!(await setStatus(c, resolved ? 'open' : 'resolved'))) toast.error(t('saveFailed'))
  }
  const doClaim = async () => {
    if (!(await claim(c))) toast.error(t('saveFailed'))
  }

  const items: MenuItem[] = [
    { label: resolved ? t('reopen') : t('markResolved'), icon: resolved ? RotateCcw : Check, onSelect: doStatus },
    ...(c.assigned_to ? [] : [{ label: t('claim'), icon: UserCheck, onSelect: doClaim }]),
  ]

  return (
    <div
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        setContext({ x: e.clientX, y: e.clientY })
      }}
      className={cx(
        'group relative flex cursor-default gap-3 border-b border-line/60 px-4 py-3 transition-colors',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      {selected && <span className="absolute inset-y-2 start-0 w-[3px] rounded-e-full bg-brand" />}
      <Avatar name={name} imageURL={c.contacts?.avatar_url} size={44} os={visitor?.device?.os} countryCode={visitor?.geo?.country_code} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cx('truncate text-[14px]', unread ? 'font-bold text-fg' : 'font-semibold text-fg')}><bdi>{name}</bdi></span>
          {ai && <Sparkles className="size-3.5 shrink-0 self-center text-brand" />}
          <span className="flex-1" />
          <span className={cx('shrink-0 text-[11.5px]', unread ? 'font-semibold text-brand' : 'text-fg-3')}>{listTimestamp(c.last_message?.created_at ?? c.updated_at, language)}</span>
        </div>
        <div className={cx('mt-0.5 line-clamp-2 text-[13px] leading-snug', unread ? 'text-fg' : 'text-fg-2')}><bdi>{conversationPreview(c, language)}</bdi></div>
        {(unread > 0 || resolved || c.priority === 'high' || c.priority === 'urgent' || isMine || (c.tags?.length ?? 0) > 0) && (
          <div className="mt-1.5 flex items-center gap-1.5">
            {(c.priority === 'urgent' || c.priority === 'high') && (
              <Pill tone={c.priority === 'urgent' ? 'danger' : 'warning'}>{c.priority === 'urgent' ? t('priorityUrgent') : t('priorityHigh')}</Pill>
            )}
            {c.status === 'resolved' && <Pill tone="success">{t('filterResolved')}</Pill>}
            {isMine && <Pill tone="brand">{t('assignedToYou')}</Pill>}
            {(c.tags ?? []).slice(0, 2).map((tag) => (
              <Pill key={tag}>#{tag}</Pill>
            ))}
            <span className="flex-1" />
            <CountBadge count={unread} language={language} />
          </div>
        )}
      </div>
      {/* Hover actions — the desktop's swipe. */}
      <div className="absolute end-3 top-2.5 hidden items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-card group-hover:flex">
        {!c.assigned_to && <IconButton size="sm" icon={UserCheck} label={t('claim')} tone="brand" onClick={(e) => { e.stopPropagation(); void doClaim() }} />}
        <IconButton
          size="sm"
          icon={resolved ? RotateCcw : Check}
          label={resolved ? t('reopen') : t('markResolved')}
          onClick={(e) => {
            e.stopPropagation()
            void doStatus()
          }}
        />
      </div>
      {context && <ContextMenu at={context} items={items} onClose={() => setContext(null)} />}
    </div>
  )
}

export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <span ref={setAnchor} style={{ position: 'fixed', left: at.x, top: at.y, width: 0, height: 0 }} />
      <Popover anchor={anchor} open={!!anchor} onClose={onClose} align={document.documentElement.dir === 'rtl' ? 'end' : 'start'}>
        <div onClick={(e) => e.stopPropagation()}>
          <MenuList items={items} onClose={onClose} />
        </div>
      </Popover>
    </>
  )
}
