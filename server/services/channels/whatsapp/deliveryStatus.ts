/**
 * WHATSAPP CLOUD — OUTBOUND DELIVERY STATUS (pure protocol layer).
 *
 * WhatsApp is the ONLY connected provider with a genuinely ASYNCHRONOUS
 * delivery lifecycle. The Graph `POST /{phone_number_id}/messages` call only
 * ACCEPTS a message and hands back a `wamid`; the real outcome arrives later
 * on the same webhook, in `value.statuses[]`:
 *
 *     sent → delivered → read          (success ladder)
 *     … or failed                      (terminal, can arrive after `sent`)
 *
 * Contrast with Telegram/Bale (Bot API returns the final `message_id`; a 2xx
 * IS the delivery truth, there is no status callback) and Instagram (Graph
 * send returns a message id; the app subscribes to no delivery-status field).
 * Do NOT generalise this ladder to those providers.
 *
 * `statuses[]` is NOT customer content: it must never reach
 * `processInboundMessage`, never open/resume a conversation, never create an
 * agent-unread, never trigger AI routing. This module therefore lives on its
 * own narrow path and is the only translator of statuses.
 */

export type WhatsAppDeliveryStatus = {
  /** Provider message identifier (`wamid.…`) of the OUTBOUND message. */
  providerMessageId: string;
  /** Canonical delivery state used by Core. */
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** Provider event time (ISO), used as a tiebreaker for equal ranks. */
  occurredAt: string | null;
  /** Short provider error code, only for `failed`. */
  errorCode: string | null;
  recipientId: string | null;
};

const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * Extracts delivery statuses from a raw Meta webhook body.
 * Unknown statuses (e.g. `deleted`, `warning`) are ignored on purpose — we
 * only model states with a defined meaning for "did the customer get it".
 */
export function extractWhatsAppDeliveryStatuses(
  payload: Record<string, any>,
): WhatsAppDeliveryStatus[] {
  const out: WhatsAppDeliveryStatus[] = [];
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const statuses: any[] = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
      for (const s of statuses) {
        const id = String(s?.id ?? '').trim();
        const status = String(s?.status ?? '').trim().toLowerCase();
        if (!id || !KNOWN_STATUSES.has(status)) continue;

        const ts = Number(s?.timestamp ?? 0);
        const error = Array.isArray(s?.errors) ? s.errors[0] : null;
        const errorCode =
          status === 'failed'
            ? String(error?.code ?? error?.title ?? 'whatsapp_failed').slice(0, 120)
            : null;

        out.push({
          providerMessageId: id,
          status: status as WhatsAppDeliveryStatus['status'],
          occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
          errorCode,
          recipientId: s?.recipient_id ? String(s.recipient_id) : null,
        });
      }
    }
  }
  return out;
}

/**
 * Monotonic ranking of SUCCESS states. Provider webhooks retry and arrive out
 * of order, so a late `sent` must never downgrade a `delivered`/`read`.
 * `failed` is deliberately NOT in this ladder: it is a separate axis judged by
 * provider semantics, not by a numeric comparison.
 */
const SUCCESS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export type DeliveryTransition =
  | { apply: false; reason: 'duplicate' | 'out_of_order' | 'already_terminal' | 'not_failable' }
  | { apply: true; status: 'sent' | 'delivered' | 'read' | 'failed'; terminalFailure: boolean };

/**
 * Decides whether an incoming provider status may overwrite the state Core
 * already holds for that message.
 *
 * Rules (WhatsApp contract, not a generic guess):
 *  • `failed` is TERMINAL: nothing overwrites it, and a repeat is a no-op.
 *  • `failed` may arrive AFTER `sent` (or after nothing at all) — WhatsApp
 *    accepts first and can reject later, so this downgrade is legitimate.
 *  • `failed` may NOT arrive after `delivered`/`read`: the handset already had
 *    the message, so such an event is stale/bogus and is dropped.
 *  • success states only ever move UP the ladder.
 */
export function resolveDeliveryTransition(
  previous: string | null | undefined,
  next: 'sent' | 'delivered' | 'read' | 'failed',
): DeliveryTransition {
  const prev = String(previous ?? '').toLowerCase();

  if (prev === 'failed') {
    return { apply: false, reason: next === 'failed' ? 'duplicate' : 'already_terminal' };
  }

  if (next === 'failed') {
    const prevRank = SUCCESS_RANK[prev] ?? 0;
    if (prevRank >= SUCCESS_RANK.delivered) return { apply: false, reason: 'not_failable' };
    return { apply: true, status: 'failed', terminalFailure: true };
  }

  const prevRank = SUCCESS_RANK[prev] ?? 0;
  const nextRank = SUCCESS_RANK[next] ?? 0;
  if (nextRank === prevRank) return { apply: false, reason: 'duplicate' };
  if (nextRank < prevRank) return { apply: false, reason: 'out_of_order' };
  return { apply: true, status: next, terminalFailure: false };
}
