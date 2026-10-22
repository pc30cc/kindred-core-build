/**
 * The visitor's live read receipt: when an operator reads the visitor's
 * messages (POST /api/conversations/:id/seen marks them `seen_at`), the
 * widget hears it at once and turns those bubbles' ticks to "seen", instead
 * of waiting for its next history load (a realtime visitor has no poll).
 *
 * Envelope on the conversation's channel (ws:<ws>:conv:<cid>, which the
 * visitor subscribes to):
 *   { type: 'seen', payload: { conversation_id, seen_at, message_ids } }
 * `message_ids` are the visitor's own messages that were just marked, at most
 * SEEN_IDS_CAP of them: no operator id, no name, nothing the
 * visitor's /poll and /history do not already return as `seen_at`. The
 * widget's realtime drivers hand it to the runtime (`onSeen`), which marks
 * exactly those bubbles.
 *
 * Nothing is published when the workspace turned read receipts off (the
 * widget would draw no "seen" anyway). Best-effort and never throws: the
 * `seen_at` column is the source of truth, and the next history load shows
 * it whatever happens here.
 */
import type { ServerConfig } from '../../config.js';
import { publishConversationEvent } from '../realtime/publish.js';
import { getWorkspaceWidgetSnapshot } from './configSnapshot.js';

/** The most ids one envelope carries (a thread read after a long silence); the rest follow on the next history load. */
export const SEEN_IDS_CAP = 200;

export async function publishVisitorSeen(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  messageIds: string[],
  seenAt: string,
): Promise<void> {
  if (!messageIds.length) return;
  try {
    const snap = await getWorkspaceWidgetSnapshot(config, workspaceId);
    if (snap.settings && snap.settings.read_receipts_enabled === false) return;
  } catch {
    // An unreadable snapshot does not stop the receipt: /poll returns the
    // same `seen_at` either way.
  }
  try {
    await publishConversationEvent(config, workspaceId, conversationId, {
      type: 'seen',
      payload: {
        conversation_id: conversationId,
        seen_at: seenAt,
        message_ids: messageIds.slice(-SEEN_IDS_CAP),
      },
    });
  } catch {
    // publishConversationEvent already logs and never throws; belt and braces.
  }
}
