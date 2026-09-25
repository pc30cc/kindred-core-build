import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';
import { mergeVisitorIdentity, type PreChatIdentityInput } from '../widget/identityMerge.js';
import { CommerceError } from '../../../shared/commerce/types.js';

/** Only call after verifying the store signature. Never accepts browser profile fields. */
export async function syncStoreContact(
  config: ServerConfig, sb: SupabaseClient, workspaceId: string,
  visitorId: string, identity: PreChatIdentityInput,
): Promise<void> {
  const { data: contact, error } = await sb.from('contacts')
    .select('id, name, email, phone, metadata')
    .eq('workspace_id', workspaceId)
    .contains('metadata', { visitor_id: visitorId }).limit(1).maybeSingle();
  if (error) throw new Error('store_contact_lookup_failed');
  const email = identity.email?.trim().toLowerCase() || null;
  const phone = identity.phone?.replace(/[^\d+]/g, '') || null;
  // A shared browser must obtain a fresh visitor before adopting another account.
  if (contact?.email && email && contact.email.toLowerCase() !== email) {
    throw new CommerceError('identity_expired', 'store customer changed; fresh visitor required');
  }
  if (contact && !contact.metadata?.anonymous
    && (!identity.name || (contact.name && contact.name !== 'Visitor'))
    && (!email || contact.email) && (!phone || contact.phone)) return;

  await mergeVisitorIdentity(config, sb, {
    workspaceId, visitorId, identity, method: 'token', verifiedStoreIdentity: true,
  });
}
