// @vitest-environment node
/**
 * The agent face's letter is the same on the visitor's launcher and in the
 * dashboard (issue #340, g5-1): GET /config (`fab.initial`, `teamMembers`,
 * server/services/widget/configSnapshot.ts) and the launcher picker / live
 * preview (src/components/app/widget/previewTeam.ts, fed by
 * /api/workspace-members and /api/availability/team) read the same rows by
 * one rule, shared/widgetTeam.ts:
 *
 *   - the same members (the first four to join), in the same order, online
 *     by the same customer availability (not the dashboard's connection
 *     state), under the same names: a nameless operator is the widget's
 *     word for an operator in its language on both sides (the dashboard
 *     used their email, /config an English "Operator" in every language);
 *   - the same letter, from those names;
 *   - no email reaches the visitor's config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';
import { previewAgentInitial, previewTeam } from '@/components/app/widget/previewTeam';
import type { WorkspaceMember } from '@/hooks/useWorkspaceMembers';
import type { OperatorPresence } from '@/hooks/useTeamPresence';
import { onlineFirst } from '../../../shared/widgetTeam';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-agent-face';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const { computeCustomerAvailability } = await import('../../../server/services/widget/customerAvailability.js');

const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
type Row = Record<string, unknown>;

interface Person { n: number; joined: string; name: string | null; available: boolean }
const id = (n: number) => `3c4d5e6f-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const prefs = (p: Person) => ({
  user_id: id(p.n), workspace_id: null, force_offline: !p.available, available_when_using_app: true,
  schedule_enabled: false, timezone: 'UTC', weekly_schedule: null,
});

/** GET /config for these people (their member rows in reverse, the profiles by id descending). */
async function visitorConfig(people: Person[], brand: string) {
  const tables = widgetScenarioTables({ edition: 'iran', ai: false, smart: false }) as Record<string, Row[]>;
  Object.assign(tables.widget_settings[0], { fab_icon: 'avatar', brand_name: brand });
  tables.workspace_members = [...people].reverse().map((p) => ({ workspace_id: WS, user_id: id(p.n), created_at: p.joined, role: 'agent' }));
  tables.profiles = [...people].sort((a, b) => b.n - a.n).map((p) => ({
    id: id(p.n), full_name: p.name, email: `person${p.n}@example.com`, avatar_storage_key: null,
  }));
  tables.user_availability_prefs = people.map(prefs);
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition: 'iran', quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Row & { fab: Row; teamMembers: Row[] };
}

/** What the dashboard reads for them: the members list (in its own order) and the team's presence, nobody connected. */
function dashboardTeam(people: Person[], locale: string) {
  const members: WorkspaceMember[] = people.map((p) => ({
    user_id: id(p.n), role: 'agent', full_name: p.name, email: `person${p.n}@example.com`, avatar_url: null, created_at: p.joined,
  }));
  const presence = people.map((p) => ({
    user_id: id(p.n),
    // Not connected: the legacy `state` says offline, visitors' availability may not.
    state: 'offline',
    presence_state: 'disconnected',
    customer_availability: computeCustomerAvailability(prefs(p) as never, new Date()).availability,
    reason: 'not_connected',
  })) as OperatorPresence[];
  return previewTeam(members, presence, locale);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-18T10:00:00Z') });
});
afterEach(() => { vi.useRealTimers(); });

const SCENARIOS: Array<{ title: string; brand: string; people: Person[]; letter: string }> = [
  {
    title: 'a nameless operator joined first and is online: «اپراتور» leads on both sides',
    brand: 'نیلوفر',
    people: [
      { n: 1, joined: '2026-10-01T09:00:00+00:00', name: null, available: true },
      { n: 2, joined: '2026-10-02T09:00:00+00:00', name: 'Reza', available: false },
      { n: 3, joined: '2026-10-03T09:00:00+00:00', name: 'سارا', available: true },
    ],
    letter: 'ا',
  },
  {
    title: 'a name pasted with an RLM before it: its first letter that shows',
    brand: 'نیلوفر',
    people: [
      { n: 1, joined: '2026-10-01T09:00:00+00:00', name: 'Reza', available: false },
      { n: 2, joined: '2026-10-02T09:00:00+00:00', name: '\u200fسارا', available: true },
    ],
    letter: 'س',
  },
  {
    title: 'five members: the fifth to join (online, named) is in neither team',
    brand: 'Acme',
    people: [
      { n: 5, joined: '2026-10-05T09:00:00+00:00', name: 'Elif', available: true },
      { n: 3, joined: '2026-10-03T09:00:00+00:00', name: 'Kian', available: false },
      { n: 1, joined: '2026-10-01T09:00:00+00:00', name: 'Mina', available: false },
      { n: 4, joined: '2026-10-04T09:00:00+00:00', name: null, available: false },
      { n: 2, joined: '2026-10-02T09:00:00+00:00', name: 'Omid', available: false },
    ],
    letter: 'M',
  },
  {
    title: 'nobody has a name: the word\'s letter on both sides',
    brand: 'وب‌سایت من',
    people: [
      { n: 1, joined: '2026-10-01T09:00:00+00:00', name: null, available: true },
      { n: 2, joined: '2026-10-02T09:00:00+00:00', name: null, available: false },
    ],
    letter: 'ا',
  },
  { title: 'no members: the workspace\'s letter', brand: 'Acme', people: [], letter: 'A' },
];

describe('the agent face: the visitor\'s launcher and the dashboard pick the same letter', () => {
  it.each(SCENARIOS)('$title', async ({ people, brand, letter }) => {
    const visitor = await visitorConfig(people, brand);
    // The Iranian edition's widget speaks Persian (as WidgetPage's effectiveLocale).
    expect(visitor.locale).toBe('fa');
    const team = dashboardTeam(people, 'fa');

    expect(visitor.fab.initial).toBe(letter);
    expect(previewAgentInitial(team, brand)).toBe(letter);
    // The same people, order and dots as the stack the preview draws.
    expect(onlineFirst(team).map(({ name, avatar, online }) => ({ name, avatar, online }))).toEqual(visitor.teamMembers);
    expect(JSON.stringify(visitor)).not.toContain('@example.com');
    expect(JSON.stringify(visitor.teamMembers)).not.toContain('Operator');
  });
});
