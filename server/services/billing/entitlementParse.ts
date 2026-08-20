/**
 * Phase 6-S5-R7.3 §4 — strict parser for the entitlement / module RPCs.
 *
 * `check_workspace_entitlement` and `check_module_access` return a jsonb
 * object. Anything that is NOT a well-formed object carrying a boolean
 * `allowed` is an UNREADABLE result, never an authoritative denial: telling a
 * customer "your plan does not include this" because the RPC returned null is
 * a lie they cannot act on, and it hides a real outage.
 */

export type EntitlementParseOutcome = 'allowed' | 'denied' | 'unavailable';

/** Canonical internal reason for a structurally invalid RPC payload. */
export const INVALID_ENTITLEMENT_RESPONSE = 'invalid_entitlement_response';

export interface ParsedEntitlement {
  outcome: EntitlementParseOutcome;
  allowed: boolean | null;
  limit?: number;
  plan?: string;
  reason?: string;
  /**
   * Phase 6-S5-R7.4 §8 — true only when `allowed` is true AND the payload
   * carried a usable numeric `limit` (finite number, or -1 for unlimited).
   * A numeric gate must treat `false` here as UNREADABLE, never as zero.
   */
  limitValid?: boolean;
}

/**
 * Parses a raw RPC payload. `rpcError` short-circuits to `unavailable`.
 */
export function parseEntitlementResponse(
  data: unknown,
  rpcError?: unknown,
): ParsedEntitlement {
  if (rpcError) return { outcome: 'unavailable', allowed: null, reason: 'rpc_error' };
  if (data === null || data === undefined) {
    return { outcome: 'unavailable', allowed: null, reason: INVALID_ENTITLEMENT_RESPONSE };
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { outcome: 'unavailable', allowed: null, reason: INVALID_ENTITLEMENT_RESPONSE };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.allowed !== 'boolean') {
    return { outcome: 'unavailable', allowed: null, reason: INVALID_ENTITLEMENT_RESPONSE };
  }
  const rawLimit = obj.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? rawLimit
      : typeof rawLimit === 'string' && rawLimit.trim() && Number.isFinite(Number(rawLimit))
        ? Number(rawLimit)
        : undefined;
  return {
    outcome: obj.allowed ? 'allowed' : 'denied',
    allowed: obj.allowed,
    limit,
    limitValid: typeof limit === 'number' && Number.isFinite(limit),
    plan: typeof obj.plan === 'string' ? obj.plan : undefined,
    reason:
      typeof obj.reason === 'string'
        ? obj.reason
        : typeof obj.source === 'string'
          ? obj.source
          : undefined,
  };
}

/** True when this reason means "we could not evaluate", not "denied". */
export function isUnreadableEntitlementReason(reason: string | undefined): boolean {
  return (
    reason === 'rpc_error' ||
    reason === 'exception' ||
    reason === INVALID_ENTITLEMENT_RESPONSE ||
    reason === INVALID_ENTITLEMENT_LIMIT
  );
}

/** The one RPC that may legitimately be absent on a self-host install with no billing/plans subsystem. */
const CHECK_WORKSPACE_ENTITLEMENT_FN = 'check_workspace_entitlement';

/**
 * EXACT missing-function detection for `check_workspace_entitlement`,
 * mirroring `isPlatformSettingsTableMissing`'s (server/services/ai-agent/
 * platformSettings.ts) precision for the reciprocal case: a MISSING relation
 * there, a MISSING function here.
 *
 * Self-host ships with no billing/plans schema at all (no billing_plans,
 * workspace_subscriptions, or check_workspace_entitlement — see
 * database/migrations/039_account_workspace_provisioning.sql's own note on
 * this). A deployment in that shape cannot have a paid-tier restriction to
 * enforce, so callers use this to treat the RPC's outright absence as an
 * explicit "no billing subsystem installed" deployment fact, distinct from
 * every other RPC failure.
 *
 * Returns true ONLY when the database/PostgREST reports that
 * public.check_workspace_entitlement itself does not exist. A timeout,
 * permission error, wrong-argument-shape call, or any other RPC failure —
 * including on a deployment that DOES have the function installed — returns
 * false and MUST still fail closed via isUnreadableEntitlementReason. This
 * never fires for hosted (the function always exists there), so hosted's
 * fail-closed billing semantics are unchanged.
 */
export function isCheckWorkspaceEntitlementFunctionMissing(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  const code = String(error?.code || '');
  // 42883 = undefined_function (raw Postgres), PGRST202 = PostgREST
  // "could not find the function ... in the schema cache".
  if (code !== '42883' && code !== 'PGRST202') return false;

  const haystack = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  if (!haystack.trim()) return false;

  const named = new RegExp(
    `(^|[^a-z0-9_])(public\\.)?${CHECK_WORKSPACE_ENTITLEMENT_FN}([^a-z0-9_]|$)`,
  ).test(haystack);
  if (!named) return false;

  if (/permission denied/.test(haystack)) return false;

  return (
    /does not exist/.test(haystack) ||
    /could not find the function/.test(haystack) ||
    /schema cache/.test(haystack)
  );
}

/** Canonical internal reason for an `allowed:true` payload with no usable limit. */
export const INVALID_ENTITLEMENT_LIMIT = 'invalid_entitlement_limit';

/**
 * Phase 6-S5-R7.4 §8 — numeric-feature view of a parsed entitlement.
 *
 * `allowed:true` is authoritative for a NUMERIC feature only when the RPC
 * also reported a usable limit. Missing / NaN / Infinity / non-numeric string
 * limits must degrade to `unavailable` (503), never to "limit zero" (403).
 */
export function parseNumericEntitlementResponse(
  data: unknown,
  rpcError?: unknown,
): ParsedEntitlement {
  const parsed = parseEntitlementResponse(data, rpcError);
  if (parsed.outcome !== 'allowed') return parsed;
  if (parsed.limitValid) return parsed;
  return { outcome: 'unavailable', allowed: null, reason: INVALID_ENTITLEMENT_LIMIT };
}
