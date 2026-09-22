import { useEffect, useState } from 'react'
import { AtSign, ChevronDown, Inbox, LogOut, Mail, Moon, Search, Settings, Sun, Users, type LucideIcon } from 'lucide-react'
import { useApp, colleaguesVisible, contactsVisible, emailVisible, currentUser, displayNameOf, type Section } from '@/store/app'
import { useT } from '@/hooks/useT'
import { Avatar } from '@/components/Avatar'
import { BrandMark } from '@/components/Brand'
import { Confirm, CountBadge, Menu } from '@/components/ui'
import { cx } from '@/lib/cx'
import { InboxSection } from '@/features/inbox/InboxSection'
import { ColleaguesSection } from '@/features/colleagues/ColleaguesSection'
import { EmailSection } from '@/features/email/EmailSection'
import { ContactsSection } from '@/features/contacts/ContactsSection'
import { SettingsSection } from '@/features/settings/SettingsSection'
import { CallOverlay } from '@/features/calls/CallOverlay'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { BackgroundSync } from '@/features/notifications/BackgroundSync'
import { PromoFullScreen } from '@/features/promotions/Promotions'
import { useAvailability } from '@/features/settings/useAvailability'
import { toast } from 'sonner'

export function Shell() {
  const section = useApp((s) => s.section)
  const go = useApp((s) => s.go)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const showContacts = useApp(contactsVisible)
  const showColleagues = useApp(colleaguesVisible)
  const showEmail = useApp(emailVisible)

  // A plan change can remove the section that is open; fall back to the inbox.
  useEffect(() => {
    if ((section === 'contacts' && !showContacts) || (section === 'colleagues' && !showColleagues) || (section === 'email' && !showEmail)) {
      const plan = useApp.getState().plan
      if (plan.kind !== 'loading') go('inbox')
    }
  }, [section, showContacts, showColleagues, showEmail, go])

  // Desktop keyboard: Ctrl+K searches everything, Alt+1…5 moves between sections.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.altKey && /^[1-5]$/.test(e.key)) {
        const order: Section[] = ['inbox', 'colleagues', 'email', 'contacts', 'settings']
        const target = order[Number(e.key) - 1]
        e.preventDefault()
        go(target)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        go('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, setPaletteOpen])

  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <main className="min-w-0 flex-1 overflow-hidden border-s border-line bg-surface">
          {section === 'inbox' && <InboxSection />}
          {section === 'colleagues' && <ColleaguesSection />}
          {section === 'email' && <EmailSection />}
          {section === 'contacts' && <ContactsSection />}
          {section === 'settings' && <SettingsSection />}
        </main>
      </div>
      <BackgroundSync />
      <CommandPalette />
      <CallOverlay />
      <PromoFullScreen />
    </div>
  )
}

function TitleBar() {
  const t = useT()
  const workspaces = useApp((s) => s.workspaces)
  const workspace = useApp((s) => s.workspace)
  const selectWorkspace = useApp((s) => s.selectWorkspace)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const plan = useApp((s) => (s.plan.kind === 'loaded' ? s.plan.value.plan : null))

  return (
    // The native minimize/maximize/close buttons are drawn over the right-hand 140px on
    // Windows whatever the text direction, so that strip stays clear in both.
    <header className="drag flex h-11 shrink-0 items-center gap-3 bg-bg pr-[150px] pl-3" dir="ltr">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <BrandMark size={24} />
        <Menu
          items={[
            { kind: 'header', label: t('selectWorkspace') },
            ...workspaces.map((w) => ({
              label: w.name,
              checked: w.id === workspace?.id,
              onSelect: () => selectWorkspace(w),
            })),
          ]}
          trigger={({ ref, onClick }) => (
            <button
              ref={ref}
              onClick={onClick}
              disabled={workspaces.length < 2}
              className="no-drag flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] font-semibold text-fg hover:bg-hover disabled:hover:bg-transparent"
            >
              <span className="truncate"><bdi>{workspace?.name ?? '—'}</bdi></span>
              {plan?.name && <span className="rounded bg-brand-soft px-1.5 py-px text-[10.5px] font-bold text-brand">{plan.name}</span>}
              {workspaces.length > 1 && <ChevronDown className="size-3.5 text-fg-3" />}
            </button>
          )}
        />
      </div>
      <button
        onClick={() => setPaletteOpen(true)}
        className="no-drag flex h-7 w-[340px] max-w-[36vw] items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] text-fg-3 shadow-card transition-colors hover:border-line-strong"
        dir={document.documentElement.dir}
      >
        <Search className="size-3.5" />
        <span className="flex-1 truncate text-start">{t('commandPalette')}</span>
        <kbd className="rounded border border-line bg-elevated px-1 font-sans text-[10.5px] text-fg-2" dir="ltr">Ctrl K</kbd>
      </button>
      <div className="flex-1" />
    </header>
  )
}

