/**
 * Operator presence — REALTIME-FIRST path (Centrifugo presence).
 *
 * Presence source of truth in this mode is membership of the operator-only
 * channel `ws:{workspace_id}:operators`; PostgreSQL is a fallback only.
 * These tests replay real timelines through the actual server code and
 * assert:
 *   A — 30 minutes visible ⇒ always online, routing eligible, widget online,
 *       ZERO `operator_presence_live` writes.
 *   B — hidden tab ⇒ membership drops ⇒ offline within seconds.
 *   C — multi-tab dedupe.
 *   D — real disconnect ⇒ offline, no ghost presence.
 *   E/F — presence-backend failure never wipes every candidate.
 *   G — Centrifugo failure ⇒ DB fallback writes resume; recovery ⇒ stop.
 *   H — Supabase / polling (no presence capability) ⇒ DB fallback.
 *   I — channel security (visitor channels can never be the operator one).
 *   J — load: many heartbeats ⇒ 0 live-presence writes, analytics ≤1/5min.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  vendor: 'centrifugo' as string,
  supportsPresence: true,
  presenceEnabled: true,
  health: 'healthy' as string,
  /** null ⇒ presence API unreadable. */
  members: new Set<string>() as Set<string> | null,
  /** Per-workspace override of the presence roster. */
  membersByWs: new Map<string, Set<string> | null>(),
  /** Centrifugo itself unreachable (driver cannot be built). */
  driverDown: false,
  presenceCalls: 0,
}));

interface Row { [k: string]: any }
const db: Record<string, Row[]> = {};
let presenceWrites = 0;
let analyticsInserts = 0;

function makeQuery(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => db[table] || [];
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
    in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), q),
    is: (c: string, v: any) => (filters.push((r) => (r[c] ?? null) === v), q),
    gte: (c: string, v: any) => (filters.push((r) => String(r[c]) >= String(v)), q),
    lt: (c: string, v: any) => (filters.push((r) => String(r[c]) < String(v)), q),
    order: () => q,
    limit: () => q,
    maybeSingle: async () => ({ data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }),
    upsert: async (payload: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      db[table] = db[table] || [];
      const keys = (opts?.onConflict || '').split(',').map((k) => k.trim()).filter(Boolean);
      const existing = db[table].find((r) => keys.every((k) => r[k] === payload[k]));
      if (existing) { if (!opts?.ignoreDuplicates) Object.assign(existing, payload); }
      else {
        db[table].push({ ...payload });
        if (table === 'operator_activity_samples') analyticsInserts++;
      }
      if (table === 'operator_presence_live') presenceWrites++;
      return { data: null, error: null };
    },
    delete: () => {
      const dq: any = {
        eq: (c: string, v: any) => {
          db[table] = (db[table] || []).filter((r) => r[c] !== v);
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: any) => resolve({ data: null, error: null }),
      };
      return dq;
    },
  };
  return q;
}

const fakeClient = { from: (t: string) => makeQuery(t), rpc: async () => ({ data: null, error: null }) };
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/supabase', () => ({ getServiceClient: () => fakeClient }));

vi.mock('../../../server/services/realtime/index.js', () => ({
  resolveRealtimeProvider: async () => ({
    effective_vendor: state.vendor,
    capabilities: { supportsPresence: state.supportsPresence },
    public_config: { presence_enabled: state.presenceEnabled },
    health: { status: state.health },
  }),
  getCentrifugoDriver: async () =>
    state.vendor === 'centrifugo' && !state.driverDown
      ? {
          presenceUsers: async (channel: string) => {
            state.presenceCalls++;
            const ws = /^ws:(.+):operators$/.exec(channel)?.[1] ?? '';
            const members = state.membersByWs.has(ws)
              ? state.membersByWs.get(ws)!
              : ws === WS
                ? state.members
                : new Set<string>();
            return members ? [...members].map((u) => `op_${u}`) : null;
          },
        }
      : null,
}));

import {
  listWorkspacePresence,
  anyOperatorOnline,
  recordOperatorPresenceBeat,
} from '../../../server/services/widget/operatorPresence';
import {
  getConnectedOperators,
  shouldWriteFallbackPresence,
  resetPresenceSourceCache,
  PRESENCE_LIVENESS_MS,
} from '../../../server/services/widget/operatorPresenceSource';
import { floorToBucket } from '../../../server/routes/operatorActivity';
import {
  buildOperatorPresenceChannelName,
  isOperatorPresenceChannel,
  channelBelongsToWorkspace,
} from '../../../server/services/realtime/types';

