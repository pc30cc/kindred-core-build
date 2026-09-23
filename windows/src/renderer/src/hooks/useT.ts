import { useCallback } from 'react'
import { translate, type StringKey } from '@/i18n'
import { useApp } from '@/store/app'

/** The translator for the operator's chosen language. Re-renders when it changes. */
export function useT() {
  const language = useApp((s) => s.language)
  return useCallback(
    (key: StringKey, params?: Record<string, string | number>) => translate(language, key, params),
    [language],
  )
}
