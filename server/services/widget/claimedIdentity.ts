/**
 * Visitor-claimed vs. proven contact identifiers (email / phone).
 *
 * An email address or phone number TYPED into the widget (pre-chat form,
 * `visitor_email` on POST /message, the call widget's pre-call form) is only
 * a claim: anyone can type anyone's address. It must therefore never be used
 * to find an EXISTING contact and attach the visitor to it — doing so linked
 * the visitor's sessions to that contact, issued a continuity cookie for it,
 * and let /identity/me, /identity/history and /message expose the real
 * customer's details and conversations to whoever typed the address.
 *
 * Rules implemented here:
 *  - Unproven identifiers only ever land on the visitor's OWN contact (the
 *    one already tied to their visitor id) or on a brand-new contact.
 *  - If another contact already holds the identifier, the claim is kept only
 *    as `metadata.unverified_email` / `metadata.unverified_phone` on the
 *    visitor's own contact, so the operator still sees what was typed.
 *  - When an unproven identifier IS written to the column (nobody held it),
 *    the same metadata key marks it as a claim. A later proven identity
 *    (verify/confirm, signed store identity) for that identifier releases it
 *    from the claiming contact instead of adopting that contact — otherwise
 *    an attacker could pre-claim a victim's address and receive the victim's
 *    future conversations once the victim verified.
 *  - Only proven identifiers resolve to an existing contact.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type IdentifierColumn = 'email' | 'phone';

/** Metadata key recording that the column value is only a visitor claim. */
export function unverifiedKey(column: IdentifierColumn): 'unverified_email' | 'unverified_phone' {
  return column === 'email' ? 'unverified_email' : 'unverified_phone';
}

interface HolderRow {
  id: string;
  visitor_code?: string | null;
  metadata?: Record<string, unknown> | null;
}

async function findHolder(
  sb: SupabaseClient,
  workspaceId: string,
  column: IdentifierColumn,
  value: string,
): Promise<HolderRow | null> {
  const { data } = await sb
    .from('contacts')
    .select('id, visitor_code, metadata')
    .eq('workspace_id', workspaceId)
    .eq(column, value)
    .limit(1)
    .maybeSingle();
  const row = data as HolderRow | null;
  return row?.id ? row : null;
}

/** True when the holder's column value was only ever claimed, never proven. */
export function isClaimOnly(row: { metadata?: Record<string, unknown> | null }, column: IdentifierColumn, value: string): boolean {
  const meta = row.metadata || {};
  return meta[unverifiedKey(column)] === value;
}

/**
 * PROVEN identifiers only (verify/confirm, signed store identity): the
 * contact that owns this email/phone. A contact that merely CLAIMED the
 * identifier (typed, never verified) and is not the caller's own contact is
 * released instead — its column is cleared (the claim stays in its metadata
 * for the operator) — so the proven owner never joins a squatter's contact.
 */
export async function findContactByProvenIdentifiers(
  sb: SupabaseClient,
  workspaceId: string,
  email: string | null,
  phone: string | null,
  ownContactId: string | null,
): Promise<HolderRow | null> {
  const pairs: Array<[IdentifierColumn, string | null]> = [['email', email], ['phone', phone]];
  for (const [column, value] of pairs) {
    if (!value) continue;
    const holder = await findHolder(sb, workspaceId, column, value);
    if (!holder) continue;
    if (holder.id !== ownContactId && isClaimOnly(holder, column, value)) {
      const { error } = await sb
        .from('contacts')
        .update({ [column]: null, updated_at: new Date().toISOString() })
        .eq('id', holder.id);
      if (error) throw new Error(`claim_release_failed: ${error.message}`);
      continue;
    }
    return holder;
  }
  return null;
}

export interface UnverifiedIdentifierPlacement {
  /** Value that may be written to `contacts.email` (null → metadata only). */
  email: string | null;
  /** Value that may be written to `contacts.phone` (null → metadata only). */
  phone: string | null;
  /** Metadata recording the claim (`unverified_email` / `unverified_phone`). */
  metadata: Record<string, string>;
}

/**
 * UNPROVEN identifiers: decide where a visitor-typed email/phone may be
 * stored on the visitor's own (or new) contact. Never returns — or links —
 * any other contact.
 */
export async function placeUnverifiedIdentifiers(
  sb: SupabaseClient,
  workspaceId: string,
  email: string | null,
  phone: string | null,
  ownContactId: string | null,
): Promise<UnverifiedIdentifierPlacement> {
  const out: UnverifiedIdentifierPlacement = { email: null, phone: null, metadata: {} };
  const pairs: Array<[IdentifierColumn, string | null]> = [['email', email], ['phone', phone]];
  for (const [column, value] of pairs) {
    if (!value) continue;
    const holder = await findHolder(sb, workspaceId, column, value);
    if (holder && holder.id === ownContactId) {
      // Already on the visitor's own contact — keep whatever proof status
      // it has (a proven value must not be downgraded to a claim).
      out[column] = value;
      if (isClaimOnly(holder, column, value)) out.metadata[unverifiedKey(column)] = value;
      continue;
    }
    out.metadata[unverifiedKey(column)] = value;
    if (!holder) out[column] = value;
  }
  return out;
}

/** A unique-index race on email/phone (another request won the insert). */
export function isContactIdentityConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e?.code !== '23505' || typeof e?.message !== 'string') return false;
  return e.message.includes('contacts_workspace_email_unique_not_blank')
    || e.message.includes('contacts_workspace_phone_unique_not_blank');
}
