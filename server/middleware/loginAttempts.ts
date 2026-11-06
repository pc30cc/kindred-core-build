/**
 * The login brute-force tracker: failures per (client address bucket, email)
 * over BRUTE_FORCE_WINDOW, with a progressive lock after MAX_FAILURES.
 * Moved out of middleware/security.ts unchanged, keyed by the tracker key
 * instead of the request, so the cluster primary can hold one tracker for the
 * whole container (cluster/hub.ts). checkBruteForce and recordLoginAttempt
 * (middleware/security.ts) are the callers; in the single process they call
 * these functions directly, on this module's map, as before.
 *
 * Pure: no imports, one unref'd GC timer.
 */

interface Tracker {
  count: number;
  firstAttempt: number;
  lockedUntil?: number;
}

export interface BruteForceResult {
  blocked: boolean;
  retryAfter?: number;
  failCount?: number;
}

const loginAttemptTracker = new Map<string, Tracker>();
export const BRUTE_FORCE_WINDOW = 15 * 60_000; // 15 min
const MAX_FAILURES = 5;
const LOCK_DURATION_BASE = 5 * 60_000; // 5 min base, doubles each lock

/** Whether `key` may try again. Writes the lock when it starts (lockedUntil), so it is one operation. */
export function checkLoginKey(key: string, now: number = Date.now()): BruteForceResult {
  const tracker = loginAttemptTracker.get(key);
  if (tracker) {
    // Check if locked
    if (tracker.lockedUntil && tracker.lockedUntil > now) {
      const retryAfter = Math.ceil((tracker.lockedUntil - now) / 1000);
      return { blocked: true, retryAfter, failCount: tracker.count };
    }
    // Reset if window expired
    if (now - tracker.firstAttempt > BRUTE_FORCE_WINDOW) {
      loginAttemptTracker.delete(key);
      return { blocked: false };
    }
    if (tracker.count >= MAX_FAILURES) {
      // Progressive lockout: 5min, 10min, 20min...
      const lockMultiplier = Math.pow(2, Math.floor(tracker.count / MAX_FAILURES) - 1);
      const lockDuration = LOCK_DURATION_BASE * lockMultiplier;
      tracker.lockedUntil = now + lockDuration;
      return { blocked: true, retryAfter: Math.ceil(lockDuration / 1000), failCount: tracker.count };
    }
  }

  return { blocked: false };
}

export function recordLoginKey(key: string, success: boolean, now: number = Date.now()): void {
  if (success) {
    loginAttemptTracker.delete(key);
    return;
  }

  const tracker = loginAttemptTracker.get(key);
  if (tracker && now - tracker.firstAttempt < BRUTE_FORCE_WINDOW) {
    tracker.count++;
  } else {
    loginAttemptTracker.set(key, { count: 1, firstAttempt: now });
  }
}

/** Drops trackers past twice the window (every 5 minutes, below). */
export function pruneLoginAttempts(now: number = Date.now()): void {
  for (const [key, val] of loginAttemptTracker) {
    if (now - val.firstAttempt > BRUTE_FORCE_WINDOW * 2) {
      loginAttemptTracker.delete(key);
    }
  }
}

/** Tests only. */
export function __resetLoginAttempts(): void {
  loginAttemptTracker.clear();
}

export function loginAttemptTrackerSize(): number {
  return loginAttemptTracker.size;
}

setInterval(() => pruneLoginAttempts(), 5 * 60_000).unref?.();
