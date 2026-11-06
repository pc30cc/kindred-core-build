/**
 * The one seam between the request-path state that assumes one process and
 * the cluster primary that holds it for the whole container
 * (docs/operations/BACKEND_PROCESSES.md, "The hub").
 *
 * In the single process (BACKEND_PROCESSES unset, a script, a test) nothing
 * here does anything new: every facade takes its `local` branch, which is
 * the function and the module state the code used before, and nothing is
 * ever sent anywhere. In a cluster worker each facade is one allowlisted
 * IPC call to the primary (cluster/protocol.ts), answered within
 * HUB_TIMEOUT_MS, with a fallback chosen per operation when the primary does
 * not answer:
 *
 *   limiters, counters   count in this worker (the local branch)
 *   locks                proceed, as a lock whose wait passed its bound does
 *   claims               a Set in this worker
 *   re-auth              fail closed (the caller decides: 503 / 401)
 *
 * A timeout does not mean the primary did nothing: it may have applied the
 * operation and answered late (it was busy, or this worker's event loop was).
 * So an operation that takes something there is given back when its wait
 * timed out: a lock or a claim is released by its token (sent after the take
 * on the same, ordered channel, so the primary runs it next), a desktop
 * broadcast is removed by its id, and a call or ring ticket, whose `at` only
 * the answer carries, is given back when that late answer arrives
 * (SharedCallOptions.onLate).
 *
 * A fallback is logged at most once a minute per operation. A dead primary
 * ends the container: the worker exits when its IPC channel closes
 * (cluster/worker.ts).
 */
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { MemoryStore } from 'express-rate-limit';
import { usesClusterHub } from './role.js';
import { HUB_TIMEOUT_MS, isKcbMessage, type HubOp, type HubReply, type PrimaryNotice } from './protocol.js';

export interface HubTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

let transport: HubTransport | null = null;
/** Tests: force the cluster branch on (true) or off (false); null = the process's role. */
let forced: boolean | null = null;
let installed = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
/** Requests whose wait timed out, with what to do if their answer still comes (onLate). */
const late = new Map<number, { at: number; onLate: (result: unknown) => void }>();
/** A late answer is not waited for longer than this, nor for more requests than MAX_LATE. */
const LATE_TTL_MS = 10 * 60_000;
const MAX_LATE = 10_000;
const noticeHandlers = new Map<string, Set<(notice: PrimaryNotice) => void>>();

function processTransport(): HubTransport {
  return {
    send: (message) => {
      process.send?.(message as never);
    },
    onMessage: (handler) => {
      process.on('message', handler);
    },
  };
}

/** Whether this process talks to a cluster hub (false in the single process). */
export function hubActive(): boolean {
  return forced ?? usesClusterHub();
}

function ensureTransport(): HubTransport {
  if (!transport) transport = processTransport();
  if (!installed) {
    installed = true;
    transport.onMessage(onMessage);
  }
  return transport;
}

