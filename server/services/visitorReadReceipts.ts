/**
 * When the visitor last read a conversation, for the operator's "Seen"
 * (finding I-03; DECISIONS "Read receipts").
 *
 * The widget records the visitor's reading in widget_conversation_reads
 * (migration 061: one row per conversation and visitor, `last_read_at`),
 * through POST /api/widget/conversations/:id/read. The Inbox never read it,
 * so an operator could not tell whether their reply had been seen (its
 * "Seen" looked at `seen_at`, which only marks the visitor's own messages as
 * read by an operator). Now:
 *
 *   - the conversation list and GET /api/conversations/:id carry
 *     `visitor_last_read_at` (ISO, or null: never read in the widget) —
 *     the newest of the conversation's markers;
 *   - every marker the widget writes is announced on the operators' inbox
 *     channel as `visitor_read` { conversation_id, visitor_last_read_at },
 *     so an open thread turns its "Seen" without a reload. Operator-only:
 *     never published to the visitor's conversation channel.
 */
import type { ServerConfig } from '../config.js';
import type { getServiceClient } from '../supabase.js';
import { publishOperatorEvent } from './realtime/publish.js';

type ServiceClient = ReturnType<typeof getServiceClient>;

/**
 * The newest visitor read marker of each conversation (absent: never read).
 * One read for the whole page. Before 061, or on any error: an empty map.
 */
export async function readVisitorLastRead(sb: ServiceClient, conversationIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(conversationIds.filter(Boolean)));
  if (!ids.length) return out;
  try {
    const { data, error } = await sb
      .from('widget_conversation_reads')
      .select('conversation_id, last_read_at')
      .in('conversation_id', ids);
    if (error) return out;
    for (const row of (data || []) as Array<{ conversation_id?: string | null; last_read_at?: string | null }>) {
      if (!row.conversation_id || typeof row.last_read_at !== 'string') continue;
      const prev = out.get(row.conversation_id);
      if (!prev || Date.parse(row.last_read_at) > Date.parse(prev)) out.set(row.conversation_id, row.last_read_at);
    }
  } catch { /* the list never fails for a read receipt */ }
  return out;
}

/**
 * The visitor read the conversation at `readAt`: the operators' inboxes
 * hear it. Best-effort, never throws.
 */
export async function publishVisitorRead(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; readAt: string },
): Promise<void> {
  try {
    await publishOperatorEvent(config, {
      kind: 'visitor_read',
      conversation_id: a.conversationId,
      workspace_id: a.workspaceId,
      actor_id: null,
      visitor_last_read_at: a.readAt,
    }, { skipConversationChannel: true });
  } catch { /* the next read of the thread shows it */ }
}
