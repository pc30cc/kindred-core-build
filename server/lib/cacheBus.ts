/**
 * Cross-node cache invalidation — one PostgreSQL channel, every process.
 *
 * Several per-process caches sit on the visitor hot path (the widget config
 * snapshot, origin rules, entitlements, lock state, the platform public
 * config). Each writer already drops its own process's copy; with more than
 * one backend process (replicas, regions) the others kept serving the old
 * value until their TTL ran out. This bus carries the same invalidation to
 * every process:
 *
 *   publishCacheInvalidation(scopes)
 *     1. runs this process's handlers at once (invalidateLocal), then
 *     2. `pg_notify('webyar_cache', …)` through the pool, so every other
 *        process listening on the same database runs its handlers too.
 *
 * Why PostgreSQL and not Redis: in postgres-only mode the database is the one
 * component every node of a brand already shares, in every region, and it is
 * always there. A NOTIFY sent after a commit is delivered after that write is
 * visible. Redis is opt-in, regional, and our client has no subscriber mode.
 * RESPOK has its own database, so its channel is naturally separate.
 *
 * Scopes are `kind` or `kind:key`:
 *   widget:<workspace>        the workspace's chat widget snapshot + quota
 *                             cache, and its call widget bootstrap
 *   widget                    every workspace's widget snapshots
 *   origin:<workspace>        the workspace's origin rules (+ its host answers)
 *   host:<domain>             the cached host → workspace answer of a domain
 *   entitlements:<workspace>  entitlement + lock-state caches of a workspace
 *   user:<user>               widget snapshots whose team contains that user
 *   platform                  platform-wide singletons (settings, branding…)
 *   ipblock                   the IP blocklist
 *   all                       everything, every handler
 *
 * Rules:
 *   - Handlers are LOCAL and must never publish (no loops). A handler that
 *     calls invalidateLocal() again is queued, not recursed into, and a scope
 *     already run in this pass is not run twice.
 *   - Only the API process listens (server/index.ts), on ONE dedicated
 *     connection (not a pool slot). It must reach the PRIMARY directly: a
 *     standby or a transaction-mode pooler delivers no notifications.
 *   - Every (re)connect RESYNCS everything ('all' with `resync: true`):
 *     notifications sent while this process was not listening are lost, and
 *     a cache entry built before the LISTEN may have missed one. The same
 *     resync runs when the heartbeat comes back after a gap. Nothing in
 *     particular changed, so a cache that can serve stale marks its entries
 *     expired (the next request is answered from the old copy and reloads
 *     it) instead of dropping them: a dropped LISTEN connection must not make
 *     every active workspace rebuild in the foreground at once. Caches
 *     without a stale path drop their entries, as for any 'all'.
 *   - The bus only makes changes visible SOONER. No cache relies on it for
 *     correctness: each keeps its own TTL whether or not the bus works.
 *     isCrossNodeInvalidationActive() — true only while this process's own
 *     heartbeat NOTIFY (every 30 s, through the publish path) comes back —
 *     is reported, not trusted.
 *
 * Messages carry only scope strings and the sender's instance id; a process
 * ignores its own. A malformed or foreign message is dropped. Anyone able to
 * NOTIFY on this database can at most make caches reload.
 */
import pg from 'pg';
import { dataDriver, directPool } from '../db/index.js';
import { databaseSettings } from '../db/pool.js';

export type CacheScope = string;
export interface CacheInvalidationInfo {
  /**
   * True for the bus's own resync after a (re)connect or a heartbeat gap
   * (always with key null): notifications may have been missed, nothing
   * known changed. A cache that can serve stale may expire instead of drop.
   */
  resync: boolean;
}

/** `key` is the part after the first ':' — null for a bare kind and for 'all'. */
export type CacheInvalidationHandler = (key: string | null, info: CacheInvalidationInfo) => void;

const CHANGED: CacheInvalidationInfo = Object.freeze({ resync: false });
const RESYNC: CacheInvalidationInfo = Object.freeze({ resync: true });

export const CACHE_BUS_CHANNEL = 'webyar_cache';

