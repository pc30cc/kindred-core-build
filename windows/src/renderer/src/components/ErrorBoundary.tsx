import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCw, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n'
import { useApp } from '@/store/app'

/**
 * The last line of defence: a render error anywhere below replaces the screen
 * with a way back, instead of leaving an empty white window. The window hides
 * to the tray rather than closing, so without this a crash would outlive
 * "closing" the app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const language = useApp.getState().language
    const t = (key: 'crashTitle' | 'crashBody' | 'crashReload') => translate(language, key)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-8 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
          <TriangleAlert className="size-6" strokeWidth={1.8} />
        </div>
        <div className="text-[17px] font-semibold text-fg">{t('crashTitle')}</div>
        <div className="max-w-sm text-[13.5px] text-fg-2">{t('crashBody')}</div>
        <pre className="max-w-lg truncate text-[11.5px] text-fg-3" dir="ltr">{error.message}</pre>
        <button
          onClick={() => location.reload()}
          className="mt-2 inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-[13.5px] font-medium text-white hover:opacity-90"
        >
          <RotateCw className="size-4" />
          {t('crashReload')}
        </button>
      </div>
    )
  }
}
