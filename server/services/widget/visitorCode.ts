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

/**
 * Generate a code guaranteed unused in this workspace at the moment of the
 * check. `contacts_workspace_visitor_code_idx` (021 migration) is the real
 * race-safety backstop — a concurrent insert that slips past this check
 * still gets rejected there, and callers must treat a 23505 on `visitor_code`
 * from their own insert/update as non-fatal (retry once, or persist without
 * a code — see isVisitorCodeConflict below). Never blocks/throws: a
 * workspace with pathological visitor_code density just falls back to no
 * code faster than usual, and the display resolver already renders a
 * legacy/id-derived fallback when one is absent.
 */
export async function generateUniqueVisitorCode(
  sb: any,
  workspaceId: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateVisitorCode();
    try {
      const { data } = await sb
        .from('contacts')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('visitor_code', code)
        .limit(1)
        .maybeSingle();
      if (!data) return code;
    } catch {
      // Lookup failure (e.g. column not migrated yet on an older deploy) —
      // stop trying rather than write a code we couldn't check.
      return null;
    }
  }
  return null;
}

/** True for a unique_violation on visitor_code specifically (not some other constraint). */
export function isVisitorCodeConflict(error: any): boolean {
  return !!error && error.code === PG_UNIQUE_VIOLATION
    && typeof error.message === 'string'
    && error.message.includes('visitor_code');
}
