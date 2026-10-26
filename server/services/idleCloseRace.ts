/**
 * A CUSTOMER MESSAGE THAT RACED AN INACTIVITY CLOSE (migrations 284, 286),
 * on every channel: the website widget (routes/widget.ts,
 * widget/visitorConversations.ts), Telegram, Bale, WhatsApp, Instagram and X
 * (channels/inboundProcessing.ts) and platform support
 * (platformSupport/service.ts).
 *
 * The close is the one exception to "closed has ended": a message written a
 * moment after it was on its way before the customer could know, so the
 * conversation goes back to what it was (open, pending or resolved, with its
 * thread stamps) and the message's lifecycle, routing and the AI run as if
 * the close had not happened. Two shapes, as the widget meets them:
 *   - the close committed before the message: the caller finds the
 *     conversation it would have written to closed for inactivity within
 *     the grace (justClosedForInactivity) and reopens it before choosing a
 *     conversation (no message id yet);
 *   - the message was being inserted while the close committed (its insert
 *     waited on the close's row lock): the caller's updated_at touch after
 *     the insert reads 'closed', and it reopens with the message's id.
 * An operator's close, or one older than the grace, stays closed.
 *
 * The grace is measured when the server processes the message: the widget's
 * 60 s (INACTIVITY_CLOSE_RACE_GRACE_SECONDS), or 600 s for a channel's or a
 * support requester's message (INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS),
 * which may have waited in a queue. The SQL caps it at 600.
 */
import type { ServerConfig } from '../config.js';
import type { ServiceClient } from '../supabase.js';
import { publishOperatorEvent } from './realtime/publish.js';
import { INACTIVITY_CLOSE_RACE_GRACE_SECONDS } from '../../shared/inactivityClose.js';

/**
 * Whether the conversation was closed by the inactivity close a moment ago,
 * within `graceSeconds` (the widget's grace by default): a customer message
 * now raced the close. A closed_at that does not parse is no race; one in
 * the future (the database's clock ahead of this one) is within the grace.
 */
export function justClosedForInactivity(
  row: { status?: unknown; metadata?: unknown } | null | undefined,
  now: number = Date.now(),
  graceSeconds: number = INACTIVITY_CLOSE_RACE_GRACE_SECONDS,
): boolean {
  if (!row || row.status !== 'closed') return false;
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  if (meta.closed_reason !== 'inactivity' || typeof meta.closed_at !== 'string') return false;
  const at = Date.parse(meta.closed_at);
  if (!Number.isFinite(at)) return false;
  return now - at <= graceSeconds * 1000;
}

/**
 * A customer message raced an inactivity close: the conversation goes back to
 * what it was before the close (open, pending or resolved, with its thread
 * stamps; conversation_reopen_after_idle_close, migration 284, row-locked,
 * once, only within `graceSeconds`, the widget's by default), the closed line
 * it wrote is retracted (a widget's; no other channel has one), and the Inbox
 * hears of it (`conversation_reopened` and the timeline echo). Returns the
 * restored status, or null: not such a close, past the grace, already
 * reopened, before 284 (the function missing), or any failure. Never throws.
 * The caller runs the message's lifecycle with that status, as if the close
 * had not happened.
 */
export async function reopenAfterIdleCloseRace(
  config: ServerConfig,
  sb: ServiceClient,
  input: { workspaceId: string; conversationId: string; messageId?: string | null; graceSeconds?: number },
): Promise<string | null> {
  try {
    const { data, error } = await sb.rpc('conversation_reopen_after_idle_close', {
      p_workspace_id: input.workspaceId,
      p_conversation_id: input.conversationId,
      p_message_id: input.messageId ?? null,
      p_grace_seconds: input.graceSeconds ?? INACTIVITY_CLOSE_RACE_GRACE_SECONDS,
    });
    if (error) {
      // Before migration 284 (42883; PGRST202 through the data layer): no such close to undo.
      const code = String((error as { code?: string }).code ?? '');
      if (code !== '42883' && code !== 'PGRST202') {
        console.warn('[idle-close-race] reopen after the inactivity close failed:', (error as { message?: string }).message);
      }
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      restored_status?: string | null; updated_at?: string | null; event_id?: string | null; event_created_at?: string | null;
    } | null;
    const restored = typeof row?.restored_status === 'string' ? row.restored_status : null;
    if (!restored) return null;
    void publishOperatorEvent(config, {
      kind: 'conversation_reopened',
      conversation_id: input.conversationId,
      workspace_id: input.workspaceId,
      actor_id: null,
      changes: { status: { from: 'closed', to: restored } },
      reason: 'customer_replied_after_inactivity_close',
      updated_at: row?.updated_at ?? null,
    }).catch(() => undefined);
    if (row?.event_id) {
      // recordConversationEvent's echo, for the event the SQL wrote.
      void publishOperatorEvent(config, {
        kind: 'timeline_event',
        conversation_id: input.conversationId,
        workspace_id: input.workspaceId,
        actor_id: null,
        event_id: row.event_id,
        event_type: 'reopened',
        actor_type: 'visitor',
        created_at: row.event_created_at ?? null,
      }).catch(() => undefined);
    }
    return restored;
  } catch (err) {
    console.warn('[idle-close-race] reopen after the inactivity close threw:', (err as { message?: string } | null)?.message || err);
    return null;
  }
}
