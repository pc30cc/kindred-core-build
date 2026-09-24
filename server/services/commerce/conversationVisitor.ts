/**
 * The visitor a conversation belongs to — the id `commerce_customer_links`
 * rows are written against (the widget's visitor, see identityBridge.ts).
 *
 * The same rule as WHMCS's resolveWhmcsBinding: AI-intro conversations can
 * predate a visitor session, so their server-authored `metadata.visitor_id`
 * is the canonical owner. Only legacy conversations without it need their
 * session's visitor, looked up in the same workspace. A session's own id is
 * never a visitor id.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface ConversationVisitor {
  visitorId: string | null;
  metadata: Record<string, unknown>;
}

export async function resolveConversationVisitor(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string | null | undefined,
): Promise<ConversationVisitor> {
  if (!conversationId) return { visitorId: null, metadata: {} };
  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('visitor_session_id, metadata')
    .eq('id', conversationId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!conv) return { visitorId: null, metadata: {} };

  const row = conv as { visitor_session_id?: unknown; metadata?: unknown };
  const metadata = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : {};
  const fromMetadata = typeof metadata.visitor_id === 'string' && metadata.visitor_id.trim() ? metadata.visitor_id : null;
  if (fromMetadata) return { visitorId: fromMetadata, metadata };

  if (typeof row.visitor_session_id !== 'string' || !row.visitor_session_id) return { visitorId: null, metadata };
  const { data: session } = await sb
    .from('visitor_sessions')
    .select('visitor_id')
    .eq('id', row.visitor_session_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const fromSession = (session as { visitor_id?: unknown } | null)?.visitor_id;
  return { visitorId: typeof fromSession === 'string' && fromSession.trim() ? fromSession : null, metadata };
}
