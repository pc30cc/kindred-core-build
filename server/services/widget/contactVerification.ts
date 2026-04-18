/**
 * Contact Verification Service
 * 
 * Backend-signed verification for email/phone identifiers.
 * - HMAC-SHA256 signed verification tokens
 * - Single-use, short TTL (10 minutes default)
 * - Hash stored in DB (not raw token)
 * - Constant-time hash comparison
 * - Replay protection via used_at timestamp
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const VERIFICATION_TTL_MINUTES = 10;
const TOKEN_LENGTH_BYTES = 32; // 256 bits
const MAX_VERIFY_ATTEMPTS = 5;

function getVerificationSecret(): Buffer {
  const base =
    process.env.WIDGET_VERIFICATION_SECRET ||
    process.env.WIDGET_SIGNING_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (!base) throw new Error('Missing WIDGET_VERIFICATION_SECRET');
  return crypto.createHash('sha256').update('contact-verification:' + base).digest();
}

function hashToken(token: string): string {
  return crypto.createHmac('sha256', getVerificationSecret()).update(token).digest('hex');
}

export interface IssuedVerification {
  token: string;        // raw token (sent to user via email/sms)
  tokenHash: string;    // stored hash
  nonce: string;
  expiresAt: Date;
}

/**
 * Generate a new verification token.
 * Caller is responsible for storing tokenHash and delivering raw token.
 */
export function issueVerificationToken(): IssuedVerification {
  const token = crypto.randomBytes(TOKEN_LENGTH_BYTES).toString('base64url');
  const nonce = crypto.randomBytes(8).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000);
  return { token, tokenHash, nonce, expiresAt };
}

/**
 * Constant-time hash comparison.
 */
export function compareTokenHash(token: string, storedHash: string): boolean {
  const computed = hashToken(token);
  if (computed.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

export interface RequestVerificationOptions {
  workspaceId: string;
  visitorId: string;
  channel: 'email' | 'phone';
  identifier: string;
  ipAddress?: string | null;
}

export interface RequestVerificationResult {
  success: boolean;
  tokenId?: string;
  rawToken?: string; // only returned to delivery layer (email/sms sender)
  expiresAt?: Date;
  error?: string;
}

export async function requestContactVerification(
  supabase: SupabaseClient,
  opts: RequestVerificationOptions
): Promise<RequestVerificationResult> {
  const { workspaceId, visitorId, channel, identifier, ipAddress } = opts;

  // Invalidate any prior unused tokens for the same identifier in this workspace
  await supabase
    .from('contact_verifications')
    .update({ used_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('channel', channel)
    .eq('identifier', identifier.toLowerCase().trim())
    .is('used_at', null);

  const issued = issueVerificationToken();

  const { data, error } = await supabase
    .from('contact_verifications')
    .insert({
      workspace_id: workspaceId,
      visitor_id: visitorId,
      channel,
      identifier: identifier.toLowerCase().trim(),
      token_hash: issued.tokenHash,
      nonce: issued.nonce,
      expires_at: issued.expiresAt.toISOString(),
      ip_address: ipAddress || null,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { success: false, error: error?.message || 'verification_insert_failed' };
  }

  return {
    success: true,
    tokenId: data.id,
    rawToken: issued.token,
    expiresAt: issued.expiresAt,
  };
}

export interface ConfirmVerificationOptions {
  workspaceId: string;
  channel: 'email' | 'phone';
  identifier: string;
  token: string;
}

export interface ConfirmVerificationResult {
  success: boolean;
  visitorId?: string;
  error?: string;
}

export async function confirmContactVerification(
  supabase: SupabaseClient,
  opts: ConfirmVerificationOptions
): Promise<ConfirmVerificationResult> {
  const { workspaceId, channel, identifier, token } = opts;
  const normalizedIdentifier = identifier.toLowerCase().trim();
  const candidateHash = hashToken(token);

  const { data: row } = await supabase
    .from('contact_verifications')
    .select('id, visitor_id, token_hash, expires_at, used_at, attempts')
    .eq('workspace_id', workspaceId)
    .eq('channel', channel)
    .eq('identifier', normalizedIdentifier)
    .eq('token_hash', candidateHash)
    .is('used_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) {
    // Increment attempts on the most recent unused row to throttle brute-force
    const { data: latest } = await supabase
      .from('contact_verifications')
      .select('id, attempts')
      .eq('workspace_id', workspaceId)
      .eq('channel', channel)
      .eq('identifier', normalizedIdentifier)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      await supabase
        .from('contact_verifications')
        .update({ attempts: (latest.attempts || 0) + 1 })
        .eq('id', latest.id);
    }
    return { success: false, error: 'invalid_token' };
  }

  // Constant-time check on hash already done by .eq, but enforce expiry & attempts
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { success: false, error: 'expired' };
  }
  if ((row.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    return { success: false, error: 'too_many_attempts' };
  }

  await supabase
    .from('contact_verifications')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id);

  return { success: true, visitorId: row.visitor_id || undefined };
}
