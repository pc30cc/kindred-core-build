/** Persist signed WHMCS profile data independently of the revocable login grant. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertContactWithVisitorCode } from '../../widget/visitorCode.js';
import { CommerceError } from '../../../../shared/commerce/types.js';

interface Profile {
  workspaceId: string;
  visitorId: string;
  installationId: string;
  userId: string;
  name?: string;
  email?: string;
}
interface Contact {
  id: string;
  name: string | null;
  email: string | null;
  metadata: Record<string, unknown> | null;
}
const columns = 'id, name, email, metadata';
function checked<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`WHMCS contact sync failed: ${result.error.message}`);
  return result.data;
}
function belongsToAnotherUser(contact: Contact, p: Profile): boolean {
  const m = contact.metadata || {};
  return !!m.whmcs_user_id && (m.whmcs_user_id !== p.userId || m.whmcs_installation_id !== p.installationId);
}

/** No writes for an unchanged profile; errors propagate so the loader can retry. */
export async function syncWhmcsContact(sb: SupabaseClient, p: Profile): Promise<{ contactId: string; changed: boolean; conversationIds: string[] } | null> {
  const name = p.name?.trim() || null;
  const email = p.email?.trim().toLowerCase() || null;
  if (!name && !email) return null; // share_contact disabled: never clear stored data
  const sessions = checked(await sb.from('visitor_sessions').select('id, contact_id, identity_state')
    .eq('workspace_id', p.workspaceId).eq('visitor_id', p.visitorId).order('last_seen_at', { ascending: false }));
  const sessionContact = sessions?.find(s => s.contact_id)?.contact_id;
  const visitorContact: Contact | null = sessionContact
    ? checked(await sb.from('contacts').select(columns).eq('workspace_id', p.workspaceId).eq('id', sessionContact).maybeSingle())
    : checked(await sb.from('contacts').select(columns).eq('workspace_id', p.workspaceId)
      .contains('metadata', { visitor_id: p.visitorId }).limit(1).maybeSingle());
  if (visitorContact && belongsToAnotherUser(visitorContact, p)) {
    throw new CommerceError('identity_expired', 'a new visitor is required for a different WHMCS user');
  }
  const byEmail: Contact | null = email ? checked(await sb.from('contacts').select(columns)
    .eq('workspace_id', p.workspaceId).eq('email', email).limit(1).maybeSingle()) : null;
  if (byEmail && belongsToAnotherUser(byEmail, p)) {
    throw new CommerceError('identity_expired', 'contact belongs to another WHMCS user');
  }
  // Prefer the existing email identity if there is one. Move only THIS visitor's
  // guest history, never other visitors' conversations or another verified user.
  let contact = byEmail || visitorContact;
  let changed = false;
  const marker = { whmcs_installation_id: p.installationId, whmcs_user_id: p.userId, anonymous: false };
  if (!contact) {
    const result = await insertContactWithVisitorCode(sb, visitorCode => ({
      workspace_id: p.workspaceId, name, email, visitor_code: visitorCode,
      metadata: { source: 'widget', visitor_id: p.visitorId, ...marker },
    }), columns);
    if (result.error?.code === '23505' && email) {
      // A concurrent page may have created the same email contact.
      contact = checked(await sb.from('contacts').select(columns).eq('workspace_id', p.workspaceId)
        .eq('email', email).limit(1).maybeSingle());
      if (!contact || belongsToAnotherUser(contact, p)) throw new Error('WHMCS contact conflict');
    } else contact = checked(result);
    if (!contact) throw new Error('WHMCS contact insert returned no row');
    changed = true;
  }
  const metadata = contact.metadata || {};
  const updates: Record<string, unknown> = {};
  if (name && contact.name !== name) updates.name = name;
  if (email && contact.email !== email) updates.email = email;
  if (Object.entries(marker).some(([key, value]) => metadata[key] !== value)) {
    updates.metadata = { ...metadata, ...marker };
  }
  if (Object.keys(updates).length) {
    let update = sb.from('contacts').update(updates).eq('workspace_id', p.workspaceId).eq('id', contact.id);
    update = metadata.whmcs_user_id
      ? update.eq('metadata->>whmcs_user_id', p.userId).eq('metadata->>whmcs_installation_id', p.installationId)
      : update.is('metadata->>whmcs_user_id', null);
    const updated = checked(await update.select('id'));
    if (!updated?.length) throw new Error('WHMCS contact changed concurrently; retry required');
    changed = true;
  }
  // Repair partial failures on every attempt. Never reset identity on logout.
  for (const session of sessions || []) {
    if (session.contact_id && session.contact_id !== contact.id && session.contact_id !== visitorContact?.id) continue;
    if (session.contact_id === contact.id && session.identity_state === 'identified') continue;
    let query = sb.from('visitor_sessions').update({ contact_id: contact.id, identity_state: 'identified' })
      .eq('workspace_id', p.workspaceId).eq('id', session.id);
    query = session.contact_id ? query.eq('contact_id', session.contact_id) : query.is('contact_id', null);
    checked(await query);
    changed = true;
  }
  const conversations = checked(await sb.from('conversations').select('id, contact_id, metadata')
    .eq('workspace_id', p.workspaceId).contains('metadata', { visitor_id: p.visitorId }));
  if (sessions?.length) {
    const legacy = checked(await sb.from('conversations').select('id, contact_id, metadata')
      .eq('workspace_id', p.workspaceId).in('visitor_session_id', sessions.map(s => s.id)));
    for (const c of legacy || []) {
      // Canonical conversation ownership wins over an old session reference.
      if (c.metadata?.visitor_id && c.metadata.visitor_id !== p.visitorId) continue;
      if (!conversations.some(row => row.id === c.id)) conversations.push(c);
    }
  }
  const conversationIds: string[] = [];
  for (const conversation of conversations || []) {
    if (conversation.contact_id && conversation.contact_id !== contact.id && conversation.contact_id !== visitorContact?.id) continue;
    conversationIds.push(conversation.id);
    if (conversation.contact_id === contact.id) continue;
    let query = sb.from('conversations').update({ contact_id: contact.id, updated_at: new Date().toISOString() })
      .eq('workspace_id', p.workspaceId).eq('id', conversation.id);
    query = conversation.contact_id ? query.eq('contact_id', conversation.contact_id) : query.is('contact_id', null);
    checked(await query);
    changed = true;
  }
  return { contactId: contact.id, changed, conversationIds };
}
