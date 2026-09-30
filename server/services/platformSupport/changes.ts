/**
 * Platform support — telling the operator that one of their conversations
 * changed in the inbox: resolved, closed, reopened, assigned or transferred.
 *
 * Its own small module so the inbox's routing code can call it without
 * pulling in the rest of platform support. A conversation that is not a
 * support one costs one primary-key read.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { publishSupportEvent } from '../realtime/publish.js';

/** Best effort and never throws: the change is already saved. */
export async function onSupportConversationChanged(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string },
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_support_threads')
      .select('conversation_id, support_workspace_id, user_id')
      .eq('conversation_id', input.conversationId)
      .maybeSingle();
    const thread = data as { conversation_id: string; support_workspace_id: string; user_id: string } | null;
    if (!thread || thread.support_workspace_id !== input.workspaceId) return;
    const { data: memberships } = await sb
      .from('workspace_members')
      .select('workspace_id, created_at')
      .eq('user_id', thread.user_id)
      .order('created_at', { ascending: true })
      .limit(25);
    const workspaces = ((memberships ?? []) as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
    await publishSupportEvent(config, thread.user_id, workspaces, {
      kind: 'support_update',
      thread_id: thread.conversation_id,
    });
  } catch (err) {
    console.warn('[platform-support] update delivery failed:', err instanceof Error ? err.message : err);
  }
}
