/**
 * Visitor Presence Phase 2 — unit tests.
 *
 * Proves the architecture invariants at code level:
 *   • presence mode resolution (realtime only when Centrifugo presence is
 *     genuinely primary AND usable)
 *   • sharded reads are bounded and never one-channel-per-visitor
 *   • no false offline: read failure → database fallback, absent-but-fresh →
 *     'unknown' during the handoff window
 *   • multi-tab: one tab closing cannot take the session offline while another
 *     tab is still a member
 *   • DB-liveness write discipline counters
 *
 * Real cross-node behaviour (Redis + two Centrifugo nodes) stays covered by
 * scripts/realtime/cross-node-integration.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  VISITOR_PRESENCE_SHARDS,
  visitorPresenceShard,
  buildVisitorPresenceChannelName,
  buildVisitorPresenceSubject,
  isVisitorPresenceChannel,
  channelBelongsToWorkspace,
} from '../realtime/types.js';

let realtimeConfig: any = null;
let resolvedProvider: any = null;

vi.mock('../realtime/index.js', () => ({
  loadRealtimeConfig: async () => realtimeConfig,
  resolveRealtimeProvider: async () => resolvedProvider,
}));

/** Channels the fake Centrifugo reports presence for. */
let presenceByChannel: Record<string, string[] | null> = {};
let presenceCalls: string[] = [];

vi.mock('../realtime/centrifugo.js', () => ({
  CentrifugoDriver: class {
    constructor(_cfg: any) {}
    async presenceUsers(channel: string) {
      presenceCalls.push(channel);
      const v = presenceByChannel[channel];
      return v === undefined ? [] : v;
    }
  },
}));

const {
  resolveVisitorPresenceMode,
  resolveVisitorPresence,
  applyVisitorPresence,
  shouldWriteVisitorLiveness,
  recordVisitorLivenessWrite,
  getVisitorPresenceMetrics,
  resetVisitorPresenceCache,
  VISITOR_PRESENCE_HANDOFF_MS,
} = await import('./presenceSource.js');

const config = {} as any;

function realtimeHealthy() {
  realtimeConfig = {
    enabled: true,
    vendor: 'centrifugo',
    centrifugo: {
      ws_url: 'wss://rt.example.com/connection/websocket',
      api_url: 'http://rt:8000/api',
      api_key: 'k',
      token_hmac_secret: 's',
      presence_enabled: true,
    },
  };
  resolvedProvider = {
    effective_vendor: 'centrifugo',
    capabilities: { supportsPresence: true },
    public_config: { presence_enabled: true },
    health: { status: 'healthy' },
  };
}

beforeEach(() => {
  resetVisitorPresenceCache();
  presenceByChannel = {};
  presenceCalls = [];
  realtimeHealthy();
});

const WS = '11111111-1111-1111-1111-111111111111';

describe('visitor presence channels', () => {
  it('shards deterministically and stays inside the shard range', () => {
    for (const id of ['a', 'session-1', 'b6b1a0e0-0000-4000-8000-000000000000']) {
      const s = visitorPresenceShard(id);
      expect(s).toBe(visitorPresenceShard(id));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(VISITOR_PRESENCE_SHARDS);
    }
  });

  it('spreads sessions over more than one shard', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) seen.add(visitorPresenceShard(`session-${i}`));
    expect(seen.size).toBeGreaterThan(4);
  });

  it('accepts only this workspace\'s presence shards', () => {
    const ch = buildVisitorPresenceChannelName(WS, 3);
    expect(ch).toBe(`vp:${WS}:3`);
    expect(isVisitorPresenceChannel(ch, WS)).toBe(true);
    expect(isVisitorPresenceChannel(ch, 'other')).toBe(false);
    expect(isVisitorPresenceChannel(`vp:${WS}:9999`, WS)).toBe(false);
    expect(isVisitorPresenceChannel(`vp:${WS}:x`, WS)).toBe(false);
  });

  it('is NOT reachable through the conversation-channel validator', () => {
    // The widget subscribe endpoint must never be able to mint a presence
    // shard token through the generic channel path.
    expect(channelBelongsToWorkspace(buildVisitorPresenceChannelName(WS, 1), WS)).toBe(false);
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

  it('suppresses DB liveness writes in realtime mode and restores them in database mode', async () => {
    expect(await shouldWriteVisitorLiveness(config, WS)).toBe(false);
    resetVisitorPresenceCache();
    realtimeConfig = { enabled: false, vendor: 'polling_builtin' };
    expect(await shouldWriteVisitorLiveness(config, WS)).toBe(true);
  });
});

