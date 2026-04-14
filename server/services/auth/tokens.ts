/**
 * DB-backed reset and verification token management.
 * Tokens are hashed before storage — single-use, time-limited.
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Reset Tokens ────────────────────────────────────────────────

export async function createResetToken(
  sb: SupabaseClient,
  userId: string,
  email: string,
  ip?: string
): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  // Revoke any existing unused reset tokens for this user
  await sb
    .from('auth_reset_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_at', null)
    .is('revoked_at', null);

  const { error } = await sb.from('auth_reset_tokens').insert({
    token_hash: tokenHash,
    user_id: userId,
    email,
    ip_address: ip || null,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[auth/tokens] Failed to create reset token:', error.message);
    throw new Error('Failed to create reset token');
  }

  return token;
}

export async function validateResetToken(
  sb: SupabaseClient,
  token: string
): Promise<{ userId: string; email: string } | null> {
  const tokenHash = hashToken(token);

  const { data, error } = await sb
    .from('auth_reset_tokens')
    .select('user_id, email, expires_at, used_at, revoked_at')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !data) return null;
  if (data.used_at || data.revoked_at) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  return { userId: data.user_id, email: data.email };
}

export async function consumeResetToken(sb: SupabaseClient, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await sb
    .from('auth_reset_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash);
}

// ─── Verify Tokens ───────────────────────────────────────────────

export async function createVerifyToken(
  sb: SupabaseClient,
  userId: string,
  email: string,
  ip?: string
): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString();

  // Revoke any existing unused verify tokens for this user
  await sb
    .from('auth_verify_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_at', null)
    .is('revoked_at', null);

  const { error } = await sb.from('auth_verify_tokens').insert({
    token_hash: tokenHash,
    user_id: userId,
    email,
    ip_address: ip || null,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[auth/tokens] Failed to create verify token:', error.message);
    throw new Error('Failed to create verify token');
  }

  return token;
}

export async function validateVerifyToken(
  sb: SupabaseClient,
  token: string
): Promise<{ userId: string; email: string } | null> {
  const tokenHash = hashToken(token);

  const { data, error } = await sb
    .from('auth_verify_tokens')
    .select('user_id, email, expires_at, used_at, revoked_at')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !data) return null;
  if (data.used_at || data.revoked_at) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  return { userId: data.user_id, email: data.email };
}

export async function consumeVerifyToken(sb: SupabaseClient, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await sb
    .from('auth_verify_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash);
}
