/**
 * Visitor Presence — unit tests (channel scheme v2, candidate-driven).
 *
 * Proves the architecture invariants at code level:
 *   • presence mode resolution (realtime only when Centrifugo presence is
 *     genuinely primary AND usable)
 *   • reads are BOUNDED by the candidate set, batched, and never enumerate the
 *     online population
 *   • no false offline: read failure → database fallback, absent-but-fresh →
 *     'unknown' during the handoff window
 *   • multi-tab: one tab closing cannot take the session offline while another
 *     tab is still connected
 *   • per-session lease decides write suppression, not the workspace flag
 *   • DB-liveness write discipline counters
 *
 * Real cross-node behaviour (Redis + two Centrifugo nodes) stays covered by
 * scripts/realtime/visitor-presence-integration.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  buildVisitorPresenceChannelName,
  buildVisitorPresenceSubject,
  isVisitorPresenceChannel,
  parseVisitorPresenceChannel,
  channelBelongsToWorkspace,
  VISITOR_PRESENCE_BATCH_MAX,
  VISITOR_PRESENCE_MAX_CANDIDATES,
} from '../realtime/types.js';
import {
  issueVisitorPresenceLease,
  verifyVisitorPresenceLease,
} from './presenceLease.js';

let realtimeConfig: any = null;
let resolvedProvider: any = null;

vi.mock('../realtime/index.js', () => ({
  loadRealtimeConfig: async () => realtimeConfig,
  resolveRealtimeProvider: async () => resolvedProvider,
}));
vi.mock('../realtime/store.js', () => ({
  loadRealtimeConfig: async () => realtimeConfig,
}));
vi.mock('../../supabase.js', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({ like: () => ({ gte: async () => ({ data: [] }) }) }),
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

/** Channels the fake Centrifugo reports client counts for. */
let clientsByChannel: Record<string, number | null> = {};
/** Endpoints (api_url) whose whole batch call fails. */
let deadEndpoints = new Set<string>();
let batchCalls: Array<{ api_url: string; channels: string[] }> = [];

vi.mock('../realtime/centrifugo.js', () => ({
  CentrifugoDriver: class {
    constructor(private cfg: any) {}
    async presenceStatsBatch(channels: string[]) {
      batchCalls.push({ api_url: this.cfg.api_url, channels });
      if (deadEndpoints.has(this.cfg.api_url)) return null;
      const out = new Map<string, number>();
      for (const ch of channels) {
        const v = clientsByChannel[ch];
        if (v === null) continue; // per-channel error → no evidence
        out.set(ch, v ?? 0);
      }
      return out;
    }
  },
}));

const {
  resolveVisitorPresenceMode,
  resolveVisitorPresenceForSessions,
  applyVisitorPresence,
  shouldWriteVisitorLiveness,
  recordVisitorLivenessWrite,
  getVisitorPresenceMetrics,
  resetVisitorPresenceCache,
  VISITOR_PRESENCE_HANDOFF_MS,
} = await import('./presenceSource.js');

