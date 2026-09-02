/**
 * WORKSPACE INVITATIONS v5.1 §10 — atomic, crash-safe idempotency (part B).
 *
 * Express NEVER writes public.workspace_invitation_idempotency. It hands the
 * server-derived key, the request fingerprint and the operation arguments to
 * ONE service_role RPC — public.wi_execute_idempotent — which acquires the
 * ledger row, runs the real mutation and records the safe result inside the
 * SAME database transaction.
 *
 * Consequences that the previous multi-write orchestration could not give:
 *   - a crash/rollback removes the ledger row: no permanent `in_progress`,
 *   - two concurrent requests with one key produce exactly one mutation,
 *   - a replay returns the stored secret-free projection, never a re-run,
 *   - the same key with a different fingerprint fails closed (409).
 *
 * Raw tokens, manual links, OTP codes, proofs, context handles, passwords and
 * session tokens are never STORED. Where a mutation's intent genuinely depends
 * on such a value (OTP code, password), the canonical fingerprint input carries
 * only a keyed HMAC digest of it (see deriveIntentDigest) — never the raw value
 * and never an unkeyed hash, so a database dump cannot brute-force it.
 */
import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type IdempotentOperation =
  | 'create' | 'edit' | 'resend' | 'rotate' | 'revoke' | 'archive'
  | 'login_context' | 'otp_request' | 'otp_verify' | 'accept_new' | 'accept_existing';

export interface IdempotentCall {
  operation: IdempotentOperation;
  scopeKind: 'workspace' | 'invitation' | 'public';
  requestId: string;
  actorId?: string | null;
  workspaceId?: string | null;
  invitationId?: string | null;
  /** Arguments forwarded to the dispatched RPC (already hashed where secret). */
  args: Record<string, unknown>;
  /** Stable, secret-free description of the caller's intent. */
  fingerprintInput: Record<string, unknown>;
}

export interface IdempotentOutcome<T = any> {
  replayed: boolean;
  resultCode: string;
  safeResult: Record<string, unknown>;
  result: T | null;
  error?: { message: string };
}

/**
 * Domain-separated key derivation. The raw INVITATION_LINK_SECRET is never
 * used directly as an HMAC key: every purpose gets its own HKDF-derived key,
 * so a compromise in one surface cannot forge another.
 */
const derivedKeys = new Map<string, Buffer>();
function domainKey(label: string): Buffer {
  const cached = derivedKeys.get(label);
  if (cached) return cached;
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(serverKeySecret(), 'utf8'),
      Buffer.from('workspace-invitation-idempotency', 'utf8'),
      Buffer.from(label, 'utf8'),
      32,
    ),
  );
  derivedKeys.set(label, key);
  return key;
}

/** Test/rotation support: forget cached derived keys. */
export function resetDerivedKeyCache(): void {
  derivedKeys.clear();
}

/** Constant-time hex digest comparison for any check performed outside PostgreSQL. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Keyed digest of a low-entropy or personal value (six-digit OTP, raw
 * password, email) for inclusion in a canonical fingerprint input.
 *
 * Unkeyed SHA-256 would let anyone holding a database dump brute-force a
 * six-digit OTP by hashing all one million candidates; the HKDF-derived key
 * lives only in the process environment, so the dump alone is useless.
 * The raw value is never stored and never logged.
 */
export function deriveIntentDigest(label: string, rawValue: string): string {
  return crypto.createHmac('sha256', domainKey(`intent:${label}:v1`)).update(rawValue, 'utf8').digest('hex');
}

function serverKeySecret(): string {
  const ring = process.env.INVITATION_LINK_SECRET?.trim();
  if (!ring) throw new Error('INVITATION_LINK_SECRET_MISSING');
  return ring;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Server-derived, scope-bound key. The client's requestId alone is never the key. */
export function deriveIdempotencyKey(call: Pick<IdempotentCall, 'operation' | 'scopeKind' | 'requestId' | 'actorId' | 'workspaceId' | 'invitationId'>): string {
  const material = [
    'wi-idem-v1',
    call.operation,
    call.scopeKind,
    call.actorId || 'anonymous',
    call.workspaceId || '-',
    call.invitationId || '-',
    call.requestId,
  ].join('|');
  return crypto.createHmac('sha256', serverKeySecret()).update(material).digest('hex');
}

/**
 * Keyed request fingerprint (v5.1 B.2). Only the final HMAC digest is stored;
 * the canonical input — which may contain an email, a phone number or an
 * intent digest — is never persisted and never logged.
 */
export function deriveFingerprint(operation: string, input: Record<string, unknown>): string {
  return crypto
    .createHmac('sha256', domainKey('fingerprint:v2'))
    .update(`wi-fp-v2|${operation}|${canonical(input)}`, 'utf8')
    .digest('hex');
}

/**
 * Deterministic secret material for retryable flows whose raw value lives only
 * in an HttpOnly cookie (login context handle, OTP proof). A retry with the
 * same requestId re-derives the identical raw value, so the cookie can be
 * re-issued after a lost response without minting a second DB row.
 */
export function deriveScopedSecret(scope: string, requestId: string, actorOrToken: string): string {
  return crypto
    .createHmac('sha256', serverKeySecret())
    .update(`wi-scoped-secret-v1|${scope}|${actorOrToken}|${requestId}`)
    .digest('base64url');
}

export async function runIdempotent<T = any>(config: ServerConfig, call: IdempotentCall): Promise<IdempotentOutcome<T>> {
  const sb = getServiceClient(config);
  const key = deriveIdempotencyKey(call);
  const fingerprint = deriveFingerprint(call.operation, call.fingerprintInput);

  const { data, error } = await sb.rpc('wi_execute_idempotent', {
    _key: key,
    _fingerprint: fingerprint,
    _operation: call.operation,
    _scope_kind: call.scopeKind,
    _workspace_id: call.workspaceId ?? null,
    _invitation_id: call.invitationId ?? null,
    _actor_id: call.actorId ?? null,
    _args: call.args,
  });

  if (error) {
    return { replayed: false, resultCode: 'ERROR', safeResult: {}, result: null, error: { message: String(error.message || '') } };
  }

  const envelope = (data || {}) as any;
  return {
    replayed: envelope.replayed === true,
    resultCode: String(envelope.result_code || 'COMMITTED'),
    safeResult: (envelope.safe_result || {}) as Record<string, unknown>,
    result: (envelope.result ?? null) as T | null,
  };
}

/**
 * Deterministic UUID for a retryable creation (e.g. the new user id of
 * accept-new): the same requestId always yields the same id, so a retry after
 * a lost response can never mint a second identity.
 */
export function deriveDeterministicUuid(scope: string, requestId: string, salt: string): string {
  const h = crypto.createHmac('sha256', serverKeySecret()).update(`wi-uuid-v1|${scope}|${salt}|${requestId}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
