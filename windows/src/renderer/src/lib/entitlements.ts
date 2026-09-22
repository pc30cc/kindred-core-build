import type { Entitlements } from '@/api/types'
import type { InboxFilter } from '@/api/client'

// These mirror the web console's sidebar rules exactly, as the iOS app does.

/** Whether a whole section belongs in the plan. A key the registry does not know counts as visible. */
export function moduleInPlan(e: Entitlements | null, key: string): boolean {
  if (!e?.modules) return false
  const state = e.modules[key]
  if (!state) return true
  return state.value === true
}

/** Fail-closed: a missing key is never enabled. */
export function moduleEnabled(e: Entitlements | null, key: string): boolean {
  return e?.modules?.[key]?.value === true
}

export function featureEnabled(e: Entitlements | null, key: string): boolean {
  return e?.features?.[key]?.value === true
}

export function limit(e: Entitlements | null, key: string): number | null {
  const v = e?.limits?.[key]?.value
  return typeof v === 'number' ? v : null
}

/** Voice and video, with the console's "not explicitly false" reading. */
export function callChannels(e: Entitlements | null): { voice: boolean; video: boolean } {
  if (!e) return { voice: false, video: false }
  if (e.modules?.voice_video?.value === false) return { voice: false, video: false }
  return { voice: e.channels?.voice?.value !== false, video: e.channels?.video?.value !== false }
}

export function inboxFilters(e: Entitlements | null): InboxFilter[] {
  const f: InboxFilter[] = ['open']
  if (featureEnabled(e, 'inbox_needs_human')) f.push('needsHuman')
  f.push('pending')
  if (featureEnabled(e, 'inbox_ai_queue')) f.push('ai')
  f.push('resolved', 'spam')
  return f
}

export function inboxChips(e: Entitlements | null): InboxFilter[] {
  return featureEnabled(e, 'inbox_ai_queue') ? ['open', 'ai'] : ['open']
}