function Rail() {
  const t = useT()
  const section = useApp((s) => s.section)
  const go = useApp((s) => s.go)
  const inboxUnread = useApp((s) => s.inboxUnread)
  const colleaguesUnread = useApp((s) => s.colleaguesUnread)
  const language = useApp((s) => s.language)
  const showContacts = useApp(contactsVisible)
  const showColleagues = useApp(colleaguesVisible)
  const showEmail = useApp(emailVisible)

  const items: { id: Section; icon: LucideIcon; label: string; badge?: number; visible: boolean; shortcut: string }[] = [
    { id: 'inbox', icon: Inbox, label: t('tabInbox'), badge: inboxUnread, visible: true, shortcut: 'Alt+1' },
    { id: 'colleagues', icon: AtSign, label: t('colleagues'), badge: colleaguesUnread, visible: showColleagues, shortcut: 'Alt+2' },
    { id: 'email', icon: Mail, label: t('emailInbox'), visible: showEmail, shortcut: 'Alt+3' },
    { id: 'contacts', icon: Users, label: t('tabContacts'), visible: showContacts, shortcut: 'Alt+4' },
  ]

  return (
    <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1 bg-bg pt-1 pb-3">
      {items
        .filter((i) => i.visible)
        .map((item) => (
          <RailButton key={item.id} {...item} active={section === item.id} onClick={() => go(item.id)} language={language} />
        ))}
      <div className="flex-1" />
      <RailButton id="settings" icon={Settings} label={t('tabSettings')} active={section === 'settings'} onClick={() => go('settings')} language={language} keyHint="Ctrl+," />
      <MeButton />
    </nav>
  )
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
  language,
  keyHint,
  shortcut,
}: {
  id: string
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
  badge?: number
  language: string
  keyHint?: string
  shortcut?: string
}) {
  return (
    <button
      onClick={onClick}
      title={`${label}${keyHint || shortcut ? ` (${keyHint ?? shortcut})` : ''}`}
      className={cx('group relative flex w-[64px] flex-col items-center gap-1 rounded-xl py-2 transition-colors', active ? 'text-brand' : 'text-fg-2 hover:text-fg')}
    >
      <span className={cx('flex h-8 w-11 items-center justify-center rounded-lg transition-colors', active ? 'bg-brand-soft' : 'group-hover:bg-hover')}>
        <Icon className="size-[19px]" strokeWidth={active ? 2.2 : 1.8} />
      </span>
      <span className={cx('max-w-full truncate px-0.5 text-[11px]', active ? 'font-semibold' : 'font-medium')}>{label}</span>
      {badge ? (
        <span className="absolute top-1 end-2">
          <CountBadge count={badge} language={language} />
        </span>
      ) : null}
    </button>
  )
}

function MeButton() {
  const t = useT()
  const user = useApp(currentUser)
  const profile = useApp((s) => s.profile)
  const signOut = useApp((s) => s.signOut)
  const go = useApp((s) => s.go)
  const appearance = useApp((s) => s.appearance)
  const setAppearance = useApp((s) => s.setAppearance)
  const { availability, update } = useAvailability()
  const [confirm, setConfirm] = useState(false)
  const online = availability?.status.state === 'online'
  const name = displayNameOf(user, profile)
  const dark = appearance === 'dark' || (appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <>
      <Menu
        side="top"
        items={[
          { kind: 'header', label: name },
          {
            label: online ? t('availabilityOnline') : t('availabilityOffline'),
            icon: undefined,
            trailing: <span className={cx('size-2.5 rounded-full', online ? 'bg-success' : 'bg-fg-3')} />,
            hint: t('availabilityForceOffline'),
            onSelect: () => void update({ force_offline: online }),
          },
          { kind: 'separator', label: '' },
          { label: t('profile'), icon: Users, onSelect: () => go('settings') },
          { label: t('toggleTheme'), icon: dark ? Sun : Moon, onSelect: () => setAppearance(dark ? 'light' : 'dark') },
          { kind: 'separator', label: '' },
          { label: t('signOut'), icon: LogOut, danger: true, onSelect: () => setConfirm(true) },
        ]}
        trigger={({ ref, onClick }) => (
          <button ref={ref} onClick={onClick} className="mt-2 rounded-full p-0.5 transition-shadow hover:ring-2 hover:ring-brand-soft" title={name}>
            <Avatar name={name} imageURL={profile?.avatar_url} size={36} status={availability ? (online ? 'online' : 'offline') : null} />
          </button>
        )}
      />
      <Confirm
        open={confirm}
        title={t('signOutConfirm')}
        confirmLabel={t('signOut')}
        cancelLabel={t('cancel')}
        danger
        onConfirm={async () => {
          if (!(await signOut())) toast.error(t('signOutFailed'))
        }}
        onClose={() => setConfirm(false)}
      />
    </>
  )
}