function onMessage(message: unknown): void {
  if (!isKcbMessage(message)) return;
  if (typeof message.re === 'number') {
    const p = pending.get(message.re);
    if (!p) {
      onLateReply(message.re, message as unknown as HubReply);
      return;
    }
    pending.delete(message.re);
    clearTimeout(p.timer);
    const reply = message as unknown as HubReply;
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error || 'hub_error'));
    return;
  }
  if (typeof message.op === 'string') {
    for (const handler of noticeHandlers.get(message.op) ?? []) {
      try {
        handler(message as unknown as PrimaryNotice);
      } catch (err) {
        console.warn(`[cluster] ${message.op} notice handler failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

/** Runs `handler` for every notice of `op` the primary sends (cluster/worker.ts, metricsRelay.ts). */
export function onPrimaryNotice(op: PrimaryNotice['op'], handler: (notice: PrimaryNotice) => void): void {
  let set = noticeHandlers.get(op);
  if (!set) {
    set = new Set();
    noticeHandlers.set(op, set);
  }
  set.add(handler);
  if (hubActive()) ensureTransport();
}

/** The answer to a request whose wait timed out: run its onLate, once. */
function onLateReply(id: number, reply: HubReply): void {
  const l = late.get(id);
  if (!l) return;
  late.delete(id);
  if (!reply.ok) return;
  try {
    l.onLate(reply.result);
  } catch (err) {
    console.warn('[cluster] late answer handler failed:', err instanceof Error ? err.message : err);
  }
}

function rememberLate(id: number, onLate: (result: unknown) => void): void {
  const now = Date.now();
  if (late.size >= MAX_LATE) {
    for (const [k, l] of late) if (now - l.at > LATE_TTL_MS) late.delete(k);
    // Still full: forget the oldest (Map keeps insertion order).
    while (late.size >= MAX_LATE) late.delete(late.keys().next().value as number);
  }
  late.set(id, { at: now, onLate });
}

/**
 * One IPC request to the primary; rejects on its error or after `timeoutMs`.
 * `onLate` runs with the result if the answer arrives after the timeout.
 */
function request(op: HubOp, args: unknown, timeoutMs: number, onLate?: (result: unknown) => void): Promise<unknown> {
  const t = ensureTransport();
  const id = ++seq;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      if (onLate) rememberLate(id, onLate);
      reject(new Error('hub_timeout'));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    try {
      t.send({ kcb: 1, id, op, args });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

const warnedAt = new Map<string, number>();

function warnFallback(op: string, err: unknown): void {
  const now = Date.now();
  if (now - (warnedAt.get(op) ?? 0) < 60_000) return;
  warnedAt.set(op, now);
  console.warn(
    `[cluster] hub ${op} unavailable (${err instanceof Error ? err.message : String(err)}): ` +
      'falling back to this worker (warned at most once a minute)',
  );
}

export interface SharedCallOptions<R> {
  /** What to do when the hub does not answer; the local branch when omitted. */
  fallback?: () => R | Promise<R>;
  timeoutMs?: number;
  /**
   * Runs with the primary's answer when it arrives after the wait timed out
   * (the fallback already ran): the operation was applied there after all,
   * so give back what it took there.
   */
  onLate?: (result: R) => void;
}

/**
 * `local()` in the single process; otherwise `op` in the primary, or the
 * fallback when it does not answer in time.
 */
export async function sharedCall<R>(
  op: HubOp,
  args: unknown,
  local: () => R | Promise<R>,
  opts: SharedCallOptions<R> = {},
): Promise<R> {
  if (!hubActive()) return local();
  try {
    const onLate = opts.onLate as ((result: unknown) => void) | undefined;
    return (await request(op, args, opts.timeoutMs ?? HUB_TIMEOUT_MS, onLate)) as R;
  } catch (err) {
    warnFallback(op, err);
    return (opts.fallback ?? local)();
  }
}

/** A hub operation nobody waits for (a stamp, a give-back, a release). */
export function sharedSend(op: HubOp, args: unknown): void {
  if (!hubActive()) return;
  try {
    ensureTransport().send({ kcb: 1, op, args });
  } catch (err) {
    warnFallback(op, err);
  }
}

/** Fire-and-forget notice to the primary (metrics batches, heartbeats). */
export function sendToPrimary(message: unknown): void {
  if (!hubActive()) return;
  try {
    ensureTransport().send(message);
  } catch {
    /* the channel is closing; the worker exits on disconnect */
  }
}

// ── Locks ──────────────────────────────────────────────────────────────────

let lockSeq = 0;

/**
 * Waits for the container-wide lock on `key` (cluster/keyedLock.ts), at most
 * `maxWaitMs` (plus HUB_TIMEOUT_MS for the IPC), and returns its release,
 * which is safe to call more than once. When the hub does not answer, the
 * caller proceeds, as when the bound passes; the release is still sent, so a
 * grant that arrives late does not hold the key. Only for the cluster branch
 * of a caller: the single process keeps its own in-process lock.
 */
export async function hubLock(key: string, maxWaitMs: number): Promise<() => void> {
  const token = `${process.pid}:${++lockSeq}`;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sharedSend('lock.release', { token });
  };
  if (!hubActive()) return () => undefined;
  try {
    await request('lock.acquire', { key, maxWaitMs, token }, Math.max(0, maxWaitMs) + HUB_TIMEOUT_MS);
  } catch (err) {
    warnFallback('lock.acquire', err);
  }
  return release;
}

// ── Claims ─────────────────────────────────────────────────────────────────

const localClaims = new Set<string>();
let claimSeq = 0;

/**
 * Claims (ns, key) for the whole container (cluster/claims.ts). Returns the
 * release, or null when someone holds it. Without an answer from the hub the
 * claim is taken in this worker's own Set, and the hub's take is released by
 * its token, as hubLock does: it may have landed after all, and would hold
 * the key there for every worker until the claim's maximum age.
 */
export async function hubClaim(ns: string, key: string): Promise<(() => void) | null> {
  const takeLocal = (): (() => void) | null => {
    const id = `${ns}\u0000${key}`;
    if (localClaims.has(id)) return null;
    localClaims.add(id);
    return () => { localClaims.delete(id); };
  };
  if (!hubActive()) return takeLocal();
  const token = `${process.pid}:${++claimSeq}`;
  let viaHub = true;
  const ok = await sharedCall<boolean>('claim.take', { ns, key, token }, () => false, {
    fallback: () => {
      viaHub = false;
      return false;
    },
  });
  if (!viaHub) {
    // Sent after the take on the same channel, so the primary runs it next;
    // the token frees only this take, never another request's.
    sharedSend('claim.release', { ns, key, token });
    return takeLocal();
  }
  if (!ok) return null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sharedSend('claim.release', { ns, key, token });
  };
}

// ── Rate limiters ──────────────────────────────────────────────────────────

/**
 * An express-rate-limit Store whose counts live in the primary
 * (cluster/rateLimitHub.ts: the library's own MemoryStore, one per limiter
 * name). When the hub does not answer it counts in a MemoryStore of this
 * worker and never throws, so a limiter never turns a request into a 500.
 */
export class HubRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;
  private readonly fallbackStore = new MemoryStore();

  constructor(readonly name: string) {
    this.prefix = `hub:${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallbackStore.init(options);
  }

  private args(key: string) {
    return { name: this.name, windowMs: this.windowMs, key };
  }

  private static revive(hit: { totalHits: number; resetTime: string | null } | null): ClientRateLimitInfo | undefined {
    if (!hit) return undefined;
    return { totalHits: hit.totalHits, resetTime: hit.resetTime ? new Date(hit.resetTime) : undefined };
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    let viaHub = true;
    const hit = await sharedCall<{ totalHits: number; resetTime: string | null } | null>(
      'rl.increment',
      this.args(key),
      () => null,
      { fallback: () => { viaHub = false; return null; } },
    );
    if (viaHub && hit) return HubRateLimitStore.revive(hit)!;
    return this.fallbackStore.increment(key);
  }

  async decrement(key: string): Promise<void> {
    sharedSend('rl.decrement', this.args(key));
  }

  async resetKey(key: string): Promise<void> {
    await this.fallbackStore.resetKey(key);
    await sharedCall<void>('rl.resetKey', this.args(key), () => undefined, { fallback: () => undefined });
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    let viaHub = true;
    const hit = await sharedCall<{ totalHits: number; resetTime: string | null } | null>(
      'rl.get',
      this.args(key),
      () => null,
      { fallback: () => { viaHub = false; return null; } },
    );
    return viaHub ? HubRateLimitStore.revive(hit) : this.fallbackStore.get(key);
  }

  shutdown(): void {
    this.fallbackStore.shutdown();
  }
}

/**
 * Spread into a limiter's options: `{}` in the single process, so its
 * options are exactly what they were; in a cluster worker, a store shared by
 * the whole container. Only for the limiters that bound guesses of a secret,
 * or mail, SMS or rings sent to a person; the hot-path abuse backstops stay
 * per process (docs/operations/WIDGET_CONFIG_CACHE.md, "Rate limits").
 */
export function hubLimiterStore(name: string): { store?: Store } {
  return hubActive() ? { store: new HubRateLimitStore(name) } : {};
}

// ── Tests ──────────────────────────────────────────────────────────────────

/**
 * Tests only: talk to `t` as if this were a cluster worker (`force` true), or
 * go back to the process's own role (`t` null).
 */
export function __setHubTransportForTests(t: HubTransport | null, opts: { force?: boolean } = {}): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  late.clear();
  warnedAt.clear();
  localClaims.clear();
  transport = t;
  installed = false;
  forced = t ? (opts.force ?? true) : null;
}
