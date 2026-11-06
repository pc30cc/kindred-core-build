/**
 * A callee's share of colleague-call rings: at most CALLEE_RINGS_PER_MINUTE a
 * minute, by everyone together (routes/teamCalls.ts, "Rate limits"). Moved
 * out of the route unchanged. In the single process the route's facades
 * count here, as before; in a cluster worker they ask the primary, which
 * holds the share for the whole container (cluster/hub.ts), so a colleague
 * is not rung N times as often with N workers. Without an answer from the
 * primary the worker counts here (and gives the primary's ring back if its
 * answer comes late).
 *
 * Pure but for the facades: no I/O.
 */
import { hubActive, sharedCall, sharedSend } from '../../cluster/client.js';

export const CALLEE_RINGS_PER_MINUTE = 6;
const WINDOW_MS = 60_000;

const calleeRings = new Map<string, number[]>();

/** A ring taken from a callee's share, to keep or give back. */
export interface CalleeRing {
  calleeId: string;
  at: number;
  /** Taken from the primary's share (cluster mode), so given back there. */
  hub?: boolean;
}

/** Takes one of the callee's rings for this minute; null when they have had their share. */
export function takeCalleeRing(calleeId: string, now: number = Date.now()): CalleeRing | null {
  const since = now - WINDOW_MS;
  const recent = (calleeRings.get(calleeId) ?? []).filter((t) => t > since);
  if (recent.length >= CALLEE_RINGS_PER_MINUTE) {
    calleeRings.set(calleeId, recent);
    return null;
  }
  recent.push(now);
  calleeRings.set(calleeId, recent);
  // Keep the map to the callees rung within the window.
  if (calleeRings.size > 5_000) {
    for (const [id, times] of calleeRings) {
      if (!times.some((t) => t > since)) calleeRings.delete(id);
    }
  }
  return { calleeId, at: now };
}

/** Gives back a ring the placement did not use: the callee was never rung. */
export function giveBackCalleeRing(ring: CalleeRing): void {
  const times = calleeRings.get(ring.calleeId);
  if (!times) return;
  const i = times.indexOf(ring.at);
  if (i >= 0) times.splice(i, 1);
  if (!times.length) calleeRings.delete(ring.calleeId);
}

/** takeCalleeRing for the route: the primary's share in a cluster worker. */
export async function takeSharedCalleeRing(calleeId: string): Promise<CalleeRing | null> {
  if (!hubActive()) return takeCalleeRing(calleeId);
  let viaHub = true;
  const ring = await sharedCall<CalleeRing | null>('callee.take', { calleeId }, () => null, {
    fallback: () => {
      viaHub = false;
      return takeCalleeRing(calleeId);
    },
    // The primary took a ring after all, but this worker counted it here
    // instead: give the primary's back, or the callee's share is used twice.
    onLate: (late) => {
      if (late) giveBackSharedCalleeRing({ ...late, hub: true });
    },
  });
  return viaHub && ring ? { ...ring, hub: true } : ring;
}

/** giveBackCalleeRing for the route: back to where the ring was taken. */
export function giveBackSharedCalleeRing(ring: CalleeRing): void {
  if (ring.hub) sharedSend('callee.giveBack', { calleeId: ring.calleeId, at: ring.at });
  else giveBackCalleeRing(ring);
}

/** Tests: forget every callee's rings. */
export function __resetCalleeRings(): void {
  calleeRings.clear();
}
