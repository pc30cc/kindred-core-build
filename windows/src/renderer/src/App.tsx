import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { isRTL } from '@/i18n'
import { useApp } from '@/store/app'
import { Wordmark } from '@/components/Brand'
import { LoginScreen } from '@/features/auth/LoginScreen'
import { Shell } from '@/features/shell/Shell'
import { useT } from '@/hooks/useT'
import { UpdateNotice } from '@/features/updates/UpdateNotice'

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

/** Language, direction and theme are applied to the document itself, before anything draws. */
function useDocumentChrome() {
  const language = useApp((s) => s.language)
  const appearance = useApp((s) => s.appearance)
  const systemDark = useSystemDark()
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark)

  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = isRTL(language) ? 'rtl' : 'ltr'
  }, [language])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    // The native caption buttons sit on our own title bar, so they take its colours.
    void window.webyar.app.setTitleBarTheme(
      dark
        ? { color: '#00000000', symbolColor: '#98A2B3', background: '#0C0E14' }
        : { color: '#00000000', symbolColor: '#5B6577', background: '#F4F6F9' },
    )
  }, [dark])

  return dark
}

export function App() {
  const dark = useDocumentChrome()
  const session = useApp((s) => s.session)
  const restore = useApp((s) => s.restore)
  const language = useApp((s) => s.language)

  useEffect(() => {
    void restore()
  }, [restore])

  return (
    <>
      {session.kind === 'restoring' && <LaunchScreen />}
      {session.kind === 'signedOut' && <LoginScreen />}
      {session.kind === 'signedIn' && <Shell />}
      <UpdateNotice />
      <Toaster
        position={isRTL(language) ? 'bottom-left' : 'bottom-right'}
        theme={dark ? 'dark' : 'light'}
        dir={isRTL(language) ? 'rtl' : 'ltr'}
        toastOptions={{ style: { fontFamily: 'inherit' } }}
        richColors
      />
    </>
  )
}

/** The brief moment before we know whether there is a session. The wordmark is the loading indicator. */
function LaunchScreen() {
  const t = useT()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 1200)
    return () => clearTimeout(id)
  }, [])
  return (
    <div className="drag fade-in relative flex h-full flex-col items-center justify-center gap-6 bg-bg">
      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle at center, var(--brand-soft), transparent 45%)' }} />
      <Wordmark size={40} loading />
      <div className={slow ? 'opacity-100 transition-opacity' : 'opacity-0'}>
        <div className="relative h-[3px] w-[132px] overflow-hidden rounded-full bg-brand-soft" dir="ltr">
          <div className="travel absolute inset-y-0 w-1/3 rounded-full bg-brand" />
        </div>
        <div className="mt-3 text-center text-[12px] text-fg-3">{t('checkingSession')}</div>
      </div>
    </div>
  )
}
