import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@/hooks/useT'
import { useUpdateState } from './useUpdateState'

/**
 * Once an update has downloaded, offer the restart right away. It also
 * installs by itself the next time the app quits, so "Later" loses nothing.
 */
export function UpdateNotice() {
  const t = useT()
  const state = useUpdateState()
  const version = state.kind === 'ready' ? state.version : null

  useEffect(() => {
    if (!version) return
    toast(t('updateReadyTitle'), {
      id: `update-${version}`,
      description: t('updateReadyBody', { version }),
      duration: Infinity,
      action: { label: t('updateRestart'), onClick: () => void window.webyar.app.installUpdate() },
      cancel: { label: t('updateLater'), onClick: () => undefined },
    })
  }, [version, t])

  return null
}
