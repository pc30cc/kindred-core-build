/**
 * The server side of the routing panel (package A, stage 3):
 *
 *   - GET /api/availability's banner status is the customer-facing resolver
 *     itself (R-07): with "Show me as available to visitors" off the
 *     operator is invisible whatever the schedule says (the banner used to
 *     follow the schedule and say "Online"); the reason codes the macOS app
 *     reads (outside_schedule, day_disabled) are kept;
 *   - GET /api/workspace-departments/:id/routing-policy hands the workspace
 *     panel the Super Admin's platform rules as chat routing reads them
 *     (general pool, returning visitors, owner fallback for chats), defaults
 *     on, owner/admin only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({
  prefs: null as Record<string, unknown> | null,
  global: null as Record<string, unknown> | null,
  manage: true,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order']) b[m] = () => b;
      b.maybeSingle = async () => ({
        data: table === 'user_availability_prefs'
          ? state.prefs
          : table === 'app_runtime_config'
            ? (state.global ? { value: state.global } : null)
            : null,
        error: null,
      });
      return b;
    },
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>();
  return {
    ...actual,
    requireUser: async () => 'user-1',
    authorizeWorkspaceAccess: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      if (!state.manage) {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      return { userId: 'user-1', role: 'owner' };
    },
    serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  };
});

const { availabilityRouter, computeLiveStatus } = await import('../../../server/routes/availability.js');
const { workspaceDepartmentsRouter } = await import('../../../server/routes/workspaceDepartments.js');
const { computeCustomerAvailability } = await import('../../../server/services/widget/customerAvailability.js');
const { __resetGlobalAdvancedRoutingCache } = await import('../../../server/services/calls/globalAdvancedRouting.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
    next();
  });
  a.use('/api/availability', availabilityRouter);
  a.use('/api/workspace-departments', workspaceDepartmentsRouter);
  return a;
}

// Wednesday 2026-10-21 10:00 UTC.
const NOW = new Date('2026-10-21T10:00:00Z');
const WEEK = {
  mon: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  tue: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  wed: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  thu: { enabled: false, intervals: [] },
  fri: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  sat: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  sun: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
};

function prefs(over: Record<string, unknown> = {}) {
  return {
    force_offline: false,
    available_when_using_app: true,
    schedule_enabled: true,
    timezone: 'UTC',
    weekly_schedule: WEEK,
    ...over,
  };
}

beforeEach(() => {
  state.prefs = null;
  state.global = null;
  state.manage = true;
  __resetGlobalAdvancedRoutingCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

describe('GET /api/availability — the "You are currently seen as" banner (R-07)', () => {
  it('"Show me as available" off is invisible even within the schedule (it used to say Online)', async () => {
    state.prefs = prefs({ available_when_using_app: false });
    const res = await request(app()).get('/api/availability');
    expect(res.status).toBe(200);
    expect(res.body.status).toEqual({ state: 'offline', reason: 'unavailable_when_using_app' });
  });

  it('on and within the schedule: online; outside it or on a day off: offline with the codes the macOS app reads', async () => {
    state.prefs = prefs();
    expect((await request(app()).get('/api/availability')).body.status).toEqual({ state: 'online', reason: 'within_schedule' });

    vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
    expect((await request(app()).get('/api/availability')).body.status).toEqual({ state: 'offline', reason: 'outside_schedule' });

    vi.setSystemTime(new Date('2026-10-22T10:00:00Z')); // Thursday, off
    expect((await request(app()).get('/api/availability')).body.status).toEqual({ state: 'offline', reason: 'day_disabled' });
  });

  it('no schedule: available around the clock; force offline overrides everything', async () => {
    state.prefs = prefs({ schedule_enabled: false });
    expect((await request(app()).get('/api/availability')).body.status).toEqual({ state: 'online', reason: 'available_when_using_app' });
    state.prefs = prefs({ force_offline: true });
    expect((await request(app()).get('/api/availability')).body.status).toEqual({ state: 'offline', reason: 'force_offline' });
  });

  it('agrees with the resolver the widget and routing read, for every combination', () => {
    for (const force_offline of [false, true]) {
      for (const available_when_using_app of [false, true]) {
        for (const schedule_enabled of [false, true]) {
          for (const at of ['2026-10-21T10:00:00Z', '2026-10-21T20:00:00Z', '2026-10-22T10:00:00Z']) {
            const p = prefs({ force_offline, available_when_using_app, schedule_enabled });
            const now = new Date(at);
            const banner = computeLiveStatus(p as Parameters<typeof computeLiveStatus>[0], now);
            const widget = computeCustomerAvailability(p, now);
            expect(banner.state === 'online').toBe(widget.availability === 'available');
          }
        }
      }
    }
  });
});

describe('GET /api/workspace-departments/:id/routing-policy', () => {
  it('nothing stored: every platform rule on', async () => {
    const res = await request(app()).get('/api/workspace-departments/ws-1/routing-policy');
    expect(res.status).toBe(200);
    expect(res.body.policy).toEqual({
      general_pool_enabled: true,
      last_agent_routing_enabled: true,
      owner_fallback_for_chat: true,
    });
  });

  it('what the Super Admin turned off, as chat routing reads it', async () => {
    state.global = { general_pool_enabled: false, last_agent_routing_enabled: false, owner_fallback_for_chat: true };
    let res = await request(app()).get('/api/workspace-departments/ws-1/routing-policy');
    expect(res.body.policy).toEqual({
      general_pool_enabled: false,
      last_agent_routing_enabled: false,
      owner_fallback_for_chat: true,
    });

    // The master owner-fallback switch closes the chat one too.
    __resetGlobalAdvancedRoutingCache();
    state.global = { owner_fallback_enabled: false, owner_fallback_for_chat: true };
    res = await request(app()).get('/api/workspace-departments/ws-1/routing-policy');
    expect(res.body.policy.owner_fallback_for_chat).toBe(false);
  });

  it('owner and admin only', async () => {
    state.manage = false;
    const res = await request(app()).get('/api/workspace-departments/ws-1/routing-policy');
    expect(res.status).toBe(403);
  });
});
