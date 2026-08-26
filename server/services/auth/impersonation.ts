/**
 * Admin "login as user" — first-party replacement for the old Supabase Auth
 * magic-link flow (`sb.auth.admin.generateLink({type:'magiclink'})` +
 * `${supabaseUrl}/auth/v1/verify?...`). That endpoint established a
 * Supabase session, which this backend no longer accepts as identity.
 *
 * Same token shape as auth_verify_tokens/auth_reset_tokens: a 32-byte
 * random token, only its SHA-256 hash stored, single-use, short-lived
 * (60s — this is consumed by a browser tab opened immediately after the
 * admin clicks the button, not a link that sits in an inbox).
 */
import crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const IMPERSONATION_TOKEN_TTL_MS = 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Issues a one-time impersonation token for `targetUserId`. Returns the raw token — never persisted. */
export async function issueImpersonationToken(
  config: ServerConfig,
  targetUserId: string,
  createdBy: string,
): Promise<string> {
  const sb = getServiceClient(config);
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + IMPERSONATION_TOKEN_TTL_MS).toISOString();

  const { error } = await sb.from('admin_impersonation_tokens').insert({
    target_user_id: targetUserId,
    created_by: createdBy,
    token_hash: hashToken(rawToken),
    expires_at: expiresAt,
  });
  if (error) {
    throw new Error(`Failed to issue impersonation token: ${error.message}`);
  }
  return rawToken;
}

export interface RedeemedImpersonation {
  targetUserId: string;
  createdBy: string;
}

/**
 * Redeems a one-time impersonation token. Returns null for anything other
 * than "valid, unused, unexpired".
 *
 * The single-use claim AND the expiry check happen in the SAME conditional
 * UPDATE (`used_at IS NULL AND expires_at > now()`), not a separate
 * SELECT-then-check-then-UPDATE: a token read a moment before its 60s TTL
 * expires must not be claimable by an UPDATE that lands a moment after —
 * with expiry only checked against a JS `Date` read earlier, that gap was
 * real. Row-level locking on the UPDATE makes the whole claim (single-use
 * AND not-expired) atomic, the same guarantee already used for the
 * reset/verify token redemption RPCs (030_atomic_auth_token_redemption.sql).
 */
export async function redeemImpersonationToken(
  config: ServerConfig,
  rawToken: string | null | undefined,
): Promise<RedeemedImpersonation | null> {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const sb = getServiceClient(config);
  const tokenHash = hashToken(rawToken);

  const { data, error } = await sb
    .from('admin_impersonation_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('target_user_id, created_by')
    .maybeSingle();

  if (error || !data) return null;

  return { targetUserId: data.target_user_id as string, createdBy: data.created_by as string };
}
