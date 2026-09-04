/**
 * Operator presence — live liveness vs. analytics sampling.
 *
 * Regression guard for the bug where `operator_activity_samples` (5-minute
 * ANALYTICS buckets) was read as a live liveness signal: a continuously
 * connected operator flickered to `not_connected` between bucket writes.
 *
 * Live presence now comes from `operator_presence_live` (one UPSERTed row
 * per workspace+user). These tests replay a real 10+ minute heartbeat
 * timeline through the actual server code, asserting presence stays online
 * the whole time while the analytics table keeps ~1 row per 5-minute bucket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory fake of the tiny slice of PostgREST the code uses ──────
interface Row { [k: string]: any }
const db: Record<string, Row[]> = {};
let insertCount = 0;
let presenceWrites = 0;

function makeQuery(table: string) {
  let rows = () => db[table] || [];
  const filters: Array<(r: Row) => boolean> = [];
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
    in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), q),
    is: (c: string, v: any) => (filters.push((r) => (r[c] ?? null) === v), q),
    gte: (c: string, v: any) => (filters.push((r) => String(r[c]) >= String(v)), q),
    lt: (c: string, v: any) => (filters.push((r) => String(r[c]) < String(v)), q),
    neq: (c: string, v: any) => (filters.push((r) => r[c] !== v), q),
    order: () => q,
    limit: () => q,
    range: () => q,
    maybeSingle: async () => {
      const out = rows().filter((r) => filters.every((f) => f(r)));
      return { data: out[0] ?? null, error: null };
    },
    then: (resolve: any) =>
      resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }),
    upsert: async (payload: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      db[table] = db[table] || [];
      const keys = (opts?.onConflict || '').split(',').map((k) => k.trim()).filter(Boolean);
      const existing = db[table].find((r) => keys.every((k) => r[k] === payload[k]));
      if (existing) {
        if (!opts?.ignoreDuplicates) Object.assign(existing, payload);
      } else {
        db[table].push({ ...payload });
        if (table === 'operator_activity_samples') insertCount++;
      }
      if (table === 'operator_presence_live') presenceWrites++;
      return { data: null, error: null };
    },
    delete: () => q,
  };
  return q;
}

const fakeClient = { from: (t: string) => makeQuery(t), rpc: async () => ({ data: null, error: null }) };

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/supabase', () => ({ getServiceClient: () => fakeClient }));

// This suite pins the DATABASE FALLBACK path (polling/disabled providers).
// The realtime-first Centrifugo path has its own suite:
// operatorPresenceRealtime.test.ts
vi.mock('../../../server/services/realtime/index.js', () => ({
  resolveRealtimeProvider: async () => ({
    effective_vendor: 'polling_builtin',
    capabilities: { supportsPresence: false },
    public_config: {},
    health: { status: 'healthy' },
  }),
  getCentrifugoDriver: async () => null,
}));

import {
  listWorkspacePresence,
  anyOperatorOnline,
  recordOperatorPresenceBeat,
  computeOperatorState,
  PRESENCE_LIVENESS_MS,
} from '../../../server/services/widget/operatorPresence';
import { floorToBucket, BUCKET_MINUTES } from '../../../server/routes/operatorActivity';
import { resetPresenceSourceCache } from '../../../server/services/widget/operatorPresenceSource';

const WS = 'ws-1';
const USER = 'user-1';
const cfg: any = {};

/** Mirrors the heartbeat route: live beat always, analytics at most per bucket. */
const lastBucket = new Map<string, string>();
async function heartbeat(at: Date) {
  await recordOperatorPresenceBeat(cfg, WS, USER, at);
  const bucket = floorToBucket(at);
  const key = `${WS}:${USER}`;
  if (lastBucket.get(key) === bucket) return;
  const prefs = (db.user_availability_prefs || []).find((p) => p.user_id === USER) || null;
  const { state } = computeOperatorState(prefs as any, at);
  db.operator_activity_samples = db.operator_activity_samples || [];
  if (!db.operator_activity_samples.some((r) => r.bucket === bucket && r.user_id === USER)) {
    db.operator_activity_samples.push({ workspace_id: WS, user_id: USER, bucket, available: state === 'online' });
    insertCount++;
  }
  lastBucket.set(key, bucket);
}

function reset(prefs?: Row | null) {
  for (const k of Object.keys(db)) delete db[k];
  insertCount = 0;
  presenceWrites = 0;
  lastBucket.clear();
  resetPresenceSourceCache();
  db.workspace_members = [{ workspace_id: WS, user_id: USER }];
  db.profiles = [{ id: USER, full_name: 'Op', email: 'op@x.io', avatar_url: null }];
  db.user_availability_prefs = prefs ? [prefs] : [];
  db.operator_activity_samples = [];
  db.operator_presence_live = [];
}

