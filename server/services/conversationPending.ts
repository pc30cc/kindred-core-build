/**
 * "Awaiting customer reply" (status = 'pending') lifecycle.
 *
 * Operators park a thread in `pending` when the ball is in the customer's
 * court. The moment the customer writes again the thread MUST return to
 * `open` so it re-enters the active queue — otherwise the tab silently
 * swallows live conversations.
 *
 * This helper is the single place that performs that transition. It is
 * conditional (only touches rows still in `pending`), idempotent and never
 * throws: message delivery is always more important than the bookkeeping.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { recordConversationEvent } from './conversationEvents.js';

export async function resumeConversationIfPending(
  config: ServerConfig,
  params: { workspaceId: string; conversationId: string; source?: string },
): Promise<boolean> {
  const { workspaceId, conversationId, source } = params;
  if (!workspaceId || !conversationId) return false;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('conversations')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (error || !data) return false;

    void recordConversationEvent(config, {
      workspaceId,
      conversationId,
      eventType: 'status_changed',
      actorType: 'visitor',
      actorId: null,
      payload: {
        from: 'pending',
        to: 'open',
        reason: 'customer_replied',
        source: source || 'widget',
      },
    });
    return true;
  } catch {
    return false;
  }
}
