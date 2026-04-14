/**
 * DB-backed session management.
 * Sessions are stored in auth_sessions table — survives restarts, multi-instance safe.
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function generateSessionToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  sb: SupabaseClient,
  token: string,
  userId: string,
  email: string,
  ip?: string,
  userAgent?: string
): Promise<void> {
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const { error } = await sb.from('auth_sessions').insert({
    token_hash: tokenHash,
    user_id: userId,
    email,
    ip_address: ip || null,
    user_agent: userAgent || null,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[auth/sessions] Failed to create session:', error.message);
    throw new Error('Failed to create session');
  }
}

export async function getSession(
  sb: SupabaseClient,
  token: string
): Promise<{ userId: string; email: string } | null> {
  const tokenHash = hashToken(token);

  const { data, error } = await sb
    .from('auth_sessions')
    .select('user_id, email, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .single();

  if (error || !data) return null;

  // Check expiry
  if (new Date(data.expires_at) < new Date()) {
    // Expired — revoke it
    await sb.from('auth_sessions').update({ revoked_at: new Date().toISOString() }).eq('token_hash', tokenHash);
    return null;
  }

  return { userId: data.user_id, email: data.email };
}

export async function revokeSession(sb: SupabaseClient, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await sb.from('auth_sessions').update({ revoked_at: new Date().toISOString() }).eq('token_hash', tokenHash);
}

export async function revokeAllUserSessions(sb: SupabaseClient, userId: string): Promise<void> {
  await sb
    .from('auth_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null);
}

export { SESSION_TTL_MS };
