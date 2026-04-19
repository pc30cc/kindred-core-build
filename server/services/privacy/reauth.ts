/**
 * Re-auth tokens for privacy actions.
 *
 * Issued by POST /api/privacy/reauth after the caller proves a fresh
 * password (or for OAuth-only users, a fresh Supabase session). The token
 * is a random 32-byte value; only its sha256 hash is kept in memory with
 * a short TTL. Required for delete jobs and user self-export.
 */

import * as crypto from 'crypto';

interface Entry {
  hash: string;
  userId: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60_000;
const store = new Map<string, Entry>();

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function issueReauthToken(userId: string): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  store.set(hash(token), { hash: hash(token), userId, expiresAt });
  return { token, expiresAt };
}

export function consumeReauthToken(userId: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const h = hash(token);
  const entry = store.get(h);
  if (!entry) return false;
  if (entry.userId !== userId) return false;
  if (entry.expiresAt < Date.now()) {
    store.delete(h);
    return false;
  }
  // single-use semantics for the highest-impact actions
  store.delete(h);
  return true;
}

// periodic GC
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
}, 60_000).unref?.();