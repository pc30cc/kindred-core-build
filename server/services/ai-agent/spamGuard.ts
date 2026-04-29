/**
 * AI Agent — spam guard.
 *
 * Cheap, side-effect-free read used by the engine to skip AI processing
 * for spam conversations. We check both:
 *   - conversations.is_spam       (per-thread quarantine)
 *   - contacts.is_spam            (identity-level flag)
 *
 * Either being true is sufficient. Failure is treated as "not spam" so a
 * transient DB error never silently blocks the AI for everyone.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export async function isConversationSpam(
  config: ServerConfig,
  conversationId: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('is_spam, contact_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return false;
    if ((conv as any).is_spam === true) return true;
    const contactId = (conv as any).contact_id as string | null;
    if (!contactId) return false;
    const { data: contact } = await sb
      .from('contacts')
      .select('is_spam')
      .eq('id', contactId)
      .maybeSingle();
    return (contact as any)?.is_spam === true;
  } catch {
    return false;
  }
}
