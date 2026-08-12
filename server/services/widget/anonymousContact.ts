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
 *    Superseded by the `visitor_code` column (see visitorCode.ts) for any
 *    contact created/touched after the 021 migration; kept as a read-only
 *    display fallback for older rows contact-display.ts may still meet.
 */
import { generateUniqueVisitorCode, isVisitorCodeConflict } from './visitorCode.js';

export const ANON_CONTACT_NAME = 'Visitor';

/**
 * Pin the contact on this visitor's sessions so every network surface
 * (contact IP lookup, geo, Visitors list) can resolve it. Without this the
 * contact exists but has no session, so IP/location never show up.
 */
async function linkContactToSessions(
  sb: any,
  workspaceId: string,
  contactId: string,
  visitorId: string | null,
  sessionId: string | null,
): Promise<void> {
  try {
    if (visitorId) {
      await sb.from('visitor_sessions')
        .update({ contact_id: contactId })
        .eq('workspace_id', workspaceId)
        .eq('visitor_id', visitorId)
        .is('contact_id', null);
    }
    if (sessionId) {
      await sb.from('visitor_sessions')
        .update({ contact_id: contactId })
        .eq('workspace_id', workspaceId)
        .eq('id', sessionId)
        .is('contact_id', null);
    }
  } catch { /* best effort */ }
}

/** Short uppercase code derived from the visitor/session id (stable per visitor). */
export function anonCodeFrom(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(4, '0').slice(-4);
}

/**
 * Lazy backfill for a contact found by an existing-identifier lookup. Legacy
 * contacts (created before the 021 migration) and contacts whose earlier
 * insert lost the collision-retry race both land here — best effort, never
 * blocks returning the caller's contactId.
 */
async function backfillVisitorCodeIfMissing(
  sb: any,
  workspaceId: string,
  contactId: string,
  existingCode: string | null | undefined,
): Promise<void> {
  if (existingCode) return;
  try {
    const code = await generateUniqueVisitorCode(sb, workspaceId);
    if (!code) return;
    const { error } = await sb
      .from('contacts')
      .update({ visitor_code: code })
      .eq('id', contactId)
      .is('visitor_code', null);
    if (error && !isVisitorCodeConflict(error)) {
      console.warn('[anonymousContact] visitor_code backfill failed:', error.message);
    }
  } catch { /* best effort — display resolver falls back gracefully */ }
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
        .from('contacts').select('id, visitor_code')
        .eq('workspace_id', workspaceId)
        .contains('metadata', { visitor_id: visitorId })
        .limit(1).maybeSingle();
      if (data?.id) {
        await linkContactToSessions(sb, workspaceId, data.id, visitorId, input.sessionId || null);
        await backfillVisitorCodeIfMissing(sb, workspaceId, data.id, data.visitor_code);
        return data.id as string;
      }
    }
    if (email) {
      const { data } = await sb
        .from('contacts').select('id, visitor_code')
        .eq('workspace_id', workspaceId).eq('email', email)
        .limit(1).maybeSingle();
      if (data?.id) {
        await linkContactToSessions(sb, workspaceId, data.id, visitorId, input.sessionId || null);
        await backfillVisitorCodeIfMissing(sb, workspaceId, data.id, data.visitor_code);
        return data.id as string;
      }
    }
    if (phone) {
      const { data } = await sb
        .from('contacts').select('id, visitor_code')
        .eq('workspace_id', workspaceId).eq('phone', phone)
        .limit(1).maybeSingle();
      if (data?.id) {
        await linkContactToSessions(sb, workspaceId, data.id, visitorId, input.sessionId || null);
        await backfillVisitorCodeIfMissing(sb, workspaceId, data.id, data.visitor_code);
        return data.id as string;
      }
    }

    const seed = visitorId || input.sessionId || `${Date.now()}`;
    const hasIdentity = !!(input.name || email || phone);
    const buildPayload = (visitorCode: string | null) => ({
      workspace_id: workspaceId,
      name: input.name || ANON_CONTACT_NAME,
      email,
      phone,
      visitor_code: visitorCode,
      metadata: {
        visitor_id: visitorId,
        session_id: input.sessionId || null,
        source: 'widget',
        anonymous: !hasIdentity,
        anon_code: anonCodeFrom(seed),
      },
    });

    const visitorCode = await generateUniqueVisitorCode(sb, workspaceId);
    let { data: created, error } = await sb
      .from('contacts').insert(buildPayload(visitorCode)).select('id').single();

    // A visitor_code collision here means another concurrent request won the
    // same code between our uniqueness check and this insert — retry once
    // without a code rather than fail the whole contact creation.
    if (error && isVisitorCodeConflict(error)) {
      ({ data: created, error } = await sb
        .from('contacts').insert(buildPayload(null)).select('id').single());
    }
    if (error) {
      console.warn('[anonymousContact] insert failed:', error.message);
      return null;
    }
    if (created?.id) {
      await linkContactToSessions(sb, workspaceId, created.id, visitorId, input.sessionId || null);
      if (!visitorCode) await backfillVisitorCodeIfMissing(sb, workspaceId, created.id, null);
    }
    return created?.id ?? null;
  } catch (err: any) {
    console.warn('[anonymousContact] threw:', err?.message || err);
    return null;
  }
}
