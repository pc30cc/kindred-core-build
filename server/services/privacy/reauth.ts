/**
 * Re-auth tokens for privacy actions.
 *
 * Issued by POST /api/privacy/reauth after the caller proves a fresh
 * password (or for OAuth-only users, a fresh Supabase session). The token
 * is a random 32-byte value; only its sha256 hash is kept in memory with
 * a short TTL. Required for delete jobs and user self-export.
 *
 * In a cluster worker (docs/operations/BACKEND_PROCESSES.md) the store is the
 * primary's (issueReauth / consumeReauth below): the worker makes the token
 * and its hash and sends only the hash, so a token issued on one worker is
 * taken once on any other. Without an answer from the primary both fail
 * closed: no token is issued (the route answers 503) and none is accepted
 * (401 REAUTH_REQUIRED).
 */

import * as crypto from 'crypto';
import { hubActive, sharedCall } from '../../cluster/client.js';

interface Entry {
  hash: string;
  userId: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 100_000;
const store = new Map<string, Entry>();
let lastSweepAt = 0;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Keeps a token's hash until `expiresAt` (the hub's store, and the single process's). */
export function storeReauthHash(h: string, userId: string, expiresAt: number): boolean {
  if (store.size >= MAX_ENTRIES) {
    // At most one sweep a second, so a flood at the cap stays linear.
    const now = Date.now();
    if (now - lastSweepAt >= 1_000) {
      lastSweepAt = now;
      for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
    }
    if (store.size >= MAX_ENTRIES) return false;
  }
  store.set(h, { hash: h, userId, expiresAt });
  return true;
}

/** Takes a token's hash once: true when it was there, the user's, and fresh. */
export function takeReauthHash(h: string, userId: string, now: number = Date.now()): boolean {
  const entry = store.get(h);
  if (!entry) return false;
  if (entry.userId !== userId) return false;
  if (entry.expiresAt < now) {
    store.delete(h);
    return false;
  }
  // single-use semantics for the highest-impact actions
  store.delete(h);
  return true;
}

export function issueReauthToken(userId: string): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  store.set(hash(token), { hash: hash(token), userId, expiresAt });
  return { token, expiresAt };
}

export function consumeReauthToken(userId: string, token: string | undefined | null): boolean {
  if (!token) return false;
  return takeReauthHash(hash(token), userId);
}

/**
 * issueReauthToken for the route: the same in the single process; in a
 * cluster worker the hash goes to the primary, and this throws when it is not
 * stored there (the caller answers 503).
 */
export async function issueReauth(userId: string): Promise<{ token: string; expiresAt: number }> {
  if (!hubActive()) return issueReauthToken(userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  const stored = await sharedCall<boolean>('reauth.store', { hash: hash(token), userId, expiresAt }, () => false);
  if (!stored) throw new Error('reauth_store_unavailable');
  return { token, expiresAt };
}

/** consumeReauthToken for the route; false (fail closed) when the primary does not answer. */
export async function consumeReauth(userId: string, token: string | undefined | null): Promise<boolean> {
  if (!hubActive()) return consumeReauthToken(userId, token);
  if (!token) return false;
  return sharedCall<boolean>('reauth.take', { hash: hash(token), userId }, () => false);
}

// periodic GC
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
}, 60_000).unref?.();