/** Same shape as observability/tickerLease.ts's TICKER_INSTANCE_ID. */
export const CACHE_BUS_INSTANCE_ID = `${process.env.HOSTNAME || 'node'}:${process.pid}:${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SCOPE_RE = /^[a-z][a-z0-9_]{0,31}(?::[^\s]{1,320})?$/;
/** pg_notify payloads must stay under 8000 bytes; keep a margin. */
const MAX_PAYLOAD_BYTES = 7000;
const MAX_SCOPES_PER_MESSAGE = 200;

const handlers = new Map<string, Set<CacheInvalidationHandler>>();

function parseScope(scope: string): { kind: string; key: string | null } {
  const i = scope.indexOf(':');
  return i < 0 ? { kind: scope, key: null } : { kind: scope.slice(0, i), key: scope.slice(i + 1) };
}

export function isValidCacheScope(scope: unknown): scope is CacheScope {
  return typeof scope === 'string' && SCOPE_RE.test(scope);
}

/**
 * Register a LOCAL handler for one scope kind ('widget', 'origin', …).
 * 'all' calls it with key null. Returns an unregister function.
 */
export function onInvalidate(kind: string, handler: CacheInvalidationHandler): () => void {
  let set = handlers.get(kind);
  if (!set) {
    set = new Set();
    handlers.set(kind, set);
  }
  set.add(handler);
  return () => {
    handlers.get(kind)?.delete(handler);
  };
}

function runHandler(handler: CacheInvalidationHandler, key: string | null, scope: string, info: CacheInvalidationInfo): void {
  try {
    handler(key, info);
  } catch (err) {
    console.warn(`[cache-bus] handler for "${scope}" failed:`, err instanceof Error ? err.message : err);
  }
}

let draining: string[] | null = null;

/**
 * Run this process's handlers for `scopes`, synchronously. Never publishes.
 * Re-entrant calls (a handler clearing another cache that invalidates in
 * turn) are appended to the running pass instead of recursing (as plain
 * invalidations: a resync inside a pass becomes a full 'all').
 * `opts.resync` is the bus's own resync (see the header); it applies to
 * 'all' only.
 */
export function invalidateLocal(scopes: readonly CacheScope[], opts: { resync?: boolean } = {}): void {
  const valid = scopes.filter(isValidCacheScope);
  if (draining) {
    draining.push(...valid);
    return;
  }
  const allInfo = opts.resync ? RESYNC : CHANGED;
  const queue = [...valid];
  draining = queue;
  const done = new Set<string>();
  try {
    while (queue.length) {
      const scope = queue.shift()!;
      if (done.has(scope) || done.has('all')) continue;
      done.add(scope);
      if (scope === 'all') {
        for (const [kind, set] of handlers) {
          for (const handler of [...set]) runHandler(handler, null, `all→${kind}`, allInfo);
        }
        continue;
      }
      const { kind, key } = parseScope(scope);
      const set = handlers.get(kind);
      if (!set) continue;
      for (const handler of [...set]) runHandler(handler, key, scope, CHANGED);
    }
  } finally {
    draining = null;
  }
}

// ── Publishing ─────────────────────────────────────────────────────────────

let pending: Set<string> | null = null;

function chunk(scopes: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 64;
  for (const s of scopes) {
    if (current.length && (size + s.length + 3 > MAX_PAYLOAD_BYTES || current.length >= MAX_SCOPES_PER_MESSAGE)) {
      out.push(current);
      current = [];
      size = 64;
    }
    current.push(s);
    size += s.length + 3;
  }
  if (current.length) out.push(current);
  return out;
}

function flushPending(): void {
  const scopes = pending ? [...pending] : [];
  pending = null;
  if (!scopes.length) return;
  const toSend = scopes.includes('all') ? ['all'] : scopes;
  let pool: ReturnType<typeof directPool>;
  try {
    pool = directPool();
  } catch (err) {
    console.warn('[cache-bus] publish skipped (no database pool):', err instanceof Error ? err.message : err);
    return;
  }
  for (const part of chunk(toSend)) {
    const payload = JSON.stringify({ o: CACHE_BUS_INSTANCE_ID, s: part });
    pool.query('SELECT pg_catalog.pg_notify($1, $2)', [CACHE_BUS_CHANNEL, payload]).catch((err: unknown) => {
      // Other nodes then catch up through their TTL; never fail the write.
      console.warn('[cache-bus] publish failed:', err instanceof Error ? err.message : err);
    });
  }
}

/**
 * Invalidate `scopes` here at once and on every other process. Call it after
 * a write has succeeded. Fire-and-forget: it never throws and never waits on
 * the database. Scopes published in the same tick share one NOTIFY.
 */
export function publishCacheInvalidation(scopes: readonly CacheScope[]): void {
  const valid = scopes.filter(isValidCacheScope);
  if (!valid.length) return;
  invalidateLocal(valid);
  if (dataDriver() !== 'postgres') return;
  if (!pending) {
    pending = new Set();
    setImmediate(flushPending);
  }
  for (const s of valid) pending.add(s);
}

// ── Listening ──────────────────────────────────────────────────────────────

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Heartbeat: a self-NOTIFY through the publish path, and a liveness query. */
const HEARTBEAT_EVERY_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 10_000;
/** No own heartbeat back for this long (3 missed) = notifications do not arrive. */
const HEARTBEAT_STALE_MS = 95_000;

interface ListenerState {
  client: pg.Client | null;
  stopped: boolean;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  connecting: boolean;
  /** When this process last received its own heartbeat. 0 = never. */
  lastHeartbeatAt: number;
  /** Whether the bus counted as active at the last check (for transition logs). */
  wasActive: boolean;
  heartbeatSeq: number;
  settings: { connectionString: string; ssl: pg.ClientConfig['ssl']; applicationName: string } | null;
  /** Test hook: how many heartbeats to swallow (simulates a non-delivering URL). */
  dropHeartbeats: boolean;
}

let listener: ListenerState | null = null;

function heartbeatFresh(state: ListenerState, now = Date.now()): boolean {
  return !!state.client && state.lastHeartbeatAt > 0 && now - state.lastHeartbeatAt < HEARTBEAT_STALE_MS;
}

/**
 * True while invalidations from other processes provably reach this one: the
 * LISTEN connection is up AND this process's own heartbeat (a NOTIFY sent
 * through the same pool every publish uses) came back within the last 95 s.
 * A connection that accepts LISTEN but never delivers — a transaction-mode
 * pooler, a read replica — therefore never counts as active.
 *
 * Informational: no cache relies on it for correctness (their TTLs bound
 * staleness on their own); it is logged on every transition.
 */
export function isCrossNodeInvalidationActive(): boolean {
  return !!listener && heartbeatFresh(listener);
}

function noteHeartbeat(state: ListenerState): void {
  if (state.dropHeartbeats) return;
  const wasFresh = heartbeatFresh(state);
  const hadOne = state.lastHeartbeatAt > 0;
  state.lastHeartbeatAt = Date.now();
  if (!wasFresh) {
    console.log('[cache-bus] cross-node invalidation active');
    state.wasActive = true;
    // Notifications sent while they did not arrive are lost.
    if (hadOne) invalidateLocal(['all'], { resync: true });
  }
}

function handleNotification(message: { channel: string; payload?: string }): void {
  if (message.channel !== CACHE_BUS_CHANNEL || !message.payload) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.payload);
  } catch {
    return;
  }
  const body = parsed as { o?: unknown; s?: unknown; h?: unknown } | null;
  if (!body || typeof body !== 'object') return;
  if (body.o === CACHE_BUS_INSTANCE_ID) {
    if (body.h !== undefined && listener) noteHeartbeat(listener);
    return;
  }
  if (!Array.isArray(body.s)) return;
  const scopes = body.s.filter(isValidCacheScope).slice(0, MAX_SCOPES_PER_MESSAGE);
  if (scopes.length) invalidateLocal(scopes);
}

function sendHeartbeat(state: ListenerState): void {
  if (dataDriver() !== 'postgres') return;
  state.heartbeatSeq += 1;
  const payload = JSON.stringify({ o: CACHE_BUS_INSTANCE_ID, h: state.heartbeatSeq });
  try {
    directPool()
      .query('SELECT pg_catalog.pg_notify($1, $2)', [CACHE_BUS_CHANNEL, payload])
      .catch((err: unknown) => {
        console.warn('[cache-bus] heartbeat failed:', err instanceof Error ? err.message : err);
      });
  } catch (err) {
    console.warn('[cache-bus] heartbeat failed:', err instanceof Error ? err.message : err);
  }
}

function checkTransition(state: ListenerState): void {
  const active = heartbeatFresh(state);
  if (state.wasActive && !active) {
    console.warn(
      '[cache-bus] cross-node invalidation INACTIVE: this process\'s own notifications do not come back ' +
        '(listener down, or DATABASE_URL is a transaction pooler / replica). Caches fall back to their TTLs.',
    );
  }
  state.wasActive = active;
}

function scheduleReconnect(state: ListenerState): void {
  if (state.stopped || state.reconnectTimer) return;
  const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(state.attempt, 5));
  state.attempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect(state);
  }, wait);
  state.reconnectTimer.unref?.();
}

function dropClient(state: ListenerState, client: pg.Client): void {
  if (state.client !== client) return;
  state.client = null;
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  checkTransition(state);
  client.removeAllListeners('notification');
  client.end().catch(() => undefined);
}

async function connect(state: ListenerState): Promise<void> {
  if (state.stopped || state.connecting || state.client || !state.settings) return;
  state.connecting = true;
  const client = new pg.Client({
    connectionString: state.settings.connectionString,
    ssl: state.settings.ssl,
    application_name: `${state.settings.applicationName}-cache-bus`,
    keepAlive: true,
    connectionTimeoutMillis: 15_000,
  });
  const onLost = (why: string) => (err?: Error) => {
    if (state.client !== client) return;
    console.warn(`[cache-bus] listener ${why}${err?.message ? `: ${err.message}` : ''} — reconnecting`);
    dropClient(state, client);
    scheduleReconnect(state);
  };
  client.on('error', onLost('error'));
  client.on('end', onLost('closed'));
  client.on('notification', handleNotification);
  try {
    await client.connect();
    await client.query(`LISTEN ${CACHE_BUS_CHANNEL}`);
  } catch (err) {
    state.connecting = false;
    client.removeAllListeners('notification');
    client.end().catch(() => undefined);
    if (!state.stopped) {
      console.warn('[cache-bus] listener connect failed:', err instanceof Error ? err.message : err);
      scheduleReconnect(state);
    }
    return;
  }
  state.connecting = false;
  if (state.stopped) {
    client.end().catch(() => undefined);
    return;
  }
  state.client = client;
  state.attempt = 0;
  // Anything cached before this LISTEN may have missed a notification.
  invalidateLocal(['all'], { resync: true });
  sendHeartbeat(state);
  state.heartbeatTimer = setInterval(() => {
    if (state.client !== client) return;
    checkTransition(state);
    sendHeartbeat(state);
    // A half-open TCP connection reports nothing; a cheap round trip does.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onLost('liveness timeout')();
    }, LIVENESS_TIMEOUT_MS);
    timer.unref?.();
    client.query('SELECT 1').then(
      () => clearTimeout(timer),
      (err: Error) => {
        clearTimeout(timer);
        if (!timedOut) onLost('liveness query failed')(err);
      },
    );
  }, HEARTBEAT_EVERY_MS);
  state.heartbeatTimer.unref?.();
}

/**
 * Start this process's listener (best-effort, never throws). Only the API
 * process calls it (server/index.ts); workers and scripts only publish.
 * A no-op in supabase-rest mode — the bus is then local-only and every cache
 * keeps working on its TTL.
 */
export function startCacheBusListener(overrides?: { connectionString?: string }): void {
  if (listener && !listener.stopped) return;
  if (!overrides?.connectionString && dataDriver() !== 'postgres') return;
  let settings: ListenerState['settings'] = null;
  try {
    const db = databaseSettings();
    const connectionString = overrides?.connectionString || db?.connectionString;
    if (!connectionString) return;
    settings = {
      connectionString,
      ssl: overrides?.connectionString ? undefined : db?.ssl,
      applicationName: db?.applicationName || 'webyar',
    };
  } catch (err) {
    console.warn('[cache-bus] not started:', err instanceof Error ? err.message : err);
    return;
  }
  listener = {
    client: null,
    stopped: false,
    attempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    connecting: false,
    lastHeartbeatAt: 0,
    wasActive: false,
    heartbeatSeq: 0,
    settings,
    dropHeartbeats: false,
  };
  void connect(listener);
}

/** Stop listening (graceful shutdown, tests). */
export async function stopCacheBusListener(): Promise<void> {
  const state = listener;
  listener = null;
  if (!state) return;
  state.stopped = true;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  const client = state.client;
  state.client = null;
  if (client) {
    client.removeAllListeners('notification');
    await client.end().catch(() => undefined);
  }
}

/** Test-only: the listener's client, to simulate a lost connection. */
export function __cacheBusListenerClientForTests(): pg.Client | null {
  return listener?.client ?? null;
}

/** Test-only: send a heartbeat now / ignore heartbeats (a URL that never delivers). */
export function __cacheBusHeartbeatForTests(opts: { send?: boolean; drop?: boolean; expire?: boolean } = {}): void {
  if (!listener) return;
  if (opts.drop !== undefined) listener.dropHeartbeats = opts.drop;
  if (opts.expire) listener.lastHeartbeatAt = Date.now() - HEARTBEAT_STALE_MS - 1;
  if (opts.send) sendHeartbeat(listener);
}

/** Test-only: forget the listener and any queued publish (handlers stay). */
export function __resetCacheBusForTests(): void {
  void stopCacheBusListener();
  pending = null;
  draining = null;
}
