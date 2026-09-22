import type { ConversationStatus } from '@/api/types'
import type { StringKey } from '@/i18n'

export const STATUS_TITLE: Record<ConversationStatus, StringKey> = {
  open: 'filterOpen',
  pending: 'statusPending',
  resolved: 'filterResolved',
  closed: 'statusClosed',
}

/** Which conversation is on screen right now, so the notifier stays quiet about it. */
export const viewing: { id: string | null } = { id: null }
