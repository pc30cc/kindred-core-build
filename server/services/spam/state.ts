/**
 * Spam routing state — operator actions to flag / unflag conversations
 * and the contacts behind them.
 *
 * Marking spam is a soft routing filter, not a block:
 *   • does not delete history
 *   • does not close the conversation
 *   • does not stop the visitor from sending more messages
 *   • DOES cause the AI Agent to skip the conversation
 *   • DOES route the conversation into the Spam queue
 *
 * "Mark as spam" semantics:
 *   • If the conversation has a contact, flag both the contact AND every
 *     existing conversation for that contact in this workspace, so the
 *     entire identity moves to Spam.
 *   • If the conversation is anonymous (no contact), flag only this
 *     conversation.
 *
 * "Not spam" semantics:
 *   • Clear the flag on the conversation.
 *   • If the conversation has a contact, also clear the contact flag.
 *     (We deliberately avoid touching sibling conversations on un-flag —
 *      operators can re-mark if needed; bulk un-flag would surprise them.)
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface MarkSpamInput {
  workspaceId: string;
  conversationId: string;
  operatorId: string;
}

export interface MarkSpamResult {
  ok: true;
  conversation_ids: string[];
  contact_id: string | null;
}

export async function markSpam(
  config: ServerConfig,
  input: MarkSpamInput,
): Promise<MarkSpamResult> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();

  const { data: conv } = await sb
    .from('conversations')
    .select('id, workspace_id, contact_id')
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();
  if (!conv) throw new Error('conversation_not_found');

  const contactId = (conv as any).contact_id as string | null;
  const touched = new Set<string>([input.conversationId]);

  if (contactId) {
    // Flag the contact identity — quarantines current and future threads.
    await sb
      .from('contacts')
      .update({
        is_spam: true,
        spam_marked_at: now,
        spam_marked_by: input.operatorId,
      })
      .eq('id', contactId)
      .eq('workspace_id', input.workspaceId);

    // Flag every existing conversation tied to that contact.
    const { data: siblings } = await sb
      .from('conversations')
      .select('id')
      .eq('workspace_id', input.workspaceId)
      .eq('contact_id', contactId);
    for (const s of (siblings || []) as Array<{ id: string }>) {
      touched.add(s.id);
    }
    await sb
      .from('conversations')
      .update({ is_spam: true, spam_marked_at: now, spam_marked_by: input.operatorId })
      .eq('workspace_id', input.workspaceId)
      .eq('contact_id', contactId);
  } else {
    // Anonymous session — flag this thread only.
    await sb
      .from('conversations')
      .update({ is_spam: true, spam_marked_at: now, spam_marked_by: input.operatorId })
      .eq('id', input.conversationId)
      .eq('workspace_id', input.workspaceId);
  }

  return { ok: true, conversation_ids: Array.from(touched), contact_id: contactId };
}

export async function unmarkSpam(
  config: ServerConfig,
  input: MarkSpamInput,
): Promise<MarkSpamResult> {
  const sb = getServiceClient(config);

  const { data: conv } = await sb
    .from('conversations')
    .select('id, workspace_id, contact_id')
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();
  if (!conv) throw new Error('conversation_not_found');

  const contactId = (conv as any).contact_id as string | null;

  await sb
    .from('conversations')
    .update({ is_spam: false, spam_marked_at: null, spam_marked_by: null })
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId);

  if (contactId) {
    await sb
      .from('contacts')
      .update({ is_spam: false, spam_marked_at: null, spam_marked_by: null })
      .eq('id', contactId)
      .eq('workspace_id', input.workspaceId);
  }

  return { ok: true, conversation_ids: [input.conversationId], contact_id: contactId };
}