const WS = 'ws-1';
const USER = 'user-1';
const cfg: any = {};
const T0 = new Date('2026-01-05T12:00:30.000Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);

/** Mirrors POST /api/operator-activity/heartbeat. */
const lastBucket = new Map<string, string>();
async function heartbeat(when: Date) {
  if (await shouldWriteFallbackPresence(cfg, when.getTime(), WS)) {
    await recordOperatorPresenceBeat(cfg, WS, USER, when);
  }
  const bucket = floorToBucket(when);
  const key = `${WS}:${USER}`;
  if (lastBucket.get(key) === bucket) return;
  db.operator_activity_samples = db.operator_activity_samples || [];
  if (!db.operator_activity_samples.some((r) => r.bucket === bucket && r.user_id === USER)) {
    db.operator_activity_samples.push({ workspace_id: WS, user_id: USER, bucket, available: true });
    analyticsInserts++;
  }
  lastBucket.set(key, bucket);
}

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  presenceWrites = 0;
  analyticsInserts = 0;
  lastBucket.clear();
  resetPresenceSourceCache();
  state.vendor = 'centrifugo';
  state.supportsPresence = true;
  state.presenceEnabled = true;
  state.health = 'healthy';
  state.members = new Set([USER]);
  state.membersByWs = new Map();
  state.driverDown = false;
  state.presenceCalls = 0;
  db.workspace_members = [{ workspace_id: WS, user_id: USER }];
  db.profiles = [{ id: USER, full_name: 'Op', email: 'op@x.io', avatar_url: null }];
  db.user_availability_prefs = [];
  db.operator_activity_samples = [];
  db.operator_presence_live = [];
  db.operator_presence_fallback_state = [];
}

