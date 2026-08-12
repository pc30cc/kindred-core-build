/**
 * Anonymous visitor contact.
 *
 * Every conversation MUST have a contact row — including AI-only threads and
 * threads started before the visitor fills the pre-chat / identification form.
 * We therefore create a placeholder contact at conversation-creation time.
 *
 * Contract (relied upon elsewhere in the codebase):
 *  • `name` stays the literal placeholder `'Visitor'` until the visitor
 *    actually submits a name. Several call sites detect "not yet identified"
 *    with `name !== 'Visitor'` — do not change this placeholder.
 *  • `metadata.anonymous = true` is cleared by identityMerge once real
 *    identity data arrives.
 *  • `metadata.anon_code` is a short, stable, human-friendly code the operator
 *    UI shows as `Visitor #ABCD` so unnamed threads stay distinguishable.
 */

export const ANON_CONTACT_NAME = 'Visitor';

/** Short uppercase code derived from the visitor/session id (stable per visitor). */
export function anonCodeFrom(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(4, '0').slice(-4);
}

export interface EnsureVisitorContactInput {
  workspaceId: string;
  visitorId?: string | null;
  sessionId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Find (by visitor_id metadata / email / phone) or create the contact for a
 * visitor. Returns null only when there is no identifier at all to anchor on
 * or the insert failed.
 */
export async function ensureVisitorContact(
  sb: any,
  input: EnsureVisitorContactInput,
): Promise<string | null> {
  const { workspaceId } = input;
  const visitorId = input.visitorId || null;
  const email = (input.email || '').trim().toLowerCase() || null;
  const phone = (input.phone || '').trim().replace(/[^\d+]/g, '') || null;

  try {
    if (visitorId) {
      const { data } = await sb
        .from('contacts').select('id')
        .eq('workspace_id', workspaceId)
        .contains('metadata', { visitor_id: visitorId })
        .limit(1).maybeSingle();
      if (data?.id) return data.id as string;
    }
    if (email) {
      const { data } = await sb
        .from('contacts').select('id')
        .eq('workspace_id', workspaceId).eq('email', email)
        .limit(1).maybeSingle();
      if (data?.id) return data.id as string;
    }
    if (phone) {
      const { data } = await sb
        .from('contacts').select('id')
        .eq('workspace_id', workspaceId).eq('phone', phone)
        .limit(1).maybeSingle();
      if (data?.id) return data.id as string;
    }

    const seed = visitorId || input.sessionId || `${Date.now()}`;
    const hasIdentity = !!(input.name || email || phone);
    const { data: created, error } = await sb
      .from('contacts').insert({
        workspace_id: workspaceId,
        name: input.name || ANON_CONTACT_NAME,
        email,
        phone,
        metadata: {
          visitor_id: visitorId,
          session_id: input.sessionId || null,
          source: 'widget',
          anonymous: !hasIdentity,
          anon_code: anonCodeFrom(seed),
        },
      })
      .select('id').single();
    if (error) {
      console.warn('[anonymousContact] insert failed:', error.message);
      return null;
    }
    return created?.id ?? null;
  } catch (err: any) {
    console.warn('[anonymousContact] threw:', err?.message || err);
    return null;
  }
}
