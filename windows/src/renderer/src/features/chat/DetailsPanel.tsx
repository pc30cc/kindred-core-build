import { useState, type ReactNode } from 'react'
import { Hash, Lock, Mail, MapPin, Monitor, Send, StickyNote, Trash2, UserRound, X } from 'lucide-react'
import type { Conversation, ConversationPriority, VisitorProfile } from '@/api/types'
import { useApp, currentUser } from '@/store/app'
import { useT } from '@/hooks/useT'
import { channelKeyOf, channelTitle, contactName, deviceLabel, fullDateTime } from '@/lib/format'
import { Avatar, Flag } from '@/components/Avatar'
import { Button, IconButton, Select, Skeleton, TextArea } from '@/components/ui'
import { memberName, type useConversationActions } from './useConversation'
import { StatusDot } from './ChatPane'
import { STATUS_TITLE } from './status'

type Actions = ReturnType<typeof useConversationActions>

const PRIORITY_KEY = { low: 'priorityLow', normal: 'priorityNormal', high: 'priorityHigh', urgent: 'priorityUrgent' } as const

export function DetailsPanel({ conversation, actions, visitor }: { conversation: Conversation; actions: Actions; visitor: VisitorProfile | null }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const me = useApp(currentUser)
  const name = contactName(conversation.contacts, language)
  const channel = channelKeyOf(conversation.metadata)

  return (
    <aside className="selectable flex w-[320px] shrink-0 flex-col overflow-y-auto border-s border-line bg-surface">
      <div className="flex flex-col items-center gap-2 border-b border-line px-5 pt-6 pb-5 text-center">
        <Avatar name={name} imageURL={conversation.contacts?.avatar_url} size={72} os={visitor?.device?.os} countryCode={visitor?.geo?.country_code} />
        <div className="mt-1 text-[16px] font-semibold" dir="auto">{name}</div>
        {conversation.contacts?.visitor_code && <div className="text-[12px] text-fg-3" dir="ltr">{conversation.contacts.visitor_code}</div>}
      </div>

      <Group title={t('contactInfo')}>
        {conversation.contacts?.email && <Info icon={Mail} value={conversation.contacts.email} latin />}
        {visitor?.geo && (visitor.geo.city || visitor.geo.country) && (
          <Info icon={MapPin} value={[visitor.geo.city, visitor.geo.country].filter(Boolean).join(', ')} trailing={visitor.geo.country_code ? <Flag code={visitor.geo.country_code} /> : null} />
        )}
        {visitor?.device && <Info icon={Monitor} value={deviceLabel(visitor.device, language)} />}
        <Info icon={Send} value={channelTitle(channel, language)} />
        {!conversation.contacts?.email && !visitor && <Info icon={UserRound} value={t('unknownVisitor')} />}
      </Group>

      <Group title={t('conversationInfo')}>
        <Field label={t('status')}>
          <Select
            value={actions.status}
            onChange={actions.setStatus}
            options={(['open', 'pending', 'resolved', 'closed'] as const).map((s) => ({ value: s, label: t(STATUS_TITLE[s]) }))}
          />
        </Field>
        <Field label={t('priority')}>
          <Select<ConversationPriority>
            value={actions.priority}
            onChange={actions.setPriority}
            options={(['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ value: p, label: t(PRIORITY_KEY[p]) }))}
          />
        </Field>
        <Field label={t('assignee')}>
          <Select<string>
            value={actions.assignedTo ?? '__none'}
            onChange={(v) => actions.assign(v === '__none' ? null : v)}
            options={[
              { value: '__none', label: t('unassigned') },
              ...actions.members.map((m) => ({ value: m.user_id, label: m.user_id === me?.id ? `${memberName(m)} (${t('you')})` : memberName(m) })),
              ...(actions.assignedTo && !actions.members.some((m) => m.user_id === actions.assignedTo) ? [{ value: actions.assignedTo, label: '—' }] : []),
            ]}
            className="max-w-[170px]"
          />
        </Field>
        {me && actions.assignedTo !== me.id && (
          <div className="px-4 pb-2">
            <Button size="sm" variant="soft" className="w-full" onClick={() => actions.assign(me.id)}>
              {t('assignToMe')}
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 px-4 pt-1 pb-3 text-[11.5px] text-fg-3">
          <StatusDot status={actions.status} />
          {fullDateTime(conversation.created_at, language)}
        </div>
      </Group>

      <Group title={t('tags')}>
        <Tags actions={actions} />
      </Group>

      <Group title={t('internalNotes')} icon={Lock}>
        <Notes actions={actions} />
      </Group>
    </aside>
  )
}

function Group({ title, children, icon: Icon }: { title: string; children: ReactNode; icon?: typeof Lock }) {
  return (
    <section className="border-b border-line py-3">
      <h4 className="flex items-center gap-1.5 px-4 pb-2 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
        {Icon && <Icon className="size-3" />}
        {title}
      </h4>
      {children}
    </section>
  )
}

function Info({ icon: Icon, value, latin, trailing }: { icon: typeof Mail; value: string; latin?: boolean; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-1.5 text-[13px]">
      <Icon className="size-4 shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate" title={value}>
        <bdi>{value}</bdi>
      </span>
      {trailing}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-1.5">
      <span className="text-[13px] text-fg-2">{label}</span>
      {children}
    </div>
  )
}

function Tags({ actions }: { actions: Actions }) {
  const t = useT()
  const [draft, setDraft] = useState('')
  return (
    <div className="px-4">
      <div className="flex flex-wrap gap-1.5">
        {actions.tags.length === 0 && <span className="text-[12.5px] text-fg-3">{t('noTags')}</span>}
        {actions.tags.map((tag) => (
          <span key={tag} className="group inline-flex items-center gap-1 rounded-md bg-elevated py-0.5 ps-2 pe-1 text-[12px] font-medium text-fg-2">
            <Hash className="size-3" />
            {tag}
            <button onClick={() => actions.removeTag(tag)} className="rounded p-0.5 opacity-50 hover:bg-hover hover:opacity-100" title={t('removeTag')}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            actions.addTag(draft)
            setDraft('')
          }
        }}
        placeholder={t('tagPlaceholder')}
        className="mt-2 h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-[12.5px] outline-none placeholder:text-fg-3 focus:border-brand"
      />
    </div>
  )
}

function Notes({ actions }: { actions: Actions }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [draft, setDraft] = useState('')
  const notes = actions.notes
  return (
    <div className="px-4">
      <p className="mb-2 text-[11.5px] text-fg-3">{t('notesPrivacyNote')}</p>
      <TextArea
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('writeNote')}
        dir="auto"
        onKeyDown={async (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) {
            if (await actions.addNote(draft)) setDraft('')
          }
        }}
        className="bg-[color-mix(in_oklab,var(--warning)_6%,var(--surface))]"
      />
      <div className="mt-1.5 flex justify-end">
        <Button size="sm" variant="soft" icon={StickyNote} disabled={!draft.trim()} loading={actions.busy} onClick={async () => (await actions.addNote(draft)) && setDraft('')}>
          {t('addNote')}
        </Button>
      </div>
      <div className="mt-2 space-y-2 pb-1">
        {notes.kind === 'loading' && <Skeleton className="h-14 w-full" />}
        {notes.kind === 'loaded' && notes.value.length === 0 && <div className="text-[12.5px] text-fg-3">{t('noNotes')}</div>}
        {notes.kind === 'loaded' &&
          notes.value.map((n) => (
            <div key={n.id} className="group rounded-lg border border-warning/25 bg-warning-soft/60 p-2.5">
              <div className="text-[13px] whitespace-pre-wrap text-fg" dir="auto">{n.body}</div>
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-fg-3">
                <span className="truncate">{n.author?.full_name || n.author?.email || ''}</span>
                <span>·</span>
                <span>{fullDateTime(n.created_at, language)}</span>
                <span className="flex-1" />
                <IconButton size="sm" icon={Trash2} label={t('deleteNote')} tone="danger" className="opacity-0 group-hover:opacity-100" onClick={() => void actions.deleteNote(n)} />
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

