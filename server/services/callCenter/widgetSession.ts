/**
 * Call Center widget session token (HMAC). Short-lived. Bound to call_id when issued.
 * Visitors never receive a service token; only this opaque session.
 */
import crypto from 'crypto';
import type { ServerConfig } from '../../config.js';

const TTL_SECONDS = 60 * 30; // 30 min

function secret(config: ServerConfig): string {
  return (
    (config as any).widgetTokenSecret ||
    (config as any).sessionSecret ||
    config.supabaseServiceRoleKey
  );
}

export interface WidgetSessionPayload {
  workspace_id: string;
  public_key: string | null;
  call_id?: string | null;
  visitor_id?: string | null;
  origin?: string | null;
  iat: number;
  exp: number;
}

export function signWidgetSession(
  config: ServerConfig,
  payload: Omit<WidgetSessionPayload, 'iat' | 'exp'>,
  ttlSec = TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: WidgetSessionPayload = { ...payload, iat: now, exp: now + ttlSec };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret(config))
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyWidgetSession(
  config: ServerConfig,
  token: string,
): WidgetSessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto
    .createHmac('sha256', secret(config))
    .update(body)
    .digest('base64url');
  if (
    expect.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WidgetSessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}