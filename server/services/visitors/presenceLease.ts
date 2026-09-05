/**
 * Visitor presence LEASE — per-session proof that realtime owns liveness.
 *
 * The workspace-level presence mode says "realtime is authoritative for this
 * workspace". It does NOT say anything about one particular visitor: a tab on
 * a corporate network that cannot open a WebSocket is in database mode while
 * every other tab of the same workspace is realtime. Deciding writes from the
 * workspace mode alone would make that visitor invisible.
 *
 * So ownership is per session and proven cryptographically:
 *
 *   • `/api/realtime/visitor-presence` mints a short-lived HMAC lease AFTER it
 *     has verified the session against the HttpOnly visitor cookie, and the
 *     widget only keeps it while its presence subscription is actually open.
 *   • the heartbeat presents the lease. A valid lease ⇒ realtime owns this
 *     session ⇒ zero liveness writes. No lease ⇒ the database path runs, so a
 *     visitor whose socket failed is still tracked.
 *
 * The lease is not an authorization token: it grants nothing. It only lets the
 * server skip work, and forging one can at worst make a visitor's own liveness
 * row go stale — which the handoff window already treats as `unknown`, never
 * as a false "offline" for anyone else.
 */
import crypto from 'node:crypto';

/** Lease lifetime. Short enough that a dead socket stops suppressing writes. */
export const VISITOR_PRESENCE_LEASE_TTL_SECONDS = 180;

const PREFIX = 'vpl1';

function secret(): Buffer {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.WIDGET_SIGNING_SECRET || '';
  return crypto.createHash('sha256').update('visitor-presence-lease:' + base).digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueVisitorPresenceLease(
  workspaceId: string,
  sessionId: string,
  ttlSeconds: number = VISITOR_PRESENCE_LEASE_TTL_SECONDS,
  now: number = Date.now(),
): { lease: string; expires_at: number } {
  const exp = Math.floor(now / 1000) + Math.max(30, ttlSeconds);
  const payload = `${PREFIX}.${workspaceId}.${sessionId}.${exp}`;
  return { lease: `${payload}.${sign(payload)}`, expires_at: exp * 1000 };
}

/** Constant-time verification bound to BOTH the workspace and the session. */
export function verifyVisitorPresenceLease(
  lease: string | undefined | null,
  workspaceId: string,
  sessionId: string,
  now: number = Date.now(),
): boolean {
  if (!lease || typeof lease !== 'string') return false;
  const parts = lease.split('.');
  if (parts.length !== 5) return false;
  const [prefix, ws, sid, expRaw, mac] = parts;
  if (prefix !== PREFIX || ws !== workspaceId || sid !== sessionId) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 <= now) return false;
  const expected = sign(`${prefix}.${ws}.${sid}.${expRaw}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