const T0 = new Date('2026-01-05T12:00:30.000Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);

describe('operator presence — live timeline', () => {
  beforeEach(() => reset());

  it('Test 1 — stays online for a continuous 12-minute session (never not_connected)', async () => {
    const observations: string[] = [];
    // Beats at 0, 2, 4, 6, 8, 10, 12 min; presence sampled every 30s.
    for (let halfMin = 0; halfMin <= 24; halfMin++) {
      const t = at(halfMin / 2);
      if (halfMin % 4 === 0) await heartbeat(t);
      const [p] = await listWorkspacePresence(cfg, WS, t);
      observations.push(`${p.state}:${p.reason}`);
    }
    expect(observations.every((o) => o.startsWith('online'))).toBe(true);
    expect(observations.some((o) => o.includes('not_connected'))).toBe(false);
    expect(observations.length).toBe(25);
  });

  it('Test 2 — analytics writes stay at ~1 row per 5-minute bucket', async () => {
    for (let halfMin = 0; halfMin <= 24; halfMin += 4) await heartbeat(at(halfMin / 2));
    const beats = 7; // 0,2,4,6,8,10,12
    expect(db.operator_activity_samples.length).toBe(insertCount);
    // 12 minutes spans 3 five-minute buckets (12:00, 12:05, 12:10).
    expect(insertCount).toBe(3);
    expect(insertCount).toBeLessThan(beats);
    expect(BUCKET_MINUTES).toBe(5);
    // Live presence never grows: exactly one row regardless of beat count.
    expect(db.operator_presence_live.length).toBe(1);
    expect(presenceWrites).toBe(beats);
  });

  it('Test 3 — routing eligibility survives an aging analytics bucket', async () => {
    await heartbeat(at(0));
    await heartbeat(at(2));
    // 3.5 min after the bucket timestamp: the OLD 3-minute analytics-based
    // liveness would have dropped this operator from the candidate list.
    const t = at(3.5);
    const presence = await listWorkspacePresence(cfg, WS, t);
    const online = presence.filter((p) => p.state === 'online').map((p) => p.user_id);
    expect(online).toContain(USER);
  });

  it('Test 4 — widget availability does not flip to no_operators_online mid-bucket', async () => {
    await heartbeat(at(0));
    await heartbeat(at(2));
    for (const m of [2.5, 3, 3.5, 4]) {
      const { anyOnline, memberCount } = await anyOperatorOnline(cfg, WS, at(m));
      expect({ m, anyOnline, memberCount }).toEqual({ m, anyOnline: true, memberCount: 1 });
    }
  });

  it('Test 5 — real disconnect goes offline within the liveness window', async () => {
    await heartbeat(at(0));
    const stillLive = await listWorkspacePresence(cfg, WS, new Date(at(0).getTime() + PRESENCE_LIVENESS_MS - 30_000));
    expect(stillLive[0].state).toBe('online');
    const after = await listWorkspacePresence(cfg, WS, new Date(at(0).getTime() + PRESENCE_LIVENESS_MS + 1000));
    expect(after[0].state).toBe('offline');
    expect(after[0].reason).toBe('not_connected');
    expect(PRESENCE_LIVENESS_MS).toBeLessThanOrEqual(6 * 60 * 1000);
  });

  it('Test 6 — force_offline wins over a live connection', async () => {
    reset({ user_id: USER, workspace_id: null, force_offline: true, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC', weekly_schedule: {} });
    await heartbeat(at(0));
    const [p] = await listWorkspacePresence(cfg, WS, at(1));
    expect(p.state).toBe('offline');
    expect(p.reason).toBe('force_offline');
  });

  it('Test 7 — personal schedule still gates a connected operator', async () => {
    const schedule = {
      mon: { enabled: true, intervals: [{ from: '09:00', to: '17:00' }] },
      tue: { enabled: true, intervals: [{ from: '09:00', to: '17:00' }] },
      wed: { enabled: true, intervals: [{ from: '09:00', to: '17:00' }] },
      thu: { enabled: true, intervals: [{ from: '09:00', to: '17:00' }] },
      fri: { enabled: true, intervals: [{ from: '09:00', to: '17:00' }] },
      sat: { enabled: false, intervals: [] },
      sun: { enabled: false, intervals: [] },
    };
    reset({ user_id: USER, workspace_id: null, force_offline: false, available_when_using_app: true, schedule_enabled: true, timezone: 'UTC', weekly_schedule: schedule });

    // Monday 2026-01-05 12:00 UTC — inside the schedule.
    await heartbeat(at(0));
    const inside = await listWorkspacePresence(cfg, WS, at(1));
    expect(inside[0].state).toBe('online');
    expect(inside[0].reason).toBe('within_schedule');

    // Same day 18:00 UTC — outside the schedule, connection still fresh.
    const evening = new Date('2026-01-05T18:00:00.000Z');
    await recordOperatorPresenceBeat(cfg, WS, USER, evening);
    const outside = await listWorkspacePresence(cfg, WS, new Date(evening.getTime() + 60_000));
    expect(outside[0].state).toBe('offline');
    expect(outside[0].reason).toBe('outside_schedule');
  });
});
