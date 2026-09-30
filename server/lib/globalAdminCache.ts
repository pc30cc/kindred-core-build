/**
 * Users known NOT to be platform admins, until the stored time.
 *
 * Every workspace-scoped operator request asks `isGlobalAdmin` first, and for
 * everyone but the platform owner the answer is always "no" — one round trip
 * per request for a fact that changes a handful of times in a deployment's
 * life. Only the negative answer is kept: remembering a "no" can at worst
 * delay a new grant by NOT_ADMIN_TTL_MS on another node (this node forgets it
 * as soon as the grant route runs), while a remembered "yes" would keep a
 * revoked admin's bypass alive. A positive answer, and an error, are re-read
 * every time.
 *
 * Its own module so the grant routes can invalidate it even where tests
 * replace middleware/adminBypass wholesale.
 */
const NOT_ADMIN_TTL_MS = 30_000;
const NOT_ADMIN_MAX_ENTRIES = 10_000;
const notAdminUntil = new Map<string, number>();

export function isKnownNotGlobalAdmin(userId: string): boolean {
  const until = notAdminUntil.get(userId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  notAdminUntil.delete(userId);
  return false;
}

export function rememberNotGlobalAdmin(userId: string): void {
  if (notAdminUntil.size >= NOT_ADMIN_MAX_ENTRIES) notAdminUntil.clear();
  notAdminUntil.set(userId, Date.now() + NOT_ADMIN_TTL_MS);
}

/** Forget a remembered "not an admin" answer (after a role grant). */
export function invalidateGlobalAdminCache(userId?: string): void {
  if (userId) notAdminUntil.delete(userId);
  else notAdminUntil.clear();
}
