import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, CornerDownLeft, Globe, Inbox, Mail, Moon, Search, Settings, Users, type LucideIcon } from 'lucide-react'
import { LANGUAGES } from '@/i18n'
import { useApp, colleaguesVisible, contactsVisible, emailVisible } from '@/store/app'
import { useT } from '@/hooks/useT'
import { contactName } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { cx } from '@/lib/cx'
import { useInbox } from '@/features/inbox/inboxStore'
import { colleagueName, useColleagues } from '@/features/colleagues/colleaguesStore'
import { conversationPreview } from '@/features/inbox/inboxStore'

interface Item {
  id: string
  group: string
  title: string
  subtitle?: string
  icon?: LucideIcon
  avatar?: { name: string; url?: string | null }
  run: () => void
}

/** Ctrl+K: every conversation, colleague and screen, one search away. */
export function CommandPalette() {
  const t = useT()
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPaletteOpen)
  const language = useApp((s) => s.language)
  const inbox = useInbox((s) => s.state)
  const colleagues = useColleagues((s) => s.data)
  const showColleagues = useApp(colleaguesVisible)
  const showContacts = useApp(contactsVisible)
  const showEmail = useApp(emailVisible)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const s = useApp.getState()
    const close = (fn: () => void) => () => {
      fn()
      setOpen(false)
    }
    const nav: Item[] = [
      { id: 'go-inbox', group: t('goTo'), title: t('tabInbox'), icon: Inbox, run: close(() => s.go('inbox')) },
      ...(showColleagues ? [{ id: 'go-col', group: t('goTo'), title: t('colleagues'), icon: AtSign, run: close(() => s.go('colleagues')) }] : []),
      ...(showEmail ? [{ id: 'go-email', group: t('goTo'), title: t('emailInbox'), icon: Mail, run: close(() => s.go('email')) }] : []),
      ...(showContacts ? [{ id: 'go-contacts', group: t('goTo'), title: t('tabContacts'), icon: Users, run: close(() => s.go('contacts')) }] : []),
      { id: 'go-settings', group: t('goTo'), title: t('tabSettings'), icon: Settings, run: close(() => s.go('settings')) },
      { id: 'theme', group: t('actions'), title: t('toggleTheme'), icon: Moon, run: close(() => s.setAppearance(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')) },
      ...LANGUAGES.filter((l) => l.id !== language).map((l) => ({ id: `lang-${l.id}`, group: t('actions'), title: `${t('switchLanguage')}: ${l.endonym}`, icon: Globe, run: close(() => s.setLanguage(l.id)) })),
    ]
    const conversations: Item[] =
      inbox.kind === 'loaded'
        ? inbox.conversations.map((c) => ({
            id: `c-${c.id}`,
            group: t('tabInbox'),
            title: contactName(c.contacts, language),
            subtitle: conversationPreview(c, language),
            avatar: { name: contactName(c.contacts, language), url: c.contacts?.avatar_url },
            run: close(() => s.openConversation(c.id)),
          }))
        : []
    const team: Item[] = showColleagues
      ? (colleagues?.colleagues ?? []).map((c) => ({
          id: `t-${c.user_id}`,
          group: t('colleagues'),
          title: colleagueName(c),
          subtitle: c.email ?? undefined,
          avatar: { name: colleagueName(c), url: c.avatar_url },
          run: close(() => s.openColleague(c.user_id)),
        }))
      : []
    const q = query.trim().toLowerCase()
    const all = [...conversations, ...team, ...nav]
    if (!q) return [...conversations.slice(0, 6), ...nav]
    return all.filter((i) => i.title.toLowerCase().includes(q) || i.subtitle?.toLowerCase().includes(q)).slice(0, 40)
  }, [query, inbox, colleagues, language, t, setOpen, showColleagues, showContacts, showEmail])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null
  let lastGroup = ''
  return createPortal(
    <div className="fade-in no-drag fixed inset-0 z-[65] flex justify-center bg-black/30 pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div className="pop-in flex h-fit max-h-[70vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-5 text-fg-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(items.length - 1, i + 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              }
              if (e.key === 'Enter') items[index]?.run()
            }}
            placeholder={t('commandPalette')}
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-3"
          />
          <kbd className="rounded border border-line bg-elevated px-1.5 text-[11px] text-fg-3">Esc</kbd>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.length === 0 && <div className="p-8 text-center text-[13px] text-fg-3">{t('commandPaletteEmpty')}</div>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{header}</div>}
                <button
                  data-index={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={item.run}
                  className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start', i === index ? 'bg-brand-soft' : '')}
                >
                  {item.avatar ? (
                    <Avatar name={item.avatar.name} imageURL={item.avatar.url} size={30} />
                  ) : item.icon ? (
                    <span className="flex size-[30px] items-center justify-center rounded-lg bg-elevated text-fg-2">
                      <item.icon className="size-4" />
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium"><bdi>{item.title}</bdi></span>
                    {item.subtitle && <span className="block truncate text-[12px] text-fg-3"><bdi>{item.subtitle}</bdi></span>}
                  </span>
                  {i === index && <CornerDownLeft className="size-4 text-brand" />}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