describe('operator presence — realtime-first', () => {
  beforeEach(reset);

  it('A — 30 minutes visible: always online, zero live-presence DB writes', async () => {
    const seen: string[] = [];
    for (let half = 0; half <= 60; half++) {
      const t = at(half / 2);
      if (half % 4 === 0) await heartbeat(t);
      resetPresenceSourceCache(); // force a fresh read at each sample point
      state.members = new Set([USER]);
      const [p] = await listWorkspacePresence(cfg, WS, t);
      seen.push(`${p.state}:${p.reason}`);
      const { anyOnline } = await anyOperatorOnline(cfg, WS, t);
      expect(anyOnline).toBe(true);
    }
    expect(seen.every((s) => s.startsWith('online'))).toBe(true);
    expect(seen.some((s) => s.includes('not_connected'))).toBe(false);
    // No periodic live-presence write happened at any point.
    expect(presenceWrites).toBe(0);
    expect(db.operator_presence_live.length).toBe(0);
    // Analytics unchanged: 30 min ⇒ 7 five-minute buckets (12:00 … 12:30).
    expect(analyticsInserts).toBe(7);
  });

  it('B — hidden tab drops membership and goes offline within seconds', async () => {
    let [p] = await listWorkspacePresence(cfg, WS, at(0));
    expect(p.state).toBe('online');
    // Tab hidden ⇒ the panel unsubscribes ⇒ Centrifugo membership disappears.
    state.members = new Set();
    resetPresenceSourceCache();
    [p] = await listWorkspacePresence(cfg, WS, at(0.1)); // 6 seconds later
    expect(p.state).toBe('offline');
    expect(p.reason).toBe('not_connected');
    // Visible again ⇒ immediately online, no 5-minute wait.
    state.members = new Set([USER]);
    resetPresenceSourceCache();
    [p] = await listWorkspacePresence(cfg, WS, at(0.2));
    expect(p.state).toBe('online');
  });

  it('C — multiple tabs dedupe to one online operator', async () => {
    // Centrifugo reports one presence entry per client, all under the same
    // `user`; the driver already collapses them into a distinct user set.
    state.members = new Set([USER]);
    let snap = await getConnectedOperators(cfg, WS, [USER], at(0));
    expect(snap.mode).toBe('realtime');
    expect(snap.connected.has(USER)).toBe(true);
    // One tab hidden, one still visible ⇒ still a member ⇒ still online.
    resetPresenceSourceCache();
    snap = await getConnectedOperators(cfg, WS, [USER], at(1));
    expect(snap.connected.has(USER)).toBe(true);
    // All tabs hidden/closed ⇒ offline.
    state.members = new Set();
    resetPresenceSourceCache();
    snap = await getConnectedOperators(cfg, WS, [USER], at(2));
    expect(snap.connected.size).toBe(0);
  });

  it('D — real disconnect/logout leaves no ghost presence', async () => {
    state.members = new Set();
    resetPresenceSourceCache();
    const [p] = await listWorkspacePresence(cfg, WS, at(1));
    expect(p.state).toBe('offline');
    expect(presenceWrites).toBe(0);
  });

  it('E/F — presence backend failure does not wipe every candidate', async () => {
    // Warm a good snapshot, then break the presence API.
    await getConnectedOperators(cfg, WS, [USER], at(0));
    state.members = null;
    const graced = await getConnectedOperators(cfg, WS, [USER], at(0.5));
    expect(graced.connected.has(USER)).toBe(true); // last-good snapshot honoured
    expect(graced.degraded).toBe(true);
    // Widget must not report no_operators_online during the transition.
    const { anyOnline } = await anyOperatorOnline(cfg, WS, at(0.5));
    expect(anyOnline).toBe(true);
  });

  it('G — failure with an EMPTY/stale lease table: no false-offline before the first fallback beat', async () => {
    // 30 minutes of healthy Centrifugo, zero live-presence writes, so the
    // lease table has NO row at all for this operator.
    for (let m = 0; m <= 30; m += 2) {
      await heartbeat(at(m));
      resetPresenceSourceCache();
      const [p] = await listWorkspacePresence(cfg, WS, at(m));
      expect(p.state).toBe('online');
    }
    expect(presenceWrites).toBe(0);
    expect(db.operator_presence_live.length).toBe(0);

    // Presence API goes unreadable at t=31. Operator is still connected.
    state.members = null;
    resetPresenceSourceCache();

    // Every 10 seconds until the next heartbeat lands (~2 min later) the
    // operator must stay online for presence, routing and the widget.
    for (let s10 = 0; s10 <= 12; s10++) {
      const t = at(31 + s10 / 6);
      resetPresenceSourceCache(); // worst case: cold instance, no local snapshot
      const [p] = await listWorkspacePresence(cfg, WS, t);
      expect(p.state, `t=${t.toISOString()}`).toBe('online');
      expect(p.reason).not.toBe('not_connected');
      const { anyOnline } = await anyOperatorOnline(cfg, WS, t);
      expect(anyOnline).toBe(true);
    }

    // The breaker is shared + scoped, so the next heartbeat writes the lease.
    expect(await shouldWriteFallbackPresence(cfg, at(33).getTime(), WS)).toBe(true);
    await heartbeat(at(33));
    expect(presenceWrites).toBe(1);

    // Lease is now authoritative: still online well past the roster handoff.
    const [after] = await listWorkspacePresence(cfg, WS, at(35));
    expect(after.state).toBe('online');

    // Recovery ⇒ realtime again ⇒ writes stop.
    state.members = new Set([USER]);
    resetPresenceSourceCache();
    const [rec] = await listWorkspacePresence(cfg, WS, at(36));
    expect(rec.state).toBe('online');
    expect(await shouldWriteFallbackPresence(cfg, at(36).getTime(), WS)).toBe(false);
    const before = presenceWrites;
    await heartbeat(at(38));
    expect(presenceWrites).toBe(before);
  });

  it('G2 — a workspace-scoped read failure does not force other workspaces into write mode', async () => {
    state.members = null;
    resetPresenceSourceCache();
    await getConnectedOperators(cfg, WS, [USER], at(0));
    expect(await shouldWriteFallbackPresence(cfg, at(0.1).getTime(), WS)).toBe(true);
    expect(await shouldWriteFallbackPresence(cfg, at(0.1).getTime(), 'ws-other')).toBe(false);
    const scopes = db.operator_presence_fallback_state.map((r: any) => r.scope);
    expect(scopes).toEqual([WS]);
  });

  it('H — Supabase/polling providers keep using the DB fallback', async () => {
    state.vendor = 'supabase';
    state.supportsPresence = false;
    resetPresenceSourceCache();
    expect(await shouldWriteFallbackPresence(cfg, at(0).getTime())).toBe(true);
    await heartbeat(at(0));
    expect(presenceWrites).toBe(1);
    const [p] = await listWorkspacePresence(cfg, WS, at(1));
    expect(p.state).toBe('online');
    // And it still expires on the DB liveness window.
    const later = await listWorkspacePresence(cfg, WS, new Date(at(0).getTime() + PRESENCE_LIVENESS_MS + 1000));
    expect(later[0].state).toBe('offline');
  });

  it('K — two instances share the fallback decision and the recovery', async () => {
    // Instance A and instance B are two fresh module registries over the SAME
    // database — i.e. two logical servers.
    vi.resetModules();
    const A = await import('../../../server/services/widget/operatorPresenceSource');
    vi.resetModules();
    const B = await import('../../../server/services/widget/operatorPresenceSource');
    A.resetPresenceSourceCache();
    B.resetPresenceSourceCache();

    // Healthy: neither instance writes.
    expect(await A.shouldWriteFallbackPresence(cfg, at(0).getTime(), WS)).toBe(false);
    expect(await B.shouldWriteFallbackPresence(cfg, at(0).getTime(), WS)).toBe(false);

    // A sees the presence read fail and trips the shared breaker.
    state.members = null;
    A.resetPresenceSourceCache();
    const snapA = await A.getConnectedOperators(cfg, WS, [USER], at(1));
    expect(snapA.mode).toBe('database');
    expect(snapA.connected.has(USER)).toBe(true);
    expect(db.operator_presence_fallback_state.length).toBe(1);

    // B still believes Centrifugo is fine (its own mode cache is warm), but
    // the heartbeat that lands on B must refresh the lease anyway.
    expect(await B.shouldWriteFallbackPresence(cfg, at(1.2).getTime(), WS)).toBe(true);
    await B.getConnectedOperators(cfg, WS, [USER], at(1.2));
    presenceWrites = 0;
    await heartbeat(at(2));
    expect(presenceWrites).toBe(1);

    // Recovery observed by B ⇒ shared entry removed ⇒ A also stops writing
    // within the shared-state cache TTL.
    state.members = new Set([USER]);
    B.resetPresenceSourceCache();
    const snapB = await B.getConnectedOperators(cfg, WS, [USER], at(3));
    expect(snapB.mode).toBe('realtime');
    expect(db.operator_presence_fallback_state.length).toBe(0);
    expect(await B.shouldWriteFallbackPresence(cfg, at(3).getTime(), WS)).toBe(false);
    // A: bounded by the 5s shared-state cache, so probe just past it.
    expect(await A.shouldWriteFallbackPresence(cfg, at(3).getTime() + 6_000, WS)).toBe(false);
  });

  it('I — presence channel is workspace-scoped and operator-only', () => {
    const chan = buildOperatorPresenceChannelName(WS);
    expect(chan).toBe('ws:ws-1:operators');
    expect(isOperatorPresenceChannel(chan, WS)).toBe(true);
    expect(isOperatorPresenceChannel(chan, 'other-ws')).toBe(false);
    expect(channelBelongsToWorkspace(chan, 'other-ws')).toBe(false);
    // A visitor conversation channel can never be mistaken for it.
    expect(isOperatorPresenceChannel(`ws:${WS}:conv:abc`, WS)).toBe(false);
  });

  it('J — load: 200 heartbeats produce 0 live-presence writes in realtime mode', async () => {
    for (let i = 0; i < 200; i++) await heartbeat(at(i * 2));
    expect(presenceWrites).toBe(0);
    // Analytics: at most one row per 5-minute bucket.
    const buckets = new Set(db.operator_activity_samples.map((r) => r.bucket));
    expect(db.operator_activity_samples.length).toBe(buckets.size);
    expect(db.operator_activity_samples.length).toBeLessThanOrEqual(200);
  });

  it('L — global Centrifugo outage: two workspaces keep their OWN operators, no roster leakage', async () => {
    const WS_B = 'ws-2';
    const USER_B = 'user-2';
    db.workspace_members.push({ workspace_id: WS_B, user_id: USER_B });
    db.profiles.push({ id: USER_B, full_name: 'Op B', email: 'b@x.io', avatar_url: null });
    state.membersByWs.set(WS, new Set([USER]));
    state.membersByWs.set(WS_B, new Set([USER_B]));

    // 30 healthy minutes on both workspaces ⇒ lease table stays empty.
    for (let m = 0; m <= 30; m += 5) {
      resetPresenceSourceCache();
      expect((await listWorkspacePresence(cfg, WS, at(m)))[0].state).toBe('online');
      expect((await listWorkspacePresence(cfg, WS_B, at(m)))[0].state).toBe('online');
    }
    expect(presenceWrites).toBe(0);
    expect(db.operator_presence_live.length).toBe(0);

    // Centrifugo goes globally down.
    state.driverDown = true;
    resetPresenceSourceCache();

    for (let s10 = 0; s10 <= 12; s10++) {
      const t = at(31 + s10 / 6);
      const a = await listWorkspacePresence(cfg, WS, t);
      const b = await listWorkspacePresence(cfg, WS_B, t);
      expect(a.map((p) => p.user_id)).toEqual([USER]);
      expect(b.map((p) => p.user_id)).toEqual([USER_B]);
      expect(a[0].state).toBe('online');
      expect(b[0].state).toBe('online');
      expect((await anyOperatorOnline(cfg, WS, t)).anyOnline).toBe(true);
      expect((await anyOperatorOnline(cfg, WS_B, t)).anyOnline).toBe(true);
    }

    // The global row is a pure signal: no roster, so it can never be applied
    // as another workspace's operator list.
    const globalRow = db.operator_presence_fallback_state.find((r: any) => r.scope === 'global');
    expect(globalRow).toBeTruthy();
    expect(globalRow.roster).toEqual([]);
    expect(globalRow.roster_complete).toBe(false);
    // Each workspace has its OWN roster entry.
    const rowA = db.operator_presence_fallback_state.find((r: any) => r.scope === WS);
    const rowB = db.operator_presence_fallback_state.find((r: any) => r.scope === WS_B);
    expect(rowA.roster).toEqual([USER]);
    expect(rowB.roster).toEqual([USER_B]);
  });

  it('L2 — cold instance (empty read cache) honours the shared breaker without leaking rosters', async () => {
    const WS_B = 'ws-2';
    const USER_B = 'user-2';
    db.workspace_members.push({ workspace_id: WS_B, user_id: USER_B });
    db.profiles.push({ id: USER_B, full_name: 'Op B', email: 'b@x.io', avatar_url: null });
    state.membersByWs.set(WS, new Set([USER]));
    state.membersByWs.set(WS_B, new Set([USER_B]));

    // Warm instance A trips the breaker on workspace A only.
    await getConnectedOperators(cfg, WS, [USER], at(0));
    state.driverDown = true;
    resetPresenceSourceCache();
    await getConnectedOperators(cfg, WS, [USER], at(1));

    // Cold instance B: fresh module registry, empty realtimeCache.
    vi.resetModules();
    const cold = await import('../../../server/services/widget/operatorPresenceSource');
    cold.resetPresenceSourceCache();
    const snapB = await cold.getConnectedOperators(cfg, WS_B, [USER_B], at(1.5));
    expect(snapB.connected.has(USER_B)).toBe(true); // fail-open, not offline
    expect(snapB.connected.has(USER)).toBe(false);  // no cross-workspace roster
    expect(await cold.shouldWriteFallbackPresence(cfg, at(1.5).getTime(), WS_B)).toBe(true);
  });

  it('M — provider health DOWN: handoff works even though the presence API is never called', async () => {
    state.health = 'down';
    resetPresenceSourceCache();
    state.presenceCalls = 0;
    const [p] = await listWorkspacePresence(cfg, WS, at(1));
    expect(state.presenceCalls).toBe(0); // no presence read attempted
    expect(p.state).toBe('online');      // bounded handoff, not false-offline
    expect(await shouldWriteFallbackPresence(cfg, at(1).getTime(), WS)).toBe(true);
    await heartbeat(at(2));
    expect(presenceWrites).toBe(1);

    // Native database mode (no Centrifugo primary) must NOT fail open.
    reset();
    state.vendor = 'polling_builtin';
    state.supportsPresence = false;
    resetPresenceSourceCache();
    const [nat] = await listWorkspacePresence(cfg, WS, at(1));
    expect(nat.state).toBe('offline');
    expect(nat.reason).toBe('not_connected');
  });

  it('N — a workspace with more than 200 operators: nobody past the cap is dropped', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `u-${i}`);
    db.workspace_members = many.map((id) => ({ workspace_id: WS, user_id: id }));
    db.profiles = many.map((id) => ({ id, full_name: id, email: `${id}@x.io`, avatar_url: null }));
    state.members = new Set(many);

    let snap = await getConnectedOperators(cfg, WS, many, at(0));
    expect(snap.connected.size).toBe(250);

    // Presence read fails: roster exceeds the bounded cap ⇒ stored as
    // incomplete ⇒ fail-open, never "first 200 online, rest offline".
    state.members = null;
    resetPresenceSourceCache();
    snap = await getConnectedOperators(cfg, WS, many, at(1));
    expect(snap.connected.has('u-0')).toBe(true);
    expect(snap.connected.has('u-201')).toBe(true);
    expect(snap.connected.has('u-249')).toBe(true);
    const row = db.operator_presence_fallback_state.find((r: any) => r.scope === WS);
    expect(row.roster_complete).toBe(false);
    expect(row.roster.length).toBe(0); // row stays small
  });
});