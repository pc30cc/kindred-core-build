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
 *
 * The contact-level halves (`flagContactAsSpam` / `clearContactSpamFlag`)
 * are exported so other surfaces that know a contact but not a
 * conversation — e.g. Call Center calls — flag the identity exactly the
 * same way.
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

export interface FlagContactSpamInput {
  workspaceId: string;
  contactId: string;
  operatorId: string;
  /** Timestamp stamped on the contact and its conversations. Defaults to now. */
  now?: string;
}

interface ConversationContactRow {
  id: string;
  workspace_id: string;
  contact_id: string | null;
}

/**
 * Flag a contact identity as spam, plus every existing conversation tied to
 * it in this workspace. Returns the ids of the conversations it flagged.
 * Every write is scoped to `workspaceId`, so a contact id belonging to
 * another workspace is a no-op.
 */
export async function flagContactAsSpam(
  config: ServerConfig,
  input: FlagContactSpamInput,
): Promise<string[]> {
  const sb = getServiceClient(config);
  const now = input.now ?? new Date().toISOString();

  // Flag the contact identity — quarantines current and future threads.
  await sb
    .from('contacts')
    .update({
      is_spam: true,
      spam_marked_at: now,
      spam_marked_by: input.operatorId,
    })
    .eq('id', input.contactId)
    .eq('workspace_id', input.workspaceId);

  // Flag every existing conversation tied to that contact.
  const { data: siblings } = await sb
    .from('conversations')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .eq('contact_id', input.contactId);
  await sb
    .from('conversations')
    .update({ is_spam: true, spam_marked_at: now, spam_marked_by: input.operatorId })
    .eq('workspace_id', input.workspaceId)
    .eq('contact_id', input.contactId);

  return ((siblings || []) as Array<{ id: string }>).map((s) => s.id);
}

/**
 * Clear the spam flag on a contact identity. Sibling conversations are
 * deliberately left alone (see "Not spam" semantics above).
 */
export async function clearContactSpamFlag(
  config: ServerConfig,
  input: { workspaceId: string; contactId: string },
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('contacts')
    .update({ is_spam: false, spam_marked_at: null, spam_marked_by: null })
    .eq('id', input.contactId)
    .eq('workspace_id', input.workspaceId);
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

  const contactId = (conv as ConversationContactRow).contact_id ?? null;
  const touched = new Set<string>([input.conversationId]);

  if (contactId) {
    const siblingIds = await flagContactAsSpam(config, {
      workspaceId: input.workspaceId,
      contactId,
      operatorId: input.operatorId,
      now,
    });
    for (const id of siblingIds) touched.add(id);
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

  const contactId = (conv as ConversationContactRow).contact_id ?? null;

  await sb
    .from('conversations')
    .update({ is_spam: false, spam_marked_at: null, spam_marked_by: null })
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId);

  if (contactId) {
    await clearContactSpamFlag(config, { workspaceId: input.workspaceId, contactId });
  }

  return { ok: true, conversation_ids: [input.conversationId], contact_id: contactId };
}
