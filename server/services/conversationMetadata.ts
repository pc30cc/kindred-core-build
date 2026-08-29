/**
 * Atomic shallow patch of `conversations.metadata`.
 *
 * Single shared entry point for every subsystem that writes a few top-level
 * metadata keys (routing outcome, department, channel screens). The merge
 * happens server-side inside `patch_conversation_metadata` (migration 057),
 * so a writer can no longer revert concurrent keys owned by somebody else —
 * notably the AI Agent's `ai_state`, `ai_handoff_*`, `human_takeover_at` and
 * `ai_memory`.
 *
 * Returns false when nothing was updated. Never throws.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export async function patchConversationMetadata(
  config: ServerConfig,
  conversationId: string,
  patch: Record<string, unknown>,
  workspaceId?: string | null,
): Promise<boolean> {
  if (!conversationId) return false;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('patch_conversation_metadata', {
      p_conversation_id: conversationId,
      p_workspace_id: workspaceId || null,
      p_patch: patch,
    });
    if (!error) return !!data;

    // Fallback for deployments without migration 057. Re-reads immediately
    // before the write so the window stays as small as possible.
    const { data: row } = await sb
      .from('conversations')
      .select('metadata')
      .eq('id', conversationId)
      .maybeSingle();
    if (!row) return false;
    const meta = (((row as any).metadata as Record<string, unknown>) || {});
    const q = sb.from('conversations').update({ metadata: { ...meta, ...patch } }).eq('id', conversationId);
    const { error: updErr } = await (workspaceId ? q.eq('workspace_id', workspaceId) : q);
    return !updErr;
  } catch {
    return false;
  }
}