const config = {} as any;
const WS = '11111111-1111-1111-1111-111111111111';
const uuid = (n: number) =>
  `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

function realtimeHealthy(nodes: any[] = []) {
  realtimeConfig = {
    enabled: true,
    vendor: 'centrifugo',
    centrifugo: {
      ws_url: 'wss://rt.example.com/connection/websocket',
      api_url: 'http://rt:8000/api',
      api_key: 'k',
      token_hmac_secret: 's',
      presence_enabled: true,
      nodes,
    },
  };
  resolvedProvider = {
    effective_vendor: 'centrifugo',
    capabilities: { supportsPresence: true },
    public_config: { presence_enabled: true },
    health: { status: 'healthy' },
  };
}

const online = (sessionId: string, clients = 1) => {
  clientsByChannel[buildVisitorPresenceChannelName(WS, sessionId)] = clients;
};

beforeEach(() => {
  resetVisitorPresenceCache();
  clientsByChannel = {};
  deadEndpoints = new Set();
  batchCalls = [];
  realtimeHealthy();
});

describe('visitor presence channels (v2)', () => {
  it('is one channel per session and parses back', () => {
    const sid = uuid(1);
    const ch = buildVisitorPresenceChannelName(WS, sid);
    expect(ch).toBe(`vp:v2:${WS}:${sid}`);
    expect(parseVisitorPresenceChannel(ch)).toEqual({ workspaceId: WS, sessionId: sid });
    expect(isVisitorPresenceChannel(ch, WS)).toBe(true);
    expect(isVisitorPresenceChannel(ch, uuid(9))).toBe(false);
    expect(isVisitorPresenceChannel(`vp:v2:${WS}:not-a-uuid`, WS)).toBe(false);
    expect(isVisitorPresenceChannel(`vp:${WS}:3`, WS)).toBe(false); // v1 is gone
  });

  it('is NOT reachable through the conversation-channel validator', () => {
    expect(channelBelongsToWorkspace(buildVisitorPresenceChannelName(WS, uuid(1)), WS)).toBe(false);
  });

  it('mints a server-side subject from the session id', () => {
    expect(buildVisitorPresenceSubject('sid')).toBe('vs_sid');
  });
});

describe('presence mode', () => {
  it('is realtime only when Centrifugo presence is configured AND usable', async () => {
    expect(await resolveVisitorPresenceMode(config, WS)).toBe('realtime');

    resetVisitorPresenceCache();
    resolvedProvider = { ...resolvedProvider, health: { status: 'down' } };
    expect(await resolveVisitorPresenceMode(config, WS)).toBe('database');

    resetVisitorPresenceCache();
    realtimeHealthy();
    realtimeConfig.centrifugo.presence_enabled = false;
    expect(await resolveVisitorPresenceMode(config, WS)).toBe('database');

    resetVisitorPresenceCache();
    realtimeHealthy();
    resolvedProvider = { ...resolvedProvider, effective_vendor: 'polling_builtin' };
    expect(await resolveVisitorPresenceMode(config, WS)).toBe('database');
  });
});

describe('per-session write discipline', () => {
  it('suppresses liveness ONLY for a session holding a valid lease', async () => {
    const sid = uuid(2);
    const { lease } = issueVisitorPresenceLease(WS, sid);
    expect(verifyVisitorPresenceLease(lease, WS, sid)).toBe(true);
    expect(await shouldWriteVisitorLiveness(config, WS, true)).toBe(false);
    // A visitor whose socket never opened has no lease → keeps writing.
    expect(await shouldWriteVisitorLiveness(config, WS, false)).toBe(true);
  });

  it('rejects a lease bound to another session, workspace, or already expired', () => {
    const sid = uuid(3);
    const { lease } = issueVisitorPresenceLease(WS, sid);
    expect(verifyVisitorPresenceLease(lease, WS, uuid(4))).toBe(false);
    expect(verifyVisitorPresenceLease(lease, uuid(5), sid)).toBe(false);
    expect(verifyVisitorPresenceLease(lease + 'x', WS, sid)).toBe(false);
    const expired = issueVisitorPresenceLease(WS, sid, 30, Date.now() - 600_000);
    expect(verifyVisitorPresenceLease(expired.lease, WS, sid)).toBe(false);
  });

  it('restores database liveness when realtime stops being authoritative', async () => {
    resetVisitorPresenceCache();
    realtimeConfig = { enabled: false, vendor: 'polling_builtin' };
    expect(await shouldWriteVisitorLiveness(config, WS, true)).toBe(true);
  });
});

describe('resolveVisitorPresenceForSessions', () => {
  it('resolves K candidates in ONE batched call', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => uuid(100 + i));
    online(ids[0]);
    const res = await resolveVisitorPresenceForSessions(config, WS, ids);
    expect(batchCalls.length).toBe(1);
    expect(batchCalls[0].channels.length).toBe(50);
    expect(res.online.has(ids[0])).toBe(true);
    expect(res.authoritative).toBe(true);
    expect(getVisitorPresenceMetrics().candidates_resolved).toBe(50);
  });

  it('chunks large candidate sets and caps them', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => uuid(1000 + i));
    await resolveVisitorPresenceForSessions(config, WS, ids);
    expect(batchCalls.length).toBe(Math.ceil(250 / VISITOR_PRESENCE_BATCH_MAX));
    expect(VISITOR_PRESENCE_MAX_CANDIDATES).toBeGreaterThanOrEqual(250);
  });

  it('refuses to enumerate the online set (no full scan)', async () => {
    const res = await resolveVisitorPresenceForSessions(config, WS, []);
    expect(batchCalls.length).toBe(0);
    expect(res.online.size).toBe(0);
    expect(res.authoritative).toBe(false);
    expect(getVisitorPresenceMetrics().full_scan_rejected).toBe(1);
  });

  it('caches per-session results so operator polling does not fan out', async () => {
    const sid = uuid(6);
    await resolveVisitorPresenceForSessions(config, WS, [sid]);
    const first = batchCalls.length;
    await resolveVisitorPresenceForSessions(config, WS, [sid]);
    expect(batchCalls.length).toBe(first);
    expect(getVisitorPresenceMetrics().cache_hits).toBeGreaterThan(0);
  });

  it('retries exactly one alternate endpoint, then falls back to the database', async () => {
    realtimeHealthy([
      {
        id: 'rt-node-02',
        name: 'n2',
        node_name: 'rt-node-02',
        ws_url: 'wss://n2/connection/websocket',
        api_url: 'http://n2:8000/api',
        enabled: true,
        accepting_new_connections: true,
        draining: false,
        weight: 1,
      },
    ]);
    deadEndpoints.add('http://rt:8000/api');
    const sid = uuid(7);
    online(sid);
    const res = await resolveVisitorPresenceForSessions(config, WS, [sid]);
    expect(res.mode).toBe('realtime');
    expect(res.online.has(sid)).toBe(true);
    expect(batchCalls.map((c) => c.api_url)).toEqual([
      'http://rt:8000/api',
      'http://n2:8000/api',
    ]);
    expect(getVisitorPresenceMetrics().realtime_endpoint_retries).toBe(1);
  });

  it('falls back to the database when no endpoint answers (never false offline)', async () => {
    deadEndpoints.add('http://rt:8000/api');
    const sid = uuid(8);
    const res = await resolveVisitorPresenceForSessions(config, WS, [sid]);
    expect(res.mode).toBe('database');
    const m = getVisitorPresenceMetrics();
    expect(m.realtime_read_failures).toBe(1);
    expect(m.fallback_activations).toBe(1);
    // The workspace stays in fallback (jittered TTL) so liveness writes resume
    // even for sessions that still hold a lease.
    expect(await shouldWriteVisitorLiveness(config, WS, true)).toBe(true);
  });

  it('treats a per-channel error as no evidence, not as offline', async () => {
    const sid = uuid(9);
    clientsByChannel[buildVisitorPresenceChannelName(WS, sid)] = null;
    const res = await resolveVisitorPresenceForSessions(config, WS, [sid]);
    expect(res.mode).toBe('realtime');
    expect(res.authoritative).toBe(false);
    expect(applyVisitorPresence(res, sid, 'online', null)).toBe('online');
  });
});

describe('applyVisitorPresence', () => {
  const authoritative = {
    mode: 'realtime' as const,
    online: new Set(['present']),
    authoritative: true,
    handoffMs: VISITOR_PRESENCE_HANDOFF_MS,
  };

  it('reports a connected session online regardless of stored status', () => {
    expect(applyVisitorPresence(authoritative, 'present', 'offline', null)).toBe('online');
  });

  it('reports unknown — not offline — inside the handoff window', () => {
    const fresh = new Date().toISOString();
    expect(applyVisitorPresence(authoritative, 'absent', 'online', fresh)).toBe('unknown');
  });

  it('reports offline once the row aged past the handoff window', () => {
    const old = new Date(Date.now() - VISITOR_PRESENCE_HANDOFF_MS - 10_000).toISOString();
    expect(applyVisitorPresence(authoritative, 'absent', 'online', old)).toBe('offline');
  });

  it('keeps the database verdict when realtime evidence is partial', () => {
    const partial = { ...authoritative, authoritative: false };
    expect(applyVisitorPresence(partial, 'absent', 'online', null)).toBe('online');
  });

  it('keeps the database verdict in database mode', () => {
    const db = { ...authoritative, mode: 'database' as const, online: new Set<string>() };
    expect(applyVisitorPresence(db, 'present', 'idle', null)).toBe('idle');
  });

  it('multi-tab: the session stays online while ANY tab is connected', async () => {
    const sid = uuid(10);
    online(sid, 2); // two tabs = two clients on the session channel
    const res = await resolveVisitorPresenceForSessions(config, WS, [sid]);
    expect(applyVisitorPresence(res, sid, 'offline', null)).toBe('online');

    // One tab closes → still one client left.
    resetVisitorPresenceCache();
    realtimeHealthy();
    online(sid, 1);
    const res2 = await resolveVisitorPresenceForSessions(config, WS, [sid]);
    expect(applyVisitorPresence(res2, sid, 'offline', null)).toBe('online');
  });
});

describe('write discipline counters', () => {
  it('flags a liveness write that happens while realtime presence is healthy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordVisitorLivenessWrite('coalesced', 'realtime');
    recordVisitorLivenessWrite('skipped_lease', 'realtime');
    recordVisitorLivenessWrite('wrote', 'database');
    expect(getVisitorPresenceMetrics().db_liveness_writes_while_realtime_healthy).toBe(0);
    expect(getVisitorPresenceMetrics().heartbeats_skipped_by_lease).toBe(1);
    recordVisitorLivenessWrite('wrote', 'realtime');
    expect(getVisitorPresenceMetrics().db_liveness_writes_while_realtime_healthy).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
