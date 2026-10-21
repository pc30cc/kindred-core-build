// @vitest-environment node
/**
 * widgetBusinessHoursAllowed (server/services/widget/entitlements.ts): the
 * plan's answer for `widget_business_hours` alone, for the availability
 * resolver's callers that hold no widget snapshot and the panel's "Now"
 * card. A readable denial is false; an allowance true; a plan that never
 * heard of the key its registry default (true); an unreadable answer null
 * (never a denial: availability must not flip on a blip).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;
const { widgetBusinessHoursAllowed } = await import('../../../server/services/widget/entitlements.js');
const { clearEntitlementCache } = await import('../../../server/middleware/featureGating.js');

function answer(data: unknown, error: unknown = null) {
  holder.db = createFakeDb({}, { rpc: (fn) => (fn === 'check_workspace_entitlement' ? { data, error } : { data: null, error: null }) });
}

beforeEach(() => clearEntitlementCache());

describe('widgetBusinessHoursAllowed', () => {
  it('allowed: true; denied: false', async () => {
    answer({ allowed: true, plan: 'pro' });
    expect(await widgetBusinessHoursAllowed(config, 'ws-a')).toBe(true);
    answer({ allowed: false, plan: 'free', reason: 'feature_disabled' });
    expect(await widgetBusinessHoursAllowed(config, 'ws-b')).toBe(false);
  });

  it('a plan that never mentions the key: the registry default (on)', async () => {
    answer({ allowed: false, plan: 'legacy', reason: 'feature_not_in_plan' });
    expect(await widgetBusinessHoursAllowed(config, 'ws-c')).toBe(true);
  });

  it('an unreadable answer is null, not a denial', async () => {
    answer(null, { message: 'boom' });
    expect(await widgetBusinessHoursAllowed(config, 'ws-d')).toBeNull();
    answer('nonsense');
    expect(await widgetBusinessHoursAllowed(config, 'ws-e')).toBeNull();
  });
});
