/**
 * Anonymous visitor display code — `contacts.visitor_code`.
 *
 * Belongs to the persistent contact identity (see anonymousContact.ts /
 * identityMerge.ts), never to a browsing session: generated once, the first
 * time a contact row is created or lazily backfilled, then left untouched
 * for the lifetime of that contact. Display-only — see contact-display.ts
 * for the resolver that turns this + a city into an operator-facing label.
 *
 * Crockford-style alphabet with ambiguous characters (0/O, 1/I/L) dropped so
 * an operator reading it aloud or typing it into search can't misplace a
 * character. crypto.randomBytes, not Math.random() — same bar as every other
 * token generator in this codebase (see security.ts / widgetSession.ts).
 */
import crypto from 'crypto';

export const VISITOR_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const VISITOR_CODE_LENGTH = 4;

export function generateVisitorCode(length = VISITOR_CODE_LENGTH): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += VISITOR_CODE_ALPHABET[bytes[i] % VISITOR_CODE_ALPHABET.length];
  }
  return out;
}

const PG_UNIQUE_VIOLATION = '23505';
const MAX_ATTEMPTS = 5;

/** True for a unique_violation on visitor_code specifically (not some other constraint). */
export function isVisitorCodeConflict(error: any): boolean {
  return !!error && error.code === PG_UNIQUE_VIOLATION
    && typeof error.message === 'string'
    && error.message.includes('visitor_code');
}

/**
 * Insert a new contact with a race-safe visitor_code.
 *
 * Each attempt is a REAL insert with a freshly generated code — not a
 * check-then-insert — so uniqueness is enforced by the DB constraint
 * itself, never by a client-side race window. Only a genuine visitor_code
 * conflict retries with a new code; any other insert error (bad payload,
 * connection failure, a *different* constraint) is returned immediately,
 * unmodified, so callers keep their existing error handling.
 *
 * If every attempt in the bounded loop collides, inserts once more with
 * visitor_code: null (never violates the partial unique index) so contact
 * creation is never blocked by code-space contention, then immediately
 * tries to backfill a code onto that same row via backfillVisitorCode.
 * The returned row reflects whichever code (if any) actually landed.
 */
export async function insertContactWithVisitorCode(
  sb: any,
  buildPayload: (visitorCode: string | null) => Record<string, unknown>,
  selectColumns: string,
  maxAttempts = MAX_ATTEMPTS,
): Promise<{ data: any | null; error: any }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateVisitorCode();
    const { data, error } = await sb
      .from('contacts').insert(buildPayload(code)).select(selectColumns).single();
    if (!error) return { data, error: null };
    if (!isVisitorCodeConflict(error)) return { data: null, error };
    // else: genuine collision — loop again with a fresh code.
  }

  const { data, error } = await sb
    .from('contacts').insert(buildPayload(null)).select(selectColumns).single();
  if (error) return { data: null, error };

  const id = (data as any)?.id;
  if (id) {
    const backfilled = await backfillVisitorCode(sb, id);
    if (backfilled) (data as any).visitor_code = backfilled;
  }
  return { data, error: null };
}

/**
 * Race-safe backfill for a contact that currently has visitor_code: null
 * (a legacy row, or one that just fell through insertContactWithVisitorCode's
 * retry loop). Each attempt is a real UPDATE ... WHERE visitor_code IS NULL
 * with a freshly generated code, scoped by the contact's own id (which
 * already pins it to one row/workspace); only a genuine visitor_code
 * conflict — i.e. this workspace already has another contact with the
 * generated code, caught by the 021 migration's partial unique index —
 * retries with a new code. Never throws — returns null (leaving the row
 * codeless) if every attempt collides or the update otherwise fails, since
 * the display resolver already renders a graceful fallback for that case.
 *
 * ALWAYS returns the value actually persisted on the row, never merely the
 * value this call attempted to write. `error === null` on an
 * `UPDATE ... WHERE visitor_code IS NULL` does NOT mean our code landed —
 * Postgres/PostgREST report success with zero affected rows just as
 * happily as with one, and a concurrent caller can win that exact race
 * between our WHERE check and our own write. `.select()` on the update
 * tells them apart: an empty result means the WHERE clause matched nothing
 * (either the row already had a code, or doesn't exist), so we read the
 * row back and return whatever is actually there instead of the code we
 * merely generated.
 */
export async function backfillVisitorCode(
  sb: any,
  contactId: string,
  maxAttempts = MAX_ATTEMPTS,
): Promise<string | null> {
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = generateVisitorCode();
      const { data, error } = await sb
        .from('contacts')
        .update({ visitor_code: code })
        .eq('id', contactId)
        .is('visitor_code', null)
        .select('visitor_code');
      if (error) {
        if (!isVisitorCodeConflict(error)) return null;
        continue; // genuine collision — loop again with a fresh code.
      }
      const rows: Array<{ visitor_code?: string | null }> = Array.isArray(data) ? data : (data ? [data] : []);
      if (rows.length > 0) {
        // We actually won the race: our own write is what's on the row now.
        return rows[0]?.visitor_code ?? code;
      }
      // Zero rows updated — someone else already filled it (or the contact
      // doesn't exist). Read back the real, persisted value instead of
      // returning the code we only ever generated, never wrote.
      const { data: current } = await sb
        .from('contacts')
        .select('visitor_code')
        .eq('id', contactId)
        .maybeSingle();
      return (current as { visitor_code?: string | null } | null)?.visitor_code ?? null;
    }
  } catch {
    // best effort — display resolver falls back gracefully
  }
  return null;
}
