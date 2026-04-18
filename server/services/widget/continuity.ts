/**
 * User Continuity Service
 * 
 * Server-issued opaque tokens that allow a known contact to restore their
 * conversation across devices. NOT the same as the visitor cookie.
 * 
 * - Token is opaque (random bytes)
 * - Only the SHA-256 hash is stored in DB
 * - Constant-time hash comparison
 * - Revocable, expirable
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const CONTINUITY_TOKEN_BYTES = 48;
const CONTINUITY_TTL_DAYS = 90;

function hashContinuityToken(token: string): string {
  // Use HMAC for keyed hash so a DB leak alone doesn't allow precomputed attacks
  const key = process.env.WIDGET_CONTINUITY_SECRET
    || process.env.WIDGET_SIGNING_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';
  if (!key) throw new Error('Missing WIDGET_CONTINUITY_SECRET');
  return crypto.createHmac('sha256', 'continuity:' + key).update(token).digest('hex');
}

export interface IssuedContinuityToken {
  token: string;       // raw token returned to client (cookie or one-time link)
  tokenHash: string;
  expiresAt: Date;
}

export function issueContinuityToken(): IssuedContinuityToken {
  const token = crypto.randomBytes(CONTINUITY_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashContinuityToken(token);
  const expiresAt = new Date(Date.now() + CONTINUITY_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash, expiresAt };
}

export interface AttachContinuityOptions {
  workspaceId: string;
  contactId: string;
  deviceInfo?: Record<string, unknown>;
}

export async function persistContinuityToken(
  supabase: SupabaseClient,
  opts: AttachContinuityOptions
): Promise<{ token: string; expiresAt: Date } | null> {
  const issued = issueContinuityToken();
  const { error } = await supabase.from('user_continuity_tokens').insert({
    workspace_id: opts.workspaceId,
    contact_id: opts.contactId,
    token_hash: issued.tokenHash,
    device_info: opts.deviceInfo || {},
    expires_at: issued.expiresAt.toISOString(),
  });
  if (error) return null;
  return { token: issued.token, expiresAt: issued.expiresAt };
}

export interface ResolveContinuityResult {
  valid: boolean;
  contactId?: string;
  error?: string;
}

export async function resolveContinuityToken(
  supabase: SupabaseClient,
  workspaceId: string,
  token: string
): Promise<ResolveContinuityResult> {
  if (!token) return { valid: false, error: 'missing_token' };
  const tokenHash = hashContinuityToken(token);

  const { data: row } = await supabase
    .from('user_continuity_tokens')
    .select('id, contact_id, expires_at, revoked_at, token_hash')
    .eq('workspace_id', workspaceId)
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!row) return { valid: false, error: 'not_found' };
  if (row.revoked_at) return { valid: false, error: 'revoked' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { valid: false, error: 'expired' };

  // Constant-time double-check against the stored hash
  if (
    tokenHash.length !== row.token_hash.length ||
    !crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(row.token_hash))
  ) {
    return { valid: false, error: 'mismatch' };
  }

  await supabase
    .from('user_continuity_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id);

  return { valid: true, contactId: row.contact_id || undefined };
}

export async function revokeContinuityToken(
  supabase: SupabaseClient,
  workspaceId: string,
  token: string
): Promise<boolean> {
  const tokenHash = hashContinuityToken(token);
  const { error } = await supabase
    .from('user_continuity_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('token_hash', tokenHash);
  return !error;
}
