import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Eye, EyeOff, Globe, Headphones, Lock, Mail, MailCheck, MessagesSquare, Server, Sparkles, Users } from 'lucide-react'
import { api, ApiError } from '@/api/client'
import { LANGUAGES, isRTL } from '@/i18n'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'
import { errorText } from '@/lib/format'
import { Button, Dialog, Menu, TextField } from '@/components/ui'
import { cx } from '@/lib/cx'
import { BrandMark } from '@/components/Brand'

type Mode = 'login' | 'reset' | 'sent'

export function LoginScreen() {
  const t = useT()
  const language = useApp((s) => s.language)
  const setLanguage = useApp((s) => s.setLanguage)
  const signedIn = useApp((s) => s.signedIn)
  const ended = useApp((s) => s.sessionEndedMessage)
  const clearEnded = useApp((s) => s.clearSessionEndedMessage)

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverOpen, setServerOpen] = useState(false)
  const [origin, setOrigin] = useState('')

  useEffect(() => {
    void window.webyar.app.info().then((i) => setOrigin(i.apiOrigin))
  }, [serverOpen])

  const canSubmit = email.trim().includes('@') && (mode !== 'login' || password.length > 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    clearEnded()
    try {
      if (mode === 'login') {
        const user = await api.login(email.trim(), password)
        await signedIn(user)
      } else {
        await api.requestPasswordReset(email.trim(), language)
        setMode('sent')
      }
    } catch (err) {
      if (mode === 'login' && err instanceof ApiError && (err.kind === 'unauthorized' || err.status === 400 || err.status === 401)) {
        setError(t('loginFailed'))
      } else {
        setError(errorText(err, language, t('loginFailed')))
      }
    } finally {
      setBusy(false)
    }
  }

  const Forward = isRTL(language) ? ArrowLeft : ArrowRight
  const BackIcon = isRTL(language) ? ArrowRight : ArrowLeft

  return (
    <div className="flex h-full">
      {/* The brand side. */}
      <div className="drag relative hidden w-[44%] max-w-[560px] flex-col justify-between overflow-hidden p-10 text-white lg:flex" style={{ background: 'linear-gradient(150deg, #2a5fd0 0%, #3b7af2 45%, #6a4de0 100%)' }}>
        <div className="pointer-events-none absolute -top-40 -end-40 size-[420px] rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 -start-24 size-[360px] rounded-full bg-black/10 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <BrandMark size={40} />
          <span dir="ltr" className="text-[20px] font-extrabold tracking-[0.2em]" style={{ fontFamily: "'Inter Variable'" }}>WEBYAR</span>
        </div>
        <div className="relative">
          <h1 className="text-[30px] leading-tight font-bold">{t('desktopTagline')}</h1>
          <ul className="mt-8 space-y-4 text-[14px] text-white/90">
            {[
              { icon: MessagesSquare, text: `${t('tabInbox')} · Telegram · WhatsApp · ${language === 'fa' ? 'بله' : 'Bale'}` },
              { icon: Sparkles, text: t('filterAI') },
              { icon: Headphones, text: `${t('voiceCall')} · ${t('videoCall')}` },
              { icon: Users, text: t('colleagues') },
              { icon: Mail, text: t('emailInbox') },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-white/15"><Icon className="size-4" /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative text-[12px] text-white/60">© Webyar</div>
      </div>

      {/* The form side. */}
      <div className="relative flex flex-1 flex-col bg-bg">
        <div className="drag flex h-11 items-center justify-end gap-1 pr-[150px] pl-3">
          <Menu
            align="end"
            items={LANGUAGES.map((l) => ({ label: l.endonym, checked: l.id === language, onSelect: () => setLanguage(l.id) }))}
            trigger={({ ref, onClick }) => (
              <Button ref={ref} onClick={onClick} variant="ghost" size="sm" icon={Globe}>
                {LANGUAGES.find((l) => l.id === language)?.endonym}
              </Button>
            )}
          />
          <Button variant="ghost" size="sm" icon={Server} onClick={() => setServerOpen(true)}>
            {t('serverAddress')}
          </Button>
        </div>

        <div className="flex flex-1 items-center justify-center p-8">
          <form onSubmit={submit} className="pop-in w-full max-w-[380px]">
            <div className="mb-8 flex flex-col items-center gap-4 text-center">
              <BrandMark size={52} />
              {mode === 'sent' ? (
                <>
                  <MailCheck className="size-10 text-success" />
                  <div>
                    <h2 className="text-[22px] font-bold">{t('resetSentTitle')}</h2>
                    <p className="mt-2 text-[13.5px] text-fg-2">{t('resetSentDetail', { email: email.trim() })}</p>
                    <p className="mt-2 text-[12.5px] text-fg-3">{t('resetCheckSpam')}</p>
                  </div>
                </>
              ) : (
                <div>
                  <h2 className="text-[24px] font-bold">{mode === 'login' ? t('loginTitle') : t('resetTitle')}</h2>
                  <p className="mt-1.5 text-[13.5px] text-fg-2">{mode === 'login' ? t('loginSubtitle') : t('resetSubtitle')}</p>
                </div>
              )}
            </div>

            {ended && mode === 'login' && (
              <div className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning">{ended}</div>
            )}

            {mode !== 'sent' && (
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{t('emailLabel')}</span>
                  <TextField
                    icon={Mail}
                    type="email"
                    dir="ltr"
                    autoFocus
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="[&_input]:h-11 [&_input]:text-[14px]"
                  />
                </label>
                {mode === 'login' && (
                  <label className="block">
                    <span className="mb-1.5 flex items-center justify-between text-[12.5px] font-medium text-fg-2">
                      {t('passwordLabel')}
                      <button type="button" onClick={() => { setMode('reset'); setError(null) }} className="text-brand hover:underline">
                        {t('forgotPassword')}
                      </button>
                    </span>
                    <TextField
                      icon={Lock}
                      type={reveal ? 'text' : 'password'}
                      dir="ltr"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="[&_input]:h-11 [&_input]:text-[14px]"
                      trailing={
                        <button type="button" onClick={() => setReveal((r) => !r)} className="flex size-8 items-center justify-center rounded-md text-fg-3 hover:text-fg" title={reveal ? t('hidePassword') : t('showPassword')}>
                          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      }
                    />
                  </label>
                )}
              </div>
            )}

            {error && <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>}

            <div className="mt-6 space-y-3">
              {mode !== 'sent' && (
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!canSubmit}>
                  {mode === 'login' ? t('logIn') : t('sendResetLink')}
                  {!busy && <Forward className="size-4" />}
                </Button>
              )}
              {mode !== 'login' && (
                <Button type="button" variant="ghost" className="w-full" icon={BackIcon} onClick={() => { setMode('login'); setError(null) }}>
                  {t('backToLogin')}
                </Button>
              )}
            </div>
          </form>
        </div>
        <div className="pb-4 text-center text-[11.5px] text-fg-3">
          <span dir="ltr" className={cx('latin')}>{origin.replace(/^https:\/\//, '')}</span>
        </div>
      </div>

      <ServerDialog open={serverOpen} onClose={() => setServerOpen(false)} current={origin} />
    </div>
  )
}

function ServerDialog({ open, onClose, current }: { open: boolean; onClose: () => void; current: string }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    if (open) {
      setValue(current)
      setError(false)
    }
  }, [open, current])

  async function save(v: string | null) {
    try {
      await window.webyar.api.setServer(v)
      await window.webyar.api.refreshOrigin()
      onClose()
    } catch {
      setError(true)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('serverAddress')}
      footer={
        <>
          <Button variant="ghost" onClick={() => save(null)}>{t('serverDefault')}</Button>
          <Button variant="primary" onClick={() => save(value)}>{t('save')}</Button>
        </>
      }
    >
      <div className="space-y-2 p-5">
        <TextField icon={Server} dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://api.example.com" />
        <p className={cx('text-[12.5px]', error ? 'text-danger' : 'text-fg-3')}>{error ? t('serverInvalid') : t('serverAddressHint')}</p>
      </div>
    </Dialog>
  )
}
