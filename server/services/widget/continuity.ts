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
import type { Request, Response } from 'express';
import { isSecureRequest } from './visitorIdentity.js';

const CONTINUITY_TOKEN_BYTES = 48;
const CONTINUITY_TTL_DAYS = 90;
const CONTINUITY_COOKIE_NAME = 'dvcid';
const CONTINUITY_TTL_SECONDS = CONTINUITY_TTL_DAYS * 24 * 60 * 60;

interface SignedContactContinuityPayload {
  v: 1;
  w: string;
  c: string;
  iat: number;
  exp: number;
}

function getContinuitySecret(): string {
  const key = process.env.WIDGET_CONTINUITY_SECRET
    || process.env.WIDGET_SIGNING_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';
  if (!key) throw new Error('Missing WIDGET_CONTINUITY_SECRET');
  return key;
}

function hashContinuityToken(token: string): string {
  // Use HMAC for keyed hash so a DB leak alone doesn't allow precomputed attacks
  const key = getContinuitySecret();
  return crypto.createHmac('sha256', 'continuity:' + key).update(token).digest('hex');
}

function signContactPayload(payloadB64: string): string {
  return crypto
    .createHmac('sha256', 'contact-continuity:' + getContinuitySecret())
    .update(payloadB64)
    .digest('base64url');
}

export function createSignedContactContinuityToken(workspaceId: string, contactId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SignedContactContinuityPayload = {
    v: 1,
    w: workspaceId,
    c: contactId,
    iat: now,
    exp: now + CONTINUITY_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `cc1.${body}.${signContactPayload(body)}`;
}

function decodeSignedContactContinuityToken(token: string, workspaceId: string): SignedContactContinuityPayload | null {
  if (!token.startsWith('cc1.')) return null;
  const [, body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = signContactPayload(body);
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedContactContinuityPayload;
    if (payload.v !== 1 || payload.w !== workspaceId || !payload.c || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
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
  try {
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
  } catch {
    return null;
  }
}

export function setContinuityCookie(res: Response, token: string, req?: Request | null): void {
  const secure = isSecureRequest(req ?? null);
  const attrs = [
    `${CONTINUITY_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/api',
    'HttpOnly',
    `Max-Age=${CONTINUITY_TTL_SECONDS}`,
    `SameSite=${secure ? 'None' : 'Lax'}`,
  ];
  if (secure) {
    attrs.push('Secure');
    attrs.push('Partitioned');
  }
  res.append('Set-Cookie', attrs.join('; '));
}

export function readContinuityCookie(req: Request): string | null {
  const raw = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[CONTINUITY_COOKIE_NAME];
  return typeof raw === 'string' && raw.length > 20 ? raw : null;
}

/** Explicit account changes must also discard the contact restore cookie. */
export function clearContinuityCookie(res: Response, req?: Request | null): void {
  const secure = isSecureRequest(req ?? null);
  res.append('Set-Cookie', `${CONTINUITY_COOKIE_NAME}=; Path=/api; HttpOnly; Max-Age=0; SameSite=${secure ? 'None; Secure; Partitioned' : 'Lax'}`);
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
  const signed = decodeSignedContactContinuityToken(token, workspaceId);
  if (signed?.c) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('id', signed.c)
      .maybeSingle();
    return contact?.id ? { valid: true, contactId: contact.id } : { valid: false, error: 'contact_not_found' };
  }

  let tokenHash: string;
  try {
    tokenHash = hashContinuityToken(token);
  } catch {
    return { valid: false, error: 'server_secret_missing' };
  }

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
