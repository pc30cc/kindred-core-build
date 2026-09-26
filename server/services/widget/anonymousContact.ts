/**
 * Anonymous visitor contact.
 *
 * Every conversation MUST have a contact row — including AI-only threads and
 * threads started before the visitor fills the pre-chat / identification form.
 * We therefore create a placeholder contact at conversation-creation time.
 *
 * Contract (relied upon elsewhere in the codebase):
 *  • `name` stays NULL until the visitor actually submits a name — it is
 *    never seeded with a fake real name. `contacts.name` is already nullable
 *    for ordinary (non-widget) contacts created via the regular Contacts API
 *    (see contacts-api.ts), so this is not a new state for the column.
 *    LEGACY: rows created before this change may still carry the literal
 *    string `'Visitor'` (see ANON_CONTACT_NAME below) — every "not yet
 *    identified" check in this codebase (and the display resolver in
 *    contact-display.ts) must keep treating that literal as equivalent to
 *    null, not just `!name`.
 *  • `metadata.anonymous = true` is cleared by identityMerge once real
 *    identity data arrives.
 *  • `metadata.anon_code` is a short, stable, human-friendly code the operator
 *    UI shows as `Visitor #ABCD` so unnamed threads stay distinguishable.
 *    Superseded by the `visitor_code` column (see visitorCode.ts) for any
 *    contact created/touched after the 021 migration; kept as a read-only
 *    display fallback for older rows contact-display.ts may still meet.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertContactWithVisitorCode, backfillVisitorCode } from './visitorCode.js';
import {
  findContactByProvenIdentifiers,
  isContactIdentityConflict,
  placeUnverifiedIdentifiers,
} from './claimedIdentity.js';

/** Legacy-only: the literal name value earlier versions of this module wrote
 * for an anonymous contact. New rows use `name: null` instead — see the
 * module doc comment above. Kept so "was this ever the anonymous
 * placeholder" checks have one canonical value to compare against. */
export const ANON_CONTACT_NAME = 'Visitor';

/**
 * Pin the contact on this visitor's sessions so every network surface
 * (contact IP lookup, geo, Visitors list) can resolve it. Without this the
 * contact exists but has no session, so IP/location never show up.
 */
async function linkContactToSessions(
  sb: SupabaseClient,
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
 * insert exhausted its collision-retry budget both land here — best effort,
 * never blocks returning the caller's contactId. See visitorCode.ts's
 * backfillVisitorCode for the race-safe retry behavior.
 */
async function backfillVisitorCodeIfMissing(
  sb: SupabaseClient,
  contactId: string,
  existingCode: string | null | undefined,
): Promise<void> {
  if (existingCode) return;
  await backfillVisitorCode(sb, contactId);
}

/**
 * A concurrent widget request can win the workspace-scoped email/phone
 * unique-index race after our initial lookup but before our insert. For a
 * PROVEN identity the losing insert adopts the winner instead of creating a
 * conversation with contact_id=null. An unproven (visitor-typed) identity
 * never adopts it — see ensureVisitorContact.
 */
async function findContactAfterIdentityConflict(
  sb: SupabaseClient,
  workspaceId: string,
  email: string | null,
  phone: string | null,
): Promise<{ id: string; visitor_code?: string | null } | null> {
  return findContactByProvenIdentifiers(sb, workspaceId, email, phone, null);
}

export interface EnsureVisitorContactInput {
  workspaceId: string;
  visitorId?: string | null;
  sessionId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * true ONLY when email/phone come from a server-verified source (a signed
   * store identity assertion). Visitor-typed values (POST /message
   * `visitor_email` / `visitor_phone`) must leave this unset: they are then
   * stored on the visitor's own/new contact as an unverified claim and never
   * used to find — or link the visitor to — an existing contact.
   */
  identityVerified?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find (by visitor_id metadata, or — for a proven identity only — by
 * email / phone) or create the contact for a visitor. Returns null only when
 * there is no identifier at all to anchor on or the insert failed.
 */
export async function ensureVisitorContact(
  sb: SupabaseClient,
  input: EnsureVisitorContactInput,
): Promise<string | null> {
  const { workspaceId } = input;
  const visitorId = input.visitorId || null;
  const email = (input.email || '').trim().toLowerCase() || null;
  const phone = (input.phone || '').trim().replace(/[^\d+]/g, '') || null;
  const verified = input.identityVerified === true;

  try {
    if (visitorId) {
      const { data } = await sb
        .from('contacts').select('id, visitor_code')
        .eq('workspace_id', workspaceId)
        .contains('metadata', { visitor_id: visitorId })
        .limit(1).maybeSingle();
      if (data?.id) {
        await linkContactToSessions(sb, workspaceId, data.id, visitorId, input.sessionId || null);
        await backfillVisitorCodeIfMissing(sb, data.id, data.visitor_code);
        return data.id as string;
      }
    }
    if (verified && (email || phone)) {
      const existing = await findContactByProvenIdentifiers(sb, workspaceId, email, phone, null);
      if (existing?.id) {
        await linkContactToSessions(sb, workspaceId, existing.id, visitorId, input.sessionId || null);
        await backfillVisitorCodeIfMissing(sb, existing.id, existing.visitor_code);
        return existing.id;
      }
    }

    // Unproven identifiers never select an existing contact: they are stored
    // on the NEW contact only when nobody else holds them, and always as a
    // claim in metadata so the operator still sees what the visitor typed.
    const placement = verified
      ? { email, phone, metadata: {} as Record<string, string> }
      : await placeUnverifiedIdentifiers(sb, workspaceId, email, phone, null);

    const seed = visitorId || input.sessionId || `${Date.now()}`;
    const hasIdentity = !!(input.name || email || phone);
    const buildPayloadWith = (cols: { email: string | null; phone: string | null }) =>
      (visitorCode: string | null) => ({
        workspace_id: workspaceId,
        name: input.name || null,
        email: cols.email,
        phone: cols.phone,
        visitor_code: visitorCode,
        metadata: {
          visitor_id: visitorId,
          session_id: input.sessionId || null,
          source: 'widget',
          anonymous: !hasIdentity,
          anon_code: anonCodeFrom(seed),
          ...placement.metadata,
        },
      });

    let { data: created, error } = await insertContactWithVisitorCode(
      sb, buildPayloadWith({ email: placement.email, phone: placement.phone }), 'id',
    );
    if (error && isContactIdentityConflict(error)) {
      if (verified) {
        const existing = await findContactAfterIdentityConflict(sb, workspaceId, email, phone);
        if (existing?.id) {
          await linkContactToSessions(sb, workspaceId, existing.id, visitorId, input.sessionId || null);
          await backfillVisitorCodeIfMissing(sb, existing.id, existing.visitor_code);
          return existing.id;
        }
      } else {
        // Someone else took the address between our check and our insert.
        // Keep the claim in metadata only — never adopt their contact.
        ({ data: created, error } = await insertContactWithVisitorCode(
          sb, buildPayloadWith({ email: null, phone: null }), 'id',
        ));
      }
    }
    if (error) {
      console.warn('[anonymousContact] insert failed:', (error as { message?: string }).message ?? error);
      return null;
    }
    const createdId = (created as { id?: string } | null)?.id ?? null;
    if (createdId) {
      await linkContactToSessions(sb, workspaceId, createdId, visitorId, input.sessionId || null);
    }
    return createdId;
  } catch (err) {
    console.warn('[anonymousContact] threw:', errorMessage(err));
    return null;
  }
}
