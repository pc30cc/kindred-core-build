/**
 * COMPLIANCE — the single choke point for `audit_logs` writes from
 * TypeScript.
 *
 * Eleven producers append here: conversation/audit pairs, commerce, privacy,
 * phone verification, the admin call-recording legal-hold surfaces, admin
 * user deletion, the widget debug-mode toggle, the Map & Geo admin surface
 * and the platform call-center settings. Each keeps building its own row
 * shape — this module exists only so there is ONE place where "is the
 * compliance record still being written?" can be answered and gated.
 *
 * Gated by COMPLIANCE_AUDIT_LOGGING, which is documented as
 * do-not-disable-in-production; see server/config.ts. When the flag is off
 * this resolves to `{ error: null }`: a suppressed write is a SUCCESSFUL
 * no-op, so callers that inspect `error` never surface a spurious failure to
 * a user for a row the operator asked not to keep.
 */
import type { ServerConfig } from '../config.js';
import type { ServiceClient } from '../supabase.js';

export type AuditLogRow = Record<string, unknown>;

/**
 * Mirrors PostgREST's own `{ error }` result so call sites keep whatever
 * error handling they already had (inspect it, ignore it, or attach a
 * `.then()` and stay non-blocking).
 */
export async function insertAuditLogRows(
  config: ServerConfig,
  sb: ServiceClient,
  rows: AuditLogRow | AuditLogRow[],
): Promise<{ error: { message: string } | null }> {
  if (config.complianceAuditLoggingEnabled === false) return { error: null };
  const { error } = await sb.from('audit_logs').insert(rows as any);
  return { error: error ? { message: error.message } : null };
}
