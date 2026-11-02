/**
 * THE MOBILE APP AS A PLAN FEATURE — the server's half
 * (docs/operations/MOBILE_APP_PLAN.md, "Server").
 *
 * The Super Admin turns the iPhone and Android apps off per plan with the
 * registry key `mobile_app` (on by default). The apps lock themselves from
 * the snapshot they already read; the server's part is that a locked app is
 * never woken for nothing: for a workspace whose effective `mobile_app` is
 * false, its members' phones get no alert push (push/recipients.ts), no
 * colleague ring (push/teamCallRing.ts: VoIP and FCM) and no call-centre ring
 * (push/callRing.ts). The API itself is not refused: the web panel uses it.
 * A call-centre ring's stop goes to a locked workspace's phones only while a
 * ring let through just before the plan changed may still be ringing
 * (mobileAppRingMayBeLive); a colleague ring's stop goes only to the phones
 * that were rung, which is none.
 *
 * The answer is the one GET /api/plans/workspace/:id/effective gives
 * (`features.mobile_app.value`): the plan in force (planSelection.ts, read by
 * the same reader as the route's getWorkspacePlanInfoDetailed, over the same
 * service client), resolved by resolveEffectiveEntitlements — plan ??
 * registry default, a feature takes no workspace override — and on for a
 * self-host install without billing, which is shown everything.
 *
 * It FAILS OPEN, unlike the plan gates: a plan that cannot be read, or any
 * error at all, answers "allowed" and the push goes out as before. Only an
 * explicit false locks. A missed notification is the expensive failure; a
 * push to a phone whose app shows a lock is not.
 *
 * Cached per workspace for a minute (pushes come in bursts, and each one
 * would otherwise read the subscription and the plan), dropped at once when
 * this process hears the workspace's entitlements changed (lib/cacheBus.ts:
 * a plan assigned, an override, a plan edited). A failed read is not cached,
 * so the next push asks again. Concurrent asks for one workspace share one
 * read.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { workspacePlanInfoFrom } from '../../middleware/featureGating.js';
import { resolveEffectiveEntitlements } from '../billing/effectiveEntitlements.js';
import { onInvalidate } from '../../lib/cacheBus.js';

/** The registry key (server/services/billing/capabilityRegistry.ts). */
export const MOBILE_APP_FEATURE = 'mobile_app';

const TTL_MS = 60_000;
/** Bound: swept on write, like the entitlement cache. */
const MAX_ENTRIES = 5000;

const cache = new Map<string, { allowed: boolean; expiresAt: number }>();
const inFlight = new Map<string, Promise<boolean>>();
/**
 * Bumped by every invalidation: a read that started before one does not
 * write its (possibly older) answer into the cache after it.
 */
let generation = 0;

/**
 * When this process last answered "allowed" for a workspace (ms), oldest
 * first. Not dropped by an invalidation: a plan that has just turned the app
 * off is exactly when a ring let through a moment before still needs its
 * stop (mobileAppRingMayBeLive).
 */
const lastAllowedAt = new Map<string, number>();
/** A ring's life is the sender's to say; this covers a phone's clock being a little behind ours. */
const RING_STOP_GRACE_MS = 15_000;

/**
 * Whether the phones of [workspaceId]'s members may be pushed to and rung:
 * false only when the workspace's effective `mobile_app` is explicitly false.
 * Never throws.
 */
export async function mobileAppAllowed(config: ServerConfig, workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return true;
  if (config.selfHostBillingUnlimited === true) return true;
  const allowed = await planAllows(config, workspaceId);
  if (allowed) noteAllowed(workspaceId);
  return allowed;
}

/**
 * Whether a stop for a ring of [workspaceId] can find anything to stop on its
 * members' phones: always while the plan has the app (or cannot be read);
 * with the app off, only when this process let a push or a ring of that
 * workspace through within the last [ringSeconds] (and a little more). So a
 * ring sent just before the Super Admin turned the app off is still ended,
 * and a locked workspace's calls do not wake every phone of its operators
 * with a stop for a ring none of them got. Never throws.
 */
export async function mobileAppRingMayBeLive(
  config: ServerConfig,
  workspaceId: string | null | undefined,
  ringSeconds: number,
): Promise<boolean> {
  if (await mobileAppAllowed(config, workspaceId)) return true;
  const at = workspaceId ? lastAllowedAt.get(workspaceId) : undefined;
  return at !== undefined && Date.now() - at <= ringSeconds * 1000 + RING_STOP_GRACE_MS;
}

function noteAllowed(workspaceId: string): void {
  // Re-inserted, so the map stays in the order of the last answer.
  lastAllowedAt.delete(workspaceId);
  lastAllowedAt.set(workspaceId, Date.now());
  for (const key of lastAllowedAt.keys()) {
    if (lastAllowedAt.size <= MAX_ENTRIES) break;
    lastAllowedAt.delete(key);
  }
}

async function planAllows(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const hit = cache.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.allowed;
  const pending = inFlight.get(workspaceId);
  if (pending) return pending;
  const read = readAllowed(config, workspaceId);
  inFlight.set(workspaceId, read);
  void read.then(() => {
    if (inFlight.get(workspaceId) === read) inFlight.delete(workspaceId);
  });
  return read;
}

async function readAllowed(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const startedAt = generation;
  try {
    const info = await workspacePlanInfoFrom(getServiceClient(config), workspaceId);
    const flag = resolveEffectiveEntitlements(info, [], []).features[MOBILE_APP_FEATURE];
    const allowed = flag?.value !== false;
    if (startedAt === generation) remember(workspaceId, allowed);
    return allowed;
  } catch (err) {
    // Unreadable (the plan_status_unavailable of the snapshot), or anything
    // else: not a lock.
    console.warn('[mobile-app] plan unreadable; pushing as before:', err instanceof Error ? err.message : String(err));
    return true;
  }
}

function remember(workspaceId: string, allowed: boolean): void {
  cache.set(workspaceId, { allowed, expiresAt: Date.now() + TTL_MS });
  if (cache.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  let excess = cache.size - MAX_ENTRIES;
  for (const key of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(key);
  }
}

/** Forget one workspace's answer, or every one. */
export function clearMobileAppGateCache(workspaceId?: string | null): void {
  generation += 1;
  if (workspaceId) {
    cache.delete(workspaceId);
    inFlight.delete(workspaceId);
  } else {
    cache.clear();
    inFlight.clear();
  }
}

/** Tests only: everything this process remembers, the last "allowed" answers included. */
export function __resetMobileAppGateForTests(): void {
  clearMobileAppGateCache();
  lastAllowedAt.clear();
}

// A plan, an override or a subscription changed, in this process or another.
onInvalidate('entitlements', (workspaceId) => clearMobileAppGateCache(workspaceId));
