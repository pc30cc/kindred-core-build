/**
 * How often a visitor may ask the call-centre widget for a call (audit
 * 2026-11-04, calls-4). Each new call request rings every available
 * operator's phone (a high-priority push and a full-screen notification), so
 * `POST /api/call-widget/calls/request` has limits of its own on top of the
 * widget's general per-IP limiter:
 *
 *   - one visitor: at most VISITOR_PER_HOUR new calls an hour, and none within
 *     VISITOR_MIN_GAP_MS of the previous one (a double click, a script);
 *   - one address: at most IP_PER_10_MIN new calls in ten minutes and
 *     IP_PER_HOUR an hour, whatever visitor ids it shows;
 *   - phones: a visitor's new call rings the phones only when that visitor
 *     has not rung them within RING_QUIET_MS. A request, cancel, request
 *     loop still queues the call (the console shows it), but the phones ring
 *     once.
 *
 * A request that resumes the visitor's call in progress is not a new call and
 * is not counted; a request refused later (a limit, a failure) gives its
 * share back. Counted per process, like the colleague-call ring limit
 * (routes/teamCalls.ts): one replica is the common case. When the backend
 * runs several processes in one container (BACKEND_PROCESSES) the route goes
 * through callRequestShared.ts, and the primary counts with these same
 * functions for the whole container.
 */

export const VISITOR_MIN_GAP_MS = 3_000;
export const VISITOR_PER_HOUR = 10;
export const IP_PER_10_MIN = 8;
export const IP_PER_HOUR = 30;
export const RING_QUIET_MS = 60_000;

const HOUR_MS = 60 * 60_000;
const TEN_MIN_MS = 10 * 60_000;
const MAX_KEYS = 20_000;

const visitorRequests = new Map<string, number[]>();
const ipRequests = new Map<string, number[]>();
const visitorRings = new Map<string, number>();

function recent(map: Map<string, number[]>, key: string, since: number): number[] {
  const list = (map.get(key) ?? []).filter((t) => t > since);
  if (list.length) map.set(key, list);
  else map.delete(key);
  return list;
}

function prune(now: number): void {
  if (visitorRequests.size + ipRequests.size + visitorRings.size < MAX_KEYS) return;
  const since = now - HOUR_MS;
  for (const map of [visitorRequests, ipRequests]) {
    for (const [k, times] of map) if (!times.some((t) => t > since)) map.delete(k);
  }
  for (const [k, t] of visitorRings) if (t <= now - RING_QUIET_MS) visitorRings.delete(k);
}

/** A new call request's share of the limits, to keep or give back. */
export interface CallRequestTicket {
  visitorKey: string | null;
  ipKey: string | null;
  at: number;
}

export type CallRequestDecision =
  | { ok: true; ticket: CallRequestTicket }
  | { ok: false; retryAfterSeconds: number };

/**
 * Takes one new call request for this visitor and address, or says how long
 * to wait. `visitorKey` is the signed visitor (workspace-scoped) when there is
 * one; `ipKey` the client address the server trusts (utils/clientIp.ts).
 */
export function takeCallRequest(
  visitorKey: string | null,
  ipKey: string | null,
  now: number = Date.now(),
): CallRequestDecision {
  prune(now);
  let wait = 0;
  if (visitorKey) {
    const hour = recent(visitorRequests, visitorKey, now - HOUR_MS);
    const last = hour.length ? hour[hour.length - 1] : null;
    if (last !== null && now - last < VISITOR_MIN_GAP_MS) wait = Math.max(wait, VISITOR_MIN_GAP_MS - (now - last));
    if (hour.length >= VISITOR_PER_HOUR) wait = Math.max(wait, hour[0] + HOUR_MS - now);
  }
  if (ipKey) {
    const hour = recent(ipRequests, ipKey, now - HOUR_MS);
    const tenMin = hour.filter((t) => t > now - TEN_MIN_MS);
    if (tenMin.length >= IP_PER_10_MIN) wait = Math.max(wait, tenMin[0] + TEN_MIN_MS - now);
    if (hour.length >= IP_PER_HOUR) wait = Math.max(wait, hour[0] + HOUR_MS - now);
  }
  if (wait > 0) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
  if (visitorKey) visitorRequests.set(visitorKey, [...(visitorRequests.get(visitorKey) ?? []), now]);
  if (ipKey) ipRequests.set(ipKey, [...(ipRequests.get(ipKey) ?? []), now]);
  return { ok: true, ticket: { visitorKey, ipKey, at: now } };
}

/** Gives back a request that made no call (refused by a later check, or failed). */
export function giveBackCallRequest(ticket: CallRequestTicket): void {
  for (const [map, key] of [[visitorRequests, ticket.visitorKey], [ipRequests, ticket.ipKey]] as const) {
    if (!key) continue;
    const times = map.get(key);
    if (!times) continue;
    const i = times.lastIndexOf(ticket.at);
    if (i >= 0) times.splice(i, 1);
    if (!times.length) map.delete(key);
  }
}

/**
 * Whether this visitor's new call may ring the operators' phones now; true
 * records the ring. Without a visitor key every call rings (the address
 * limits above still hold).
 */
export function mayRingForVisitor(visitorKey: string | null, now: number = Date.now()): boolean {
  if (!visitorKey) return true;
  const last = visitorRings.get(visitorKey);
  if (last !== undefined && now - last < RING_QUIET_MS) return false;
  visitorRings.set(visitorKey, now);
  return true;
}

/** Tests only: forget every count. */
export function resetCallRequestLimiter(): void {
  visitorRequests.clear();
  ipRequests.clear();
  visitorRings.clear();
}
