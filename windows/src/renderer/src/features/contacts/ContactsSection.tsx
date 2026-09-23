import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarDays, Copy, Fingerprint, Mail, MapPin, Monitor, Phone, Search, Users, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import type { Contact, VisitorProfile } from '@/api/types'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'
import { contactName, dayHeader, deviceLabel, errorText, parseDate } from '@/lib/format'
import { Avatar, Flag } from '@/components/Avatar'
import { EmptyState, ErrorState, IconButton, Skeleton, TextField } from '@/components/ui'
import { cx } from '@/lib/cx'

export function ContactsSection() {
  const t = useT()
  const language = useApp((s) => s.language)
  const workspaceId = useApp((s) => s.workspace?.id ?? null)
  const selected = useApp((s) => s.contactId)
  const open = useApp((s) => s.openContact)
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [visitors, setVisitors] = useState<Record<string, VisitorProfile>>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [query, setQuery] = useState('')

  async function load() {
    if (!workspaceId) return
    setError(null)
    try {
      const list = await api.contacts(workspaceId)
      setContacts(list)
      void api
        .visitorIntel(workspaceId, { contactIds: list.map((c) => c.id) })
        .then((r) => setVisitors(r.byContact))
        .catch(() => undefined)
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('transport'))
    }
  }

  useEffect(() => {
    setContacts(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (contacts ?? [])
      .filter((c) => !q || [c.name, c.email, c.phone, c.visitor_code].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => contactName(a, language).localeCompare(contactName(b, language), language))
  }, [contacts, query, language])

  const contact = contacts?.find((c) => c.id === selected) ?? null

  return (
    <div className="flex h-full">
      <aside className="flex h-full w-[340px] shrink-0 flex-col bg-surface">
        <div className="px-4 pt-4 pb-3">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[17px] font-bold">{t('tabContacts')}</h2>
            {contacts && <span className="text-[12px] text-fg-3">{t('contactsCount', { n: contacts.length })}</span>}
          </div>
          <TextField icon={Search} placeholder={t('contactsSearch')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          {!contacts && !error && Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex gap-3 px-4 py-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2.5 w-40" />
              </div>
            </div>
          ))}
          {error && <ErrorState icon={WifiOff} title={t('offlineTitle')} body={errorText(error, language)} retryLabel={t('retry')} onRetry={load} />}
          {contacts && list.length === 0 && <EmptyState icon={Users} title={query ? t('noResults') : t('contactsEmptyTitle')} body={query ? undefined : t('contactsEmptyBody')} />}
          {list.map((c) => {
            const v = visitors[c.id]
            const active = c.id === selected
            return (
              <button key={c.id} onClick={() => open(c.id)} className={cx('relative flex w-full items-center gap-3 border-b border-line/60 px-4 py-2.5 text-start transition-colors', active ? 'bg-selected' : 'hover:bg-hover')}>
                {active && <span className="absolute inset-y-2 start-0 w-[3px] rounded-e-full bg-brand" />}
                <Avatar name={contactName(c, language)} imageURL={c.avatar_url} size={40} os={v?.device?.os} countryCode={v?.geo?.country_code} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold"><bdi>{contactName(c, language)}</bdi></div>
                  <div dir="auto" className="bidi-line truncate text-[12.5px] text-fg-2">{c.email || c.phone || c.visitor_code || ''}</div>
                </div>
              </button>
            )
          })}
        </div>
      </aside>
      <div className="min-w-0 flex-1 border-s border-line">
        {contact ? (
          <ContactDetail key={contact.id} contact={contact} visitor={visitors[contact.id] ?? null} />
        ) : (
          <div className="h-full bg-bg/50">
            <EmptyState icon={Users} title={t('noContactSelected')} />
          </div>
        )}
      </div>
    </div>
  )
}

function ContactDetail({ contact, visitor }: { contact: Contact; visitor: VisitorProfile | null }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const name = contactName(contact, language)
  const created = parseDate(contact.created_at)
  return (
    <div className="selectable h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[640px] px-8 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <Avatar name={name} imageURL={contact.avatar_url} size={96} os={visitor?.device?.os} countryCode={visitor?.geo?.country_code} />
          <h2 className="text-[22px] font-bold" dir="auto">{name}</h2>
        </div>
        <div className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {contact.email && <Detail icon={Mail} label={t('emailLabel')} value={contact.email} copyable />}
          {contact.phone && <Detail icon={Phone} label={t('phoneLabel')} value={contact.phone} copyable />}
          {contact.visitor_code && <Detail icon={Fingerprint} label={t('unknownVisitor')} value={contact.visitor_code} copyable />}
          {visitor?.geo && (visitor.geo.city || visitor.geo.country) && (
            <Detail
              icon={MapPin}
              label={t('visitorLocation')}
              value={[visitor.geo.city, visitor.geo.country].filter(Boolean).join(', ')}
              trailing={visitor.geo.country_code ? <Flag code={visitor.geo.country_code} width={20} /> : null}
            />
          )}
          {visitor?.device && <Detail icon={Monitor} label={t('visitorDevice')} value={deviceLabel(visitor.device, language)} />}
          {created && <Detail icon={CalendarDays} label={t('firstSeen')} value={dayHeader(created, language)} />}
        </div>
      </div>
    </div>
  )
}

function Detail({ icon: Icon, label, value, copyable, trailing }: { icon: typeof Mail; label: string; value: string; copyable?: boolean; trailing?: ReactNode }) {
  const t = useT()
  return (
    <div className="group flex items-center gap-3 px-4 py-3">
      <Icon className="size-[18px] shrink-0 text-fg-3" />
      <span className="w-32 shrink-0 text-[13px] text-fg-2">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px]"><bdi>{value}</bdi></span>
      {trailing}
      {copyable && (
        <IconButton
          size="sm"
          icon={Copy}
          label={t('copy')}
          className="opacity-0 group-hover:opacity-100"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            toast.success(t('copied'))
          }}
        />
      )}
    </div>
  )
}