describe('resolveVisitorPresence', () => {
  it('reads only the shards of the requested sessions', async () => {
    const sessions = ['s1', 's2', 's3'];
    const expected = new Set(sessions.map((s) => visitorPresenceShard(s)));
    await resolveVisitorPresence(config, WS, sessions);
    expect(presenceCalls.length).toBe(expected.size);
    expect(presenceCalls.length).toBeLessThanOrEqual(VISITOR_PRESENCE_SHARDS);
  });

  it('scans every shard when discovering the full online set', async () => {
    const shard = visitorPresenceShard('live-session');
    presenceByChannel[buildVisitorPresenceChannelName(WS, shard)] = ['vs_live-session'];
    const res = await resolveVisitorPresence(config, WS);
    expect(presenceCalls.length).toBe(VISITOR_PRESENCE_SHARDS);
    expect(res.online.has('live-session')).toBe(true);
    expect(res.authoritative).toBe(true);
  });

  it('caches shard reads so operator polling does not fan out', async () => {
    await resolveVisitorPresence(config, WS, ['s1']);
    const first = presenceCalls.length;
    await resolveVisitorPresence(config, WS, ['s1']);
    expect(presenceCalls.length).toBe(first);
    expect(getVisitorPresenceMetrics().cache_hits).toBeGreaterThan(0);
  });

  it('falls back to the database when a shard cannot be read (never false offline)', async () => {
    const shard = visitorPresenceShard('s1');
    presenceByChannel[buildVisitorPresenceChannelName(WS, shard)] = null;
    const res = await resolveVisitorPresence(config, WS, ['s1']);
    expect(res.mode).toBe('database');
    const m = getVisitorPresenceMetrics();
    expect(m.realtime_read_failures).toBe(1);
    expect(m.fallback_activations).toBe(1);
    // The workspace stays in fallback (jittered TTL) so liveness writes resume.
    expect(await shouldWriteVisitorLiveness(config, WS)).toBe(true);
  });

  it('ignores presence subjects that are not visitor sessions', async () => {
    const shard = visitorPresenceShard('s1');
    presenceByChannel[buildVisitorPresenceChannelName(WS, shard)] = ['op_admin', 'vs_s1'];
    const res = await resolveVisitorPresence(config, WS, ['s1']);
    expect([...res.online]).toEqual(['s1']);
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

  it('multi-tab: the session stays online while ANY tab is a member', async () => {
    // Two tabs of one session are two Centrifugo clients with the SAME user
    // subject, so presence reports the subject once. Closing one tab leaves
    // the subject present.
    const shard = visitorPresenceShard('multi');
    const ch = buildVisitorPresenceChannelName(WS, shard);
    presenceByChannel[ch] = ['vs_multi', 'vs_multi'];
    const res = await resolveVisitorPresence(config, WS, ['multi']);
    expect(applyVisitorPresence(res, 'multi', 'offline', null)).toBe('online');
  });
});

describe('write discipline counters', () => {
  it('flags a liveness write that happens while realtime presence is healthy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordVisitorLivenessWrite('coalesced', 'realtime');
    recordVisitorLivenessWrite('wrote', 'database');
    expect(getVisitorPresenceMetrics().db_liveness_writes_while_realtime_healthy).toBe(0);
    recordVisitorLivenessWrite('wrote', 'realtime');
    expect(getVisitorPresenceMetrics().db_liveness_writes_while_realtime_healthy).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
