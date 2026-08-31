/**
 * "NEEDS REPLY" — who is waiting for whom, derived, never stored.
 *
 * Until now the Inbox had NO notion of an answered conversation. The only
 * signals were:
 *   • `status` (open | pending | resolved | closed) — a lifecycle state, and
 *   • `unread_count` (unseen CONTACT messages) — a read receipt.
 * Both were routinely read as "this thread needs an answer", which is wrong:
 *   • `open` stays `open` after a plain Send, so an already-answered thread
 *     looked identical to an unanswered one;
 *   • opening a conversation clears `unread_count`, which made an unanswered
 *     thread look handled.
 *
 * Needs Reply is a THIRD, independent axis:
 *
 *   needs_reply = the newest conversational turn is an actionable customer
 *                 message that has not yet been followed by a qualified
 *                 customer-facing response.
 *
 * Deliberate properties:
 *  • Derived on read from `conversation_messages` — no column, no backfill,
 *    no cache to drift. The lifecycle (070/071) is untouched.
 *  • `pending` (business waits for the customer), `resolved` and `closed` are
 *    never "needs reply" by definition.
 *  • Reuses the SAME actionable-customer-message guard as the pending/resolved
 *    resume lifecycle (`conversationResumeEligibility`), so receipts, menu
 *    taps, echoes, system rows and empty events can never open a reply cycle.
 *  • A reply only counts when it is customer-facing AND was not rejected by
 *    the transport (`metadata.channel_delivery === 'failed'`), so a failed
 *    Telegram/WhatsApp delivery leaves the obligation open.
 */

import { isInboundCustomerMessageEligibleForResume } from './conversationResumeEligibility.js';

/** Minimal row shape — matches what the Inbox list endpoint already selects. */
export type NeedsReplyMessage = {
  sender_type: string | null | undefined;
  body?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Real media/file attachments carried by the message, when known. */
  attachment_count?: number;
};

/**
 * Senders whose message is a genuine customer-facing answer.
 * `agent` = human operator (Inbox composer), `ai` = AI Agent reply
 * (server/services/ai-agent/responder.ts writes sender_type 'ai').
 * `bot` (provider menu/automation output) and `system` are NOT answers.
 */
const REPLY_SENDER_TYPES = new Set(['agent', 'ai']);

function meta(m: NeedsReplyMessage): Record<string, unknown> {
  return (m.metadata || {}) as Record<string, unknown>;
}

function isMenuEvent(m: NeedsReplyMessage): boolean {
  const md = meta(m);
  return String(md.channel_menu_event ?? '') === 'true' || !!md.channel_menu_command;
}

function isSystemGenerated(m: NeedsReplyMessage): boolean {
  const md = meta(m);
  // Routing notices, offline screens and other synthetic rows tag themselves
  // with a `kind` and are inserted as sender_type 'system'.
  return String(m.sender_type ?? '') === 'system' || typeof md.routing_notice === 'string';
}

function hasContent(m: NeedsReplyMessage): boolean {
  const text = typeof m.body === 'string' ? m.body.trim() : '';
  return text.length > 0 || (m.attachment_count ?? 0) > 0 || !!meta(m).attachment_id;
}

/** A real, new customer turn — same contract as the pending/resolved resume guard. */
export function isActionableCustomerTurn(m: NeedsReplyMessage): boolean {
  const md = meta(m);
  return isInboundCustomerMessageEligibleForResume({
    senderType: m.sender_type,
    direction: 'inbound',
    text: m.body ?? '',
    attachmentCount: (m.attachment_count ?? 0) || (md.attachment_id ? 1 : 0),
    isMenuEvent: isMenuEvent(m),
    isSystemGenerated: isSystemGenerated(m),
    isEcho: md.provider_echo === true,
  }).eligible;
}

/**
 * TERMINAL delivery states — the transport has given up, so the customer will
 * never receive this message. Written by Core (and only Core) from the
 * Channels Worker's `POST /internal/channels/outbound-result` report:
 *   • immediately, for a non-retryable provider error, and
 *   • at retry exhaustion (`channel_jobs.status = 'failed'`).
 *
 * Everything else — no key at all (widget / just-enqueued), 'sent', or any
 * in-flight bookkeeping — is NOT terminal. A message still being retried is
 * an answer in flight, not a broken promise, so it must not flap the badge.
 */
const TERMINAL_DELIVERY_FAILURES = new Set(['failed']);

export function isPermanentlyUndelivered(m: NeedsReplyMessage): boolean {
  return TERMINAL_DELIVERY_FAILURES.has(String(meta(m).channel_delivery ?? ''));
}

/**
 * A qualified, customer-facing answer that actually reached a valid delivery
 * path — the single concept that satisfies the obligation:
 *   • sender is a real responder (agent / AI), not bot menu output or system,
 *   • outbound and customer-facing (internal notes live in `conversation_notes`,
 *     a different table, and can never reach here),
 *   • carries content (text or attachment),
 *   • was not skipped by routing, and
 *   • is not in a terminal delivery-failure state.
 */
export function isQualifiedCustomerFacingAnswer(m: NeedsReplyMessage): boolean {
  if (!REPLY_SENDER_TYPES.has(String(m.sender_type ?? ''))) return false;
  if (isSystemGenerated(m)) return false;
  if (isMenuEvent(m)) return false;
  // Routing deliberately suppressed delivery (e.g. offline screen queued
  // instead): the customer never got this text on the channel.
  if (String(meta(m).channel_delivery_skip ?? '') === 'true') return false;
  // Transport gave up → the customer never received an answer.
  if (isPermanentlyUndelivered(m)) return false;
  return hasContent(m);
}

/** @deprecated Use {@link isQualifiedCustomerFacingAnswer}. */
export const isQualifiedReply = isQualifiedCustomerFacingAnswer;

export type NeedsReplyInput = {
  status: string | null | undefined;
  /** Conversation messages, any order; only the newest relevant turn matters. */
  messages: NeedsReplyMessage[];
};

/**
 * `true` when the business currently owes the customer an answer.
 *
 * Only `open` conversations can owe anything: `pending` means the business is
 * waiting for the customer, `resolved`/`closed` mean the obligation is over.
 * (`resolved`/`pending` + a real customer reply are flipped back to `open` by
 * the inbound lifecycle before this is ever evaluated.)
 */
export function computeNeedsReply(input: NeedsReplyInput): boolean {
  if (String(input.status ?? '') !== 'open') return false;

  const ordered = input.messages
    .slice()
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  for (const m of ordered) {
    if (isActionableCustomerTurn(m)) return true;   // customer spoke last
    if (isQualifiedCustomerFacingAnswer(m)) return false; // we answered last
    // everything else (system rows, menu taps, bot output, empty events,
    // failed deliveries) is transparent: keep looking further back.
  }
  return false;
}

/**
 * Timestamp the customer has been waiting since — the FIRST actionable turn of
 * the current unanswered streak, not the newest one. Lets the Inbox rank by
 * real waiting age instead of `updated_at`, which non-conversational events
 * (assignment, routing metadata, delivery receipts) also bump.
 *
 * `null` when nothing is owed.
 */
export function computeWaitingSince(input: NeedsReplyInput): string | null {
  if (!computeNeedsReply(input)) return null;

  const ordered = input.messages
    .slice()
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  let oldest: string | null = null;
  for (const m of ordered) {
    if (isQualifiedCustomerFacingAnswer(m)) break; // start of the streak
    if (isActionableCustomerTurn(m) && m.created_at) oldest = m.created_at;
  }
  return oldest;
}
