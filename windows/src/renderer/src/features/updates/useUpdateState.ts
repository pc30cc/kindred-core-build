import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../../shared/ipc'
import { formatNumber } from '@/i18n'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'

/** The self-update state, live: read once, then pushed from the main process. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })
  useEffect(() => {
    void window.webyar.app.updateState().then(setState)
    return window.webyar.app.onUpdateState(setState)
  }, [])
  return state
}

/** Human wording for an update state, for the About page. */
export function useUpdateLabel(state: UpdateState): string | null {
  const t = useT()
  const language = useApp((s) => s.language)
  switch (state.kind) {
    case 'checking':
      return t('updateChecking')
    case 'current':
      return t('updateCurrent')
    case 'downloading':
      return t('updateDownloading', { version: state.version, percent: formatNumber(state.percent, language) })
    case 'ready':
      return t('updateReadyBody', { version: state.version })
    case 'error':
      return t('updateFailed')
    default:
      return null
  }
}
