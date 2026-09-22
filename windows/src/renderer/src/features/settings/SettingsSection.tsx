import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Bell,
  Camera,
  Check,
  ExternalLink,
  Info,
  KeyRound,
  Laptop,
  LogOut,
  Monitor,
  Radio,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/api/client'
import type { Account, AccountSession, NotificationPrefs } from '@/api/types'
import { LANGUAGES } from '@/i18n'
import type { DesktopSettings } from '../../../../shared/ipc'
import { useApp, currentUser, displayNameOf, type Appearance } from '@/store/app'
import { useT } from '@/hooks/useT'
import { deviceLabel, errorText, fullDateTime } from '@/lib/format'
import { Avatar, Flag } from '@/components/Avatar'
import { BrandMark } from '@/components/Brand'
import { Button, Card, Confirm, Pill, Row, Select, Skeleton, Switch, TextField } from '@/components/ui'
import { cx } from '@/lib/cx'
import { useAvailability } from './useAvailability'

type Page = 'account' | 'general' | 'availability' | 'notifications' | 'security' | 'about'

export function SettingsSection() {
  const t = useT()
  const [page, setPage] = useState<Page>('account')
  const pages: { id: Page; icon: LucideIcon; label: string }[] = [
    { id: 'account', icon: UserRound, label: t('profile') },
    { id: 'general', icon: Monitor, label: t('general') },
    { id: 'availability', icon: Radio, label: t('availability') },
    { id: 'notifications', icon: Bell, label: t('notifications') },
    { id: 'security', icon: ShieldCheck, label: t('security') },
    { id: 'about', icon: Info, label: t('about') },
  ]
  return (
    <div className="flex h-full">
      <nav className="w-[240px] shrink-0 border-e border-line bg-surface px-3 pt-4">
        <h2 className="mb-3 px-2 text-[17px] font-bold">{t('tabSettings')}</h2>
        {pages.map((p) => (
          <button
            key={p.id}
            onClick={() => setPage(p.id)}
            className={cx(
              'mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors',
              page === p.id ? 'bg-brand-soft font-semibold text-brand' : 'text-fg hover:bg-hover',
            )}
          >
            <p.icon className="size-[18px]" strokeWidth={1.8} />
            {p.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
        <div className="mx-auto max-w-[680px] px-8 py-8">
          {page === 'account' && <AccountPage />}
          {page === 'general' && <GeneralPage />}
          {page === 'availability' && <AvailabilityPage />}
          {page === 'notifications' && <NotificationsPage />}
          {page === 'security' && <SecurityPage />}
          {page === 'about' && <AboutPage />}
        </div>
      </div>
    </div>
  )
}

function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-6 text-[22px] font-bold">{children}</h1>
}

// ---------------------------------------------------------------------------

function AccountPage() {
  const t = useT()
  const adoptProfile = useApp((s) => s.adoptProfile)
  const user = useApp(currentUser)
  const [account, setAccount] = useState<Account | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api
      .account()
      .then((a) => {
        setAccount(a)
        setName(a.profile?.full_name ?? '')
      })
      .catch(() => undefined)
  }, [])

  async function save() {
    setSaving(true)
    try {
      const updated = await api.updateProfile(name.trim() || null, null)
      setAccount(updated)
      adoptProfile(updated.profile ?? null)
      toast.success(t('saved'))
    } catch {
      toast.error(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function upload(f: File) {
    if (f.size > 5 * 1024 * 1024) {
      toast.error(t('photoTooLarge'))
      return
    }
    setPhotoBusy(true)
    try {
      const profile = await api.uploadAvatar(new Uint8Array(await f.arrayBuffer()), f.type || 'image/jpeg', f.name)
      if (profile) {
        adoptProfile(profile)
        setAccount((a) => (a ? { ...a, profile } : a))
      }
      toast.success(t('saved'))
    } catch {
      toast.error(t('saveFailed'))
    } finally {
      setPhotoBusy(false)
    }
  }

  async function removePhoto() {
    setPhotoBusy(true)
    try {
      await api.deleteAvatar()
      const profile = { ...(account?.profile ?? {}), avatar_url: null }
      adoptProfile(profile)
      setAccount((a) => (a ? { ...a, profile } : a))
    } catch {
      toast.error(t('saveFailed'))
    } finally {
      setPhotoBusy(false)
    }
  }

  const display = displayNameOf(user, account?.profile)
  return (
    <>
      <PageTitle>{t('profile')}</PageTitle>
      <div className="mb-6 flex items-center gap-5 rounded-xl border border-line bg-surface p-5 shadow-card">
        {account ? <Avatar name={display} imageURL={account.profile?.avatar_url} size={80} /> : <Skeleton className="size-20 rounded-full" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-semibold">{display}</div>
          <div className="truncate text-[13px] text-fg-2"><bdi>{account?.email ?? user?.email}</bdi></div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" icon={Camera} loading={photoBusy} onClick={() => file.current?.click()}>
              {t('changePhoto')}
            </Button>
            {account?.profile?.avatar_url && (
              <Button size="sm" variant="ghost" onClick={removePhoto} disabled={photoBusy}>
                {t('removePhoto')}
              </Button>
            )}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </div>
      </div>
      <Card title={t('displayName')}>
        <div className="flex gap-2 p-3">
          <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder={t('displayName')} className="flex-1" dir="auto" />
          <Button variant="primary" loading={saving} onClick={save} disabled={!account || name.trim() === (account.profile?.full_name ?? '')}>
            {t('save')}
          </Button>
        </div>
      </Card>
      <Card title={t('account')}>
        <Row label={t('emailLabel')}>
          <span className="text-[13px] text-fg-2" dir="ltr">{account?.email ?? user?.email}</span>
        </Row>
        {account && !account.email_confirmed_at && (
          <Row label={<span className="text-warning">{t('emailNotVerified')}</span>} icon={AlertTriangle} />
        )}
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

function GeneralPage() {
  const t = useT()
  const language = useApp((s) => s.language)
  const setLanguage = useApp((s) => s.setLanguage)
  const appearance = useApp((s) => s.appearance)
  const setAppearance = useApp((s) => s.setAppearance)
  const workspaces = useApp((s) => s.workspaces)
  const workspace = useApp((s) => s.workspace)
  const selectWorkspace = useApp((s) => s.selectWorkspace)
  const plan = useApp((s) => (s.plan.kind === 'loaded' ? s.plan.value.plan : null))
  const [desktop, setDesktop] = useState<DesktopSettings | null>(null)

  useEffect(() => {
    void window.webyar.app.getSettings().then(setDesktop)
  }, [])

  const change = async (patch: Partial<DesktopSettings>) => {
    setDesktop((d) => (d ? { ...d, ...patch } : d))
    setDesktop(await window.webyar.app.setSettings(patch))
  }

  return (
    <>
      <PageTitle>{t('general')}</PageTitle>
      <Card title={t('workspace')}>
        {workspaces.map((w) => (
          <Row key={w.id} label={w.name} onClick={workspaces.length > 1 ? () => selectWorkspace(w) : undefined}>
            <Avatar name={w.name} imageURL={w.logo_url} size={28} square />
            {w.id === workspace?.id && workspaces.length > 1 && <Check className="size-4 text-brand" />}
          </Row>
        ))}
        {plan?.name && (
          <Row label={t('plan')}>
            <Pill tone="brand">{plan.name}</Pill>
          </Row>
        )}
      </Card>
      <Card title={t('preferences')}>
        <Row label={t('language')}>
          <Select value={language} onChange={setLanguage} options={LANGUAGES.map((l) => ({ value: l.id, label: l.endonym }))} />
        </Row>
        <Row label={t('appearance')} hint={t('appearanceHint')}>
          <Select<Appearance>
            value={appearance}
            onChange={setAppearance}
            options={[
              { value: 'system', label: t('appearanceSystem') },
              { value: 'light', label: t('appearanceLight') },
              { value: 'dark', label: t('appearanceDark') },
            ]}
          />
        </Row>
      </Card>
      <Card title={t('desktop')}>
        <Row label={t('startWithWindows')} hint={t('startWithWindowsHint')}>
          <Switch checked={!!desktop?.openAtLogin} disabled={!desktop} onChange={(v) => change({ openAtLogin: v })} />
        </Row>
        <Row label={t('closeToTray')} hint={t('closeToTrayHint')}>
          <Switch checked={!!desktop?.closeToTray} disabled={!desktop} onChange={(v) => change({ closeToTray: v })} />
        </Row>
        <Row label={t('desktopNotifications')} hint={t('desktopNotificationsHint')}>
          <Switch checked={!!desktop?.desktopNotifications} disabled={!desktop} onChange={(v) => change({ desktopNotifications: v })} />
        </Row>
        <Row label={t('notificationSoundLocal')}>
          <Switch checked={!!desktop?.notificationSound} disabled={!desktop || !desktop.desktopNotifications} onChange={(v) => change({ notificationSound: v })} />
        </Row>
      </Card>
      <Card title={t('keyboardShortcuts')}>
        {[
          ['Ctrl + K', t('commandPalette')],
          ['Alt + 1 … 5', t('goTo')],
          ['Alt + ↑ / ↓', t('tabInbox')],
          ['Enter / Shift + Enter', t('enterToSend')],
          ['/', t('typeSlashHint')],
          ['Ctrl + ,', t('tabSettings')],
        ].map(([keys, label]) => (
          <Row key={keys} label={label}>
            <kbd className="rounded-md border border-line bg-elevated px-2 py-0.5 font-sans text-[12px] text-fg-2" dir="ltr">
              {keys}
            </kbd>
          </Row>
        ))}
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

function AvailabilityPage() {
  const t = useT()
  const { availability, update, failed, saving } = useAvailability()
  const online = availability?.status.state === 'online'
  return (
    <>
      <PageTitle>{t('availability')}</PageTitle>
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-line bg-surface p-5 shadow-card">
        <span className={cx('flex size-12 items-center justify-center rounded-full', online ? 'bg-success-soft text-success' : 'bg-elevated text-fg-3')}>
          <Radio className="size-6" />
        </span>
        <div className="flex-1">
          <div className="text-[12px] text-fg-3">{t('availabilitySeenAs')}</div>
          <div className={cx('text-[18px] font-bold', online ? 'text-success' : 'text-fg-2')}>{availability ? (online ? t('availabilityOnline') : t('availabilityOffline')) : '—'}</div>
          <div className="text-[12.5px] text-fg-2">{online ? t('statusOnlineHint') : t('statusOfflineHint')}</div>
        </div>
      </div>
      <Card footer={failed ? <span className="text-danger">{t('availabilitySaveFailed')}</span> : undefined}>
        <Row label={t('availabilityForceOffline')} hint={t('availabilityForceOfflineHint')}>
          <Switch checked={!!availability?.prefs.force_offline} disabled={!availability || saving} onChange={(v) => update({ force_offline: v })} />
        </Row>
        <Row label={t('availabilityWhenUsingApp')} hint={t('availabilityWhenUsingAppHint')}>
          <Switch checked={!!availability?.prefs.available_when_using_app} disabled={!availability || saving || availability.prefs.force_offline} onChange={(v) => update({ available_when_using_app: v })} />
        </Row>
        <Row label={t('availabilitySchedule')} hint={t('availabilityScheduleHint')}>
          <Switch checked={!!availability?.prefs.schedule_enabled} disabled={!availability || saving || availability.prefs.force_offline} onChange={(v) => update({ schedule_enabled: v })} />
        </Row>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

const prefsCache: { value: NotificationPrefs | null } = { value: null }

function NotificationsPage() {
  const t = useT()
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(prefsCache.value)
  const [failed, setFailed] = useState(false)
  const [desktop, setDesktop] = useState<DesktopSettings | null>(null)

  useEffect(() => {
    void api.notificationPrefs().then((p) => {
      prefsCache.value = p
      setPrefs(p)
    }).catch(() => setFailed(true))
    void window.webyar.app.getSettings().then(setDesktop)
  }, [])

  async function change(patch: Partial<NotificationPrefs>) {
    if (!prefs) return
    const previous = prefs
    const next = { ...prefs, ...patch }
    if (patch.quiet_hours_enabled && !next.quiet_hours_timezone) next.quiet_hours_timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    setPrefs(next)
    try {
      const saved = await api.updateNotificationPrefs(next)
      prefsCache.value = saved
      setPrefs(saved)
    } catch {
      setPrefs(previous)
      toast.error(t('saveFailed'))
    }
  }

  const off = !prefs || prefs.disable_all

  return (
    <>
      <PageTitle>{t('notifications')}</PageTitle>
      <Card title={t('desktop')}>
        <Row label={t('desktopNotifications')} hint={t('desktopNotificationsHint')} icon={Laptop}>
          <Switch
            checked={!!desktop?.desktopNotifications}
            disabled={!desktop}
            onChange={async (v) => setDesktop(await window.webyar.app.setSettings({ desktopNotifications: v }))}
          />
        </Row>
      </Card>
      {failed && !prefs && <div className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{t('offlineBody')}</div>}
      <Card footer={t('pushMuteAllFooter')}>
        <Row label={t('pushMuteAll')}>
          <Switch checked={!!prefs?.disable_all} disabled={!prefs} onChange={(v) => change({ disable_all: v })} />
        </Row>
      </Card>
      <Card title={t('pushScopeTitle')} footer={t('pushScopeFooter')}>
        {(['all', 'assigned', 'mentions', 'none'] as const).map((scope) => (
          <Row key={scope} label={t(scope === 'all' ? 'pushScopeAll' : scope === 'assigned' ? 'pushScopeAssigned' : scope === 'mentions' ? 'pushScopeMentions' : 'pushScopeNone')} onClick={off ? undefined : () => change({ push_scope: scope })}>
            {prefs?.push_scope === scope && <Check className={cx('size-4', off ? 'text-fg-3' : 'text-brand')} />}
          </Row>
        ))}
      </Card>
      <Card footer={t('pushShowPreviewFooter')}>
        <Row label={t('pushInternalNotes')}>
          <Switch checked={!!prefs?.push_internal_notes} disabled={off} onChange={(v) => change({ push_internal_notes: v })} />
        </Row>
        <Row label={t('pushShowPreview')}>
          <Switch checked={!!prefs?.push_preview} disabled={off} onChange={(v) => change({ push_preview: v })} />
        </Row>
        <Row label={t('pushSound')}>
          <Switch checked={!!prefs?.play_sound} disabled={off} onChange={(v) => change({ play_sound: v })} />
        </Row>
      </Card>
      <Card footer={t('pushPresenceFooter')}>
        <Row label={t('pushWhenOnline')}>
          <Switch checked={!!prefs?.push_when_online} disabled={off} onChange={(v) => change({ push_when_online: v })} />
        </Row>
        <Row label={t('pushWhenOffline')}>
          <Switch checked={!!prefs?.push_when_offline} disabled={off} onChange={(v) => change({ push_when_offline: v })} />
        </Row>
      </Card>
      <Card footer={t('pushQuietFooter')}>
        <Row label={t('pushQuietHours')}>
          <Switch checked={!!prefs?.quiet_hours_enabled} disabled={off} onChange={(v) => change({ quiet_hours_enabled: v })} />
        </Row>
        {prefs?.quiet_hours_enabled && (
          <>
            <Row label={t('pushQuietFrom')}>
              <input type="time" dir="ltr" value={prefs.quiet_hours_start ?? '22:00'} onChange={(e) => change({ quiet_hours_start: e.target.value })} className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px]" />
            </Row>
            <Row label={t('pushQuietTo')}>
              <input type="time" dir="ltr" value={prefs.quiet_hours_end ?? '08:00'} onChange={(e) => change({ quiet_hours_end: e.target.value })} className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px]" />
            </Row>
          </>
        )}
      </Card>
      <p className="px-1 text-[12px] text-fg-3">{t('notificationsServerFooter')}</p>
    </>
  )
}

// ---------------------------------------------------------------------------

function SecurityPage() {
  const t = useT()
  const language = useApp((s) => s.language)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [sessions, setSessions] = useState<AccountSession[] | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = () => api.sessions().then((r) => setSessions(r.sessions)).catch(() => setSessions([]))
  useEffect(() => {
    void load()
  }, [])

  async function change() {
    if (next.length < 8) {
      toast.error(t('passwordTooShort'))
      return
    }
    setBusy(true)
    try {
      await api.changePassword(current, next)
      toast.success(t('passwordChanged'))
      setCurrent('')
      setNext('')
    } catch (e) {
      toast.error(e instanceof ApiError && (e.status === 400 || e.status === 401 || e.status === 403) ? t('loginFailed') : errorText(e, language))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(s: AccountSession) {
    const previous = sessions
    setSessions((list) => list?.filter((x) => x.id !== s.id) ?? null)
    try {
      await api.revokeSession(s.id)
    } catch {
      setSessions(previous)
      toast.error(t('saveFailed'))
    }
  }

  async function revokeOthers() {
    for (const s of sessions ?? []) if (!s.is_current) await api.revokeSession(s.id).catch(() => undefined)
    await load()
  }

  return (
    <>
      <PageTitle>{t('security')}</PageTitle>
      <Card title={t('changePassword')} footer={t('passwordTooShort')}>
        <div className="space-y-2.5 p-4">
          <TextField icon={KeyRound} type="password" dir="ltr" placeholder={t('currentPassword')} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <TextField icon={KeyRound} type="password" dir="ltr" placeholder={t('newPassword')} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <div className="flex justify-end">
            <Button variant="primary" loading={busy} disabled={!current || !next} onClick={change}>
              {t('changePassword')}
            </Button>
          </div>
        </div>
      </Card>
      <Card
        title={
          <span className="flex items-center justify-between">
            {t('activeSessions')}
            {(sessions?.filter((s) => !s.is_current).length ?? 0) > 0 && (
              <button onClick={revokeOthers} className="text-[12px] font-medium tracking-normal text-danger normal-case hover:underline">
                {t('signOutOthers')}
              </button>
            )}
          </span>
        }
        footer={t('sessionsHint')}
      >
        {!sessions && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
        )}
        {sessions?.map((s) => (
          <Row
            key={s.id}
            icon={(s.device ?? '').toLowerCase() === 'mobile' ? Smartphone : Laptop}
            label={
              <span className="flex items-center gap-2">
                {deviceLabel(s, language)}
                {s.is_current && <Pill tone="success">{t('thisDevice')}</Pill>}
              </span>
            }
            hint={
              <span className="flex items-center gap-1.5">
                {s.country_code && <Flag code={s.country_code} width={14} />}
                {[s.city, s.country].filter(Boolean).join(', ')}
                {s.ip && <span dir="ltr">· {s.ip}</span>}
                {s.last_active_at && <span>· {t('lastActive')} {fullDateTime(s.last_active_at, language)}</span>}
              </span>
            }
          >
            {!s.is_current && (
              <Button size="sm" variant="ghost" className="text-danger" icon={LogOut} onClick={() => revoke(s)}>
                {t('signOutDevice')}
              </Button>
            )}
          </Row>
        ))}
      </Card>
      <Card>
        <Row label={t('deleteAccount')} icon={Trash2} danger onClick={() => setDeleting(true)} />
      </Card>
      <DeleteAccount open={deleting} onClose={() => setDeleting(false)} />
    </>
  )
}

function DeleteAccount({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const accountWasDeleted = useApp((s) => s.accountWasDeleted)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [owns, setOwns] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.deleteAccount(password)
      if (result.kind === 'deleted') accountWasDeleted()
      else setOwns(result.workspaces)
    } catch (e) {
      setError(errorText(e, language, t('deleteAccountWrongPassword')))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  return (
    <div className="fade-in no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div className="pop-in w-full max-w-[460px] rounded-2xl border border-line bg-surface p-6 shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-danger-soft text-danger">
          <Trash2 className="size-5" />
        </div>
        <h3 className="text-[17px] font-bold">{t('deleteAccount')}</h3>
        {owns ? (
          <>
            <div className="mt-3 font-semibold">{t('deleteAccountOwnsTitle')}</div>
            <p className="mt-1 text-[13.5px] text-fg-2">{t('deleteAccountOwnsBody', { workspaces: owns.join('، ') })}</p>
            <div className="mt-5 flex justify-end">
              <Button onClick={onClose}>{t('ok')}</Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[13.5px] text-fg-2">{t('deleteAccountBody')}</p>
            <p className="mt-2 text-[12.5px] text-fg-3">{t('deleteAccountKeeps')}</p>
            <div className="mt-4">
              <TextField type="password" dir="ltr" placeholder={t('passwordLabel')} value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="mt-1.5 text-[12px] text-fg-3">{t('deleteAccountConfirmPassword')}</p>
            </div>
            {error && <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={onClose}>{t('cancel')}</Button>
              <Button variant="danger" loading={busy} disabled={!password} onClick={() => setConfirm(true)}>
                {t('deleteAccountFinal')}
              </Button>
            </div>
          </>
        )}
        <Confirm open={confirm} title={t('deleteAccountFinal')} body={t('deleteAccountBody')} confirmLabel={t('deleteAccountFinal')} cancelLabel={t('cancel')} danger onConfirm={submit} onClose={() => setConfirm(false)} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function AboutPage() {
  const t = useT()
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.webyar.app.info>> | null>(null)
  useEffect(() => {
    void window.webyar.app.info().then(setInfo)
  }, [])
  return (
    <>
      <PageTitle>{t('about')}</PageTitle>
      <div className="mb-6 flex flex-col items-center gap-3 rounded-xl border border-line bg-surface py-10 shadow-card">
        <BrandMark size={64} />
        <div className="text-[18px] font-extrabold tracking-[0.2em] text-brand" dir="ltr" style={{ fontFamily: "'Inter Variable'" }}>
          WEBYAR
        </div>
        <div className="text-[13px] text-fg-2">{t('desktopTagline')}</div>
      </div>
      <Card>
        <Row label={t('version')}>
          <span className="text-[13px] text-fg-2" dir="ltr">
            {info?.version ?? '—'} · Windows
          </span>
        </Row>
        <Row label={t('serverAddress')}>
          <span className="text-[13px] text-fg-2" dir="ltr">{info?.apiOrigin.replace(/^https:\/\//, '') ?? '—'}</span>
        </Row>
        {info?.supportUrl && (
          <Row label={<span className="text-brand">{t('support')}</span>} onClick={() => void window.webyar.app.openExternal(info.supportUrl!)}>
            <ExternalLink className="size-4 text-fg-3" />
          </Row>
        )}
      </Card>
    </>
  )
}
