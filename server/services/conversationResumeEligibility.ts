/**
 * SHARED DOMAIN GUARD — "does this inbound event count as a customer reply?"
 *
 * `pending` ("awaiting customer reply") may only be lifted by a REAL, NEW
 * message written by the customer. Before this guard existed each ingest path
 * decided on its own, which meant a Telegram `/start` tap or a menu-keyboard
 * press — explicitly treated everywhere else as navigation, not content —
 * silently un-parked a thread.
 *
 * Every resume decision now flows through `isInboundCustomerMessageEligibleForResume`,
 * so the pending lifecycle is understandable and testable in ONE place.
 *
 * Note on what is NOT here: provider events that carry no conversational
 * content (WhatsApp sent/delivered/read/failed statuses, Instagram echoes /
 * reads / deliveries / reactions, Telegram callback queries, webhook
 * verification) are dropped much earlier, at the normalizer boundary, and
 * never reach a canonical message at all. This guard is the second, uniform
 * line of defence for everything that DOES become a message row.
 */

export type ResumeCandidate = {
  /** Canonical sender_type of the row that was just persisted. */
  senderType: string | null | undefined;
  /** Message direction as understood by the ingest path. */
  direction: 'inbound' | 'outbound';
  /** Body text of the persisted message. */
  text?: string | null;
  /** Real media/file attachments carried by the message. */
  attachmentCount?: number;
  /**
   * Provider UI navigation (slash command, menu keyboard tap, quick reply,
   * button/list reply routed to the menu router). Not conversation content.
   */
  isMenuEvent?: boolean;
  /** Operator-only note — invisible to the customer, never a reply. */
  isInternalNote?: boolean;
  /** Synthetic row produced by routing/automation/workflow/system code. */
  isSystemGenerated?: boolean;
  /** Provider echo of a message the business itself sent. */
  isEcho?: boolean;
};

export type ResumeEligibility = { eligible: boolean; reason: string };

/** Only a genuine human customer identity may resume a parked thread. */
const CUSTOMER_SENDER_TYPES = new Set(['contact']);

export function isInboundCustomerMessageEligibleForResume(
  candidate: ResumeCandidate,
): ResumeEligibility {
  if (candidate.direction !== 'inbound') return { eligible: false, reason: 'not_inbound' };
  if (candidate.isEcho) return { eligible: false, reason: 'provider_echo' };
  if (!CUSTOMER_SENDER_TYPES.has(String(candidate.senderType ?? '')))
    return { eligible: false, reason: 'sender_not_customer' };
  if (candidate.isInternalNote) return { eligible: false, reason: 'internal_note' };
  if (candidate.isSystemGenerated) return { eligible: false, reason: 'system_generated' };
  if (candidate.isMenuEvent) return { eligible: false, reason: 'menu_navigation' };

  const hasText = typeof candidate.text === 'string' && candidate.text.trim().length > 0;
  const hasAttachment = (candidate.attachmentCount ?? 0) > 0;
  if (!hasText && !hasAttachment) return { eligible: false, reason: 'empty_message' };

  return { eligible: true, reason: 'customer_replied' };
}
