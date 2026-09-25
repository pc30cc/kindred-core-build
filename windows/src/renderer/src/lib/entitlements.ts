import type { Entitlements } from '@/api/types'
import type { InboxFilter } from '@/api/client'

// The web console's one rule (src/lib/planAccess.ts): a capability is available only when the
// snapshot is in (`e` is null while it loads or when it cannot be read) and its value is exactly
// `true`. A key the snapshot does not carry is not available: the server denies keys it does not know.

/** Whether a whole section belongs in the plan. */
export function moduleInPlan(e: Entitlements | null, key: string): boolean {
  return e?.modules?.[key]?.value === true
}

export function featureEnabled(e: Entitlements | null, key: string): boolean {
  return e?.features?.[key]?.value === true
}

export function limit(e: Entitlements | null, key: string): number | null {
  const v = e?.limits?.[key]?.value
  return typeof v === 'number' ? v : null
}

export function channelEnabled(e: Entitlements | null, key: string): boolean {
  return e?.channels?.[key]?.value === true
}

/** Voice and video, as the console's SidebarCallCard: the Voice & Video module and the call's channel. */
export function callChannels(e: Entitlements | null): { voice: boolean; video: boolean } {
  if (!moduleInPlan(e, 'voice_video')) return { voice: false, video: false }
  return { voice: channelEnabled(e, 'voice'), video: channelEnabled(e, 'video') }
}

/** Channel keys the plan itself governs; any other channel inbox is the plugin's own plan check (planAllowed). */
const PLAN_CHANNELS: ReadonlySet<string> = new Set([
  'chat_widget', 'email', 'whatsapp', 'sms', 'instagram', 'telegram', 'bale', 'gmail', 'yahoomail', 'voice', 'video',
])

/**
 * A channel inbox from the plugin catalog (already installed, inbox-capable and planAllowed), as the
 * console's channelInboxVisible: a channel the plan governs must be on in the snapshot.
 */
export function channelInboxVisible(e: Entitlements | null, key: string): boolean {
  const k = key.toLowerCase()
  return !PLAN_CHANNELS.has(k) || channelEnabled(e, k)
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
