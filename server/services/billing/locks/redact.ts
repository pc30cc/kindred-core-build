// ============================================================================
// SIMPLE BILLING phase 4 — a locked contact as the panel may see it.
//
// The blur is done here, on the server: a locked contact's stored fields
// never reach the browser. Only its id and creation time stay (the list keeps
// its order and the row count), with `locked: true`. Every other field is
// blanked, including any added later, so a new column cannot leak by default.
// ============================================================================

/** Fields a locked contact keeps as they are. */
const KEPT = new Set(['id', 'workspace_id', 'created_at']);

/** Fields blanked to an empty value of their own shape, so the client's types still hold. */
const EMPTY: Record<string, unknown> = { tags: [], metadata: {} };

/** A visitor code shows its first two characters only ("V8••••"); null stays null. */
export function maskVisitorCode(code: unknown): string | null {
  if (typeof code !== 'string' || !code) return null;
  return `${code.slice(0, 2)}••••`;
}

/**
 * The contact with everything but its id and creation time blanked (name,
 * email, phone, notes, metadata, tags, avatar, …), its visitor code masked,
 * and `locked: true`. Used for the contacts list and for the contact joined to
 * a chat in the inbox (D4).
 */
export function redactContact<T extends Record<string, unknown>>(row: T): T & { locked: true } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (KEPT.has(key)) out[key] = value;
    else if (key === 'visitor_code') out[key] = maskVisitorCode(value);
    else if (key in EMPTY) out[key] = Array.isArray(EMPTY[key]) ? [] : {};
    else out[key] = null;
  }
  out.locked = true;
  return out as T & { locked: true };
}

/** The row unchanged with `locked: false`, or redacted when locked. */
export function contactForPanel<T extends Record<string, unknown>>(row: T, locked: boolean): T & { locked: boolean } {
  return locked ? redactContact(row) : { ...row, locked: false };
}
