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
 * session tokens are never part of the key, the fingerprint input digest or
 * the stored result.
 */
import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sha256Hex } from './tokens.js';

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

export function deriveFingerprint(operation: string, input: Record<string, unknown>): string {
  return sha256Hex(`wi-fp-v1|${operation}|${canonical(input)}`);
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
