/**
 * How many privacy jobs a workspace (or a user, for jobs about their own
 * account) may start an hour: 5 exports and 2 deletions. Moved out of
 * routes/privacy.ts unchanged. In the single process takePrivacyJobSlot
 * counts here, as before; in a cluster worker it asks the primary, which
 * holds these counters for the whole container (cluster/hub.ts), and counts
 * here when the primary does not answer.
 *
 * Pure but for the facade: no I/O.
 */
import { sharedCall } from '../../cluster/client.js';

type Window = { count: number; windowStart: number };

const rlExport = new Map<string, Window>();
const rlDelete = new Map<string, Window>();
const HOUR = 60 * 60_000;
const MAX_KEYS = 50_000;
let lastSweepAt = 0;

export const PRIVACY_EXPORTS_PER_HOUR = 5;
export const PRIVACY_DELETES_PER_HOUR = 2;

function rateLimit(map: Map<string, Window>, key: string, max: number, now: number = Date.now()): boolean {
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > HOUR) {
    // A window past its hour counts as new anyway: dropping those changes no
    // answer. At most one sweep a second, so a flood at the cap stays linear.
    if (map.size >= MAX_KEYS && now - lastSweepAt >= 1_000) {
      lastSweepAt = now;
      for (const [k, v] of map) if (now - v.windowStart > HOUR) map.delete(k);
    }
    map.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

/** One job of `action` for `key` this hour: true when it is within the limit (and counts it). */
export function takeLocalPrivacyJobSlot(action: 'export' | 'delete', key: string, now: number = Date.now()): boolean {
  return action === 'export'
    ? rateLimit(rlExport, key, PRIVACY_EXPORTS_PER_HOUR, now)
    : rateLimit(rlDelete, key, PRIVACY_DELETES_PER_HOUR, now);
}

export function takePrivacyJobSlot(action: 'export' | 'delete', key: string): Promise<boolean> {
  return sharedCall('privacy.slot', { action, key }, () => takeLocalPrivacyJobSlot(action, key));
}

/** Tests only. */
export function __resetPrivacyJobSlots(): void {
  rlExport.clear();
  rlDelete.clear();
}
