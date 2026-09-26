/**
 * One answer to "what does this workspace have", wherever it is asked.
 *
 *  - planSelection.ts picks the plan for GET /effective; the hosted
 *    check_workspace_entitlement picks it for enforcement. Same statuses.
 *  - A key a plan never mentions takes its registry default in enforcement
 *    (featureGating over the RPCs) exactly as /effective shows it.
 *  - /effective resolves override ?? plan ?? default and hands members only
 *    the plan/subscription fields they may see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpcMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => rpcMock(name, args),
  }),
}));

import { assignedPlanApplies } from '../../../server/services/billing/planSelection';
import {
  checkEntitlementFromDB,
  checkModuleAccess,
  checkChannelAccess,
  clearEntitlementCache,
  REGISTRY_DEFAULT,
  SELF_HOST_UNLIMITED,
} from '../../../server/middleware/featureGating';
import {
  resolveEffectiveEntitlements,
  planFlag,
  publicPlan,
  publicSubscription,
  unlimitedEntitlements,
} from '../../../server/services/billing/effectiveEntitlements';
import { isRelationMissing } from '../../../server/services/billing/entitlementParse';
import { getCapability } from '../../../server/services/billing/capabilityRegistry';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const FUTURE = '2026-10-25T12:00:00Z';
const PAST = '2026-08-25T12:00:00Z';

describe('which plan applies (planSelection.ts)', () => {
  const sub = (s: Record<string, unknown>) => ({ plan_id: 'p1', ...s });

  it('keeps the assigned plan while it is paid for', () => {
    expect(assignedPlanApplies(sub({ status: 'active' }), NOW)).toBe(true);
    expect(assignedPlanApplies(sub({ status: 'trialing', trial_end: FUTURE }), NOW)).toBe(true);
    expect(assignedPlanApplies(sub({ status: 'trialing', trial_end: null }), NOW)).toBe(true);
    expect(assignedPlanApplies(sub({ status: 'canceled', cancel_at_period_end: true, current_period_end: FUTURE }), NOW)).toBe(true);
  });

  it('keeps it through the Billing V2 grace period, not after the fallback', () => {
    expect(assignedPlanApplies(sub({ status: 'past_due' }), NOW)).toBe(true);
    expect(assignedPlanApplies(sub({ status: 'past_due', free_fallback_at: PAST }), NOW)).toBe(false);
    expect(assignedPlanApplies(sub({ status: 'free_fallback', free_fallback_at: PAST }), NOW)).toBe(false);
  });

  it('drops to Free when the trial or the paid period is over', () => {
    expect(assignedPlanApplies(sub({ status: 'expired' }), NOW)).toBe(false);
    expect(assignedPlanApplies(sub({ status: 'trialing', trial_end: PAST }), NOW)).toBe(false);
    expect(assignedPlanApplies(sub({ status: 'canceled', cancel_at_period_end: true, current_period_end: PAST }), NOW)).toBe(false);
    expect(assignedPlanApplies(sub({ status: 'canceled', cancel_at_period_end: false, current_period_end: FUTURE }), NOW)).toBe(false);
    expect(assignedPlanApplies({ status: 'active', plan_id: null }, NOW)).toBe(false);
    expect(assignedPlanApplies(null, NOW)).toBe(false);
  });

  it('is the rule the hosted check_workspace_entitlement enforces', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260925120000_entitlement_plan_selection.sql'),
      'utf8',
    );
    expect(sql).toContain("_sub.status = 'active'");
    expect(sql).toContain("_sub.status = 'past_due' AND _sub.free_fallback_at IS NULL");
    expect(sql).toContain("_sub.status = 'trialing' AND (_sub.trial_end IS NULL OR _sub.trial_end > now())");
    expect(sql).toMatch(/_sub\.status IN \('canceled', 'cancelled'\)\s+AND _sub\.cancel_at_period_end IS TRUE\s+AND _sub\.current_period_end > now\(\)/);
    // A plan row that is gone falls back to Free rather than denying everything.
    expect(sql).toContain('_sub_valid := FOUND;');
  });
});

describe('a key the plan never mentions takes its registry default in enforcement', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    clearEntitlementCache();
  });

  const notInPlan = { data: { allowed: false, plan: 'pro', reason: 'feature_not_in_plan' }, error: null };

  it('boolean capabilities follow the registry default', async () => {
    rpcMock.mockResolvedValue(notInPlan);
    expect(getCapability('contact_create')?.defaultValue).toBe(true);
    const on = await checkEntitlementFromDB('u', 'k', 'ws-a', 'contact_create');
    expect(on).toMatchObject({ allowed: true, reason: REGISTRY_DEFAULT });
    const off = await checkEntitlementFromDB('u', 'k', 'ws-a', 'ai_operator_assist');
    expect(off).toMatchObject({ allowed: false, reason: REGISTRY_DEFAULT });
  });

  it('limits take the registry default value, -1 meaning unlimited', async () => {
    rpcMock.mockResolvedValue(notInPlan);
    const contacts = await checkEntitlementFromDB('u', 'k', 'ws-b', 'max_contacts', { numeric: true });
    expect(contacts).toMatchObject({ allowed: true, limit: getCapability('max_contacts')?.defaultValue, limitValid: true });
    const calls = await checkEntitlementFromDB('u', 'k', 'ws-b', 'max_concurrent_calls', { numeric: true });
    expect(calls).toMatchObject({ allowed: true, limit: -1 });
  });

  it('keys the registry does not know stay denied', async () => {
    rpcMock.mockResolvedValue(notInPlan);
    const legacy = await checkEntitlementFromDB('u', 'k', 'ws-c', 'team_members');
    expect(legacy).toMatchObject({ allowed: false, reason: 'feature_not_in_plan' });
  });

  it('a plan that says no is still no', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: 'free' }, error: null });
    const denied = await checkEntitlementFromDB('u', 'k', 'ws-d', 'contact_create');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).not.toBe(REGISTRY_DEFAULT);
  });

  it('modules and channels: a plan denial of a key the plan never mentions becomes the default', async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'check_module_access') return { data: { allowed: false, source: 'plan', plan: 'pro' }, error: null };
      if (name === 'check_channel_access') return { data: { allowed: false, source: 'plan', plan: 'pro' }, error: null };
      return notInPlan;
    });
    expect(await checkModuleAccess('u', 'k', 'ws-e', 'contacts')).toMatchObject({ allowed: true, reason: REGISTRY_DEFAULT });
    expect(await checkModuleAccess('u', 'k', 'ws-e', 'email_inbox')).toMatchObject({ allowed: false });
    expect(await checkChannelAccess('u', 'k', 'ws-e', 'chat_widget')).toMatchObject({ allowed: true, reason: REGISTRY_DEFAULT });
    expect(await checkChannelAccess('u', 'k', 'ws-e', 'telegram')).toMatchObject({ allowed: false });
  });

  it('modules and channels: an override or an explicit plan value is final', async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'check_module_access') return { data: { allowed: false, source: 'override' }, error: null };
      if (name === 'check_channel_access') return { data: { allowed: false, source: 'plan', plan: 'pro' }, error: null };
      return { data: { allowed: false, plan: 'pro' }, error: null };
    });
    expect((await checkModuleAccess('u', 'k', 'ws-f', 'contacts')).allowed).toBe(false);
    expect((await checkChannelAccess('u', 'k', 'ws-f', 'chat_widget')).allowed).toBe(false);
  });

  it('an unreadable module answer is still an outage, not a default', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const r = await checkModuleAccess('u', 'k', 'ws-g', 'contacts');
    expect(r).toMatchObject({ allowed: false, reason: 'rpc_error' });
  });
});

describe('the effective snapshot', () => {
  const info = {
    entitlements: { contacts: false, widget_emoji: 'false', inbox_ai_queue: true } as unknown as Record<string, boolean>,
    planLimits: { max_contacts: 500 },
    limitOverrides: { max_agents: { value: 9, note: 'deal' } },
  };

  it('resolves override ?? plan ?? registry default for every registry key', () => {
    const eff = resolveEffectiveEntitlements(
      info,
      [{ module_key: 'call_center', enabled: true, admin_notes: 'pilot' }],
      [{ channel_key: 'telegram', enabled: true }],
    );
    expect(eff.modules.contacts).toEqual({ value: false, source: 'plan' });
    expect(eff.modules.call_center).toEqual({ value: true, source: 'override', note: 'pilot' });
    expect(eff.modules.visitor_tracking).toEqual({ value: true, source: 'default' });
    expect(eff.channels.telegram.value).toBe(true);
    expect(eff.channels.whatsapp).toEqual({ value: false, source: 'default' });
    // The JSON string "false" is false, as Postgres reads it.
    expect(eff.features.widget_emoji).toEqual({ value: false, source: 'plan' });
    expect(eff.features.inbox_ai_queue).toEqual({ value: true, source: 'plan' });
    expect(eff.limits.max_contacts).toMatchObject({ value: 500, source: 'plan' });
    expect(eff.limits.max_agents).toMatchObject({ value: 9, source: 'override', note: 'deal' });
    expect(eff.limits.max_concurrent_calls).toMatchObject({ value: -1, source: 'default' });
  });

  it('reads the legacy KB article keys enforcement falls back to', () => {
    const legacy = resolveEffectiveEntitlements({ entitlements: {}, planLimits: { kb_articles: 40 }, limitOverrides: {} }, [], []);
    expect(legacy.limits.max_kb_articles).toMatchObject({ value: 40, source: 'plan' });
    const canonical = resolveEffectiveEntitlements({ entitlements: {}, planLimits: { kb_articles: 40, max_kb_articles: 7 }, limitOverrides: {} }, [], []);
    expect(canonical.limits.max_kb_articles).toMatchObject({ value: 7, source: 'plan' });
  });

  it('reads plan JSON values the way the RPC casts them', () => {
    expect(planFlag(true)).toBe(true);
    expect(planFlag('true')).toBe(true);
    expect(planFlag('false')).toBe(false);
    expect(planFlag(0)).toBe(false);
    expect(planFlag(null)).toBe(false);
  });

  it('never hands a member provider ids or internal metadata', () => {
    const plan = publicPlan({
      id: 'p1', name: 'Pro', slug: 'pro', is_free: false, localized: { fa: { name: 'حرفه‌ای' } },
      entitlements: {}, limits: {},
      ...({ provider_price_ids: { stripe: 'price_x' }, metadata: { internal: 1 } } as Record<string, unknown>),
    });
    expect(Object.keys(plan).sort()).toEqual(['description', 'id', 'is_free', 'localized', 'name', 'slug']);
    const sub = publicSubscription({
      status: 'active', plan_id: 'p1',
      ...({ provider_subscription_id: 'sub_x', provider_customer_id: 'cus_x', metadata: { a: 1 } } as Record<string, unknown>),
    });
    expect(sub).not.toHaveProperty('provider_subscription_id');
    expect(sub).not.toHaveProperty('provider_customer_id');
    expect(sub).not.toHaveProperty('metadata');
    expect(sub).toMatchObject({ status: 'active', plan_id: 'p1' });
    expect(publicSubscription(null)).toBeNull();
  });
});

describe('a self-host install without the billing subsystem', () => {
  const missing = (fn: string) => ({
    data: null,
    error: { code: 'PGRST202', message: `Could not find the function public.${fn}(_workspace_id, _feature) in the schema cache` },
  });

  beforeEach(() => {
    rpcMock.mockReset();
    clearEntitlementCache();
    rpcMock.mockImplementation(async (name: string) => missing(name));
  });

  it('allows modules and channels, as it already allowed features and limits', async () => {
    const opts = { selfHostBillingUnlimited: true };
    expect(await checkModuleAccess('u', 'k', 'ws-sh', 'contacts', opts)).toMatchObject({ allowed: true, reason: SELF_HOST_UNLIMITED });
    expect(await checkChannelAccess('u', 'k', 'ws-sh', 'telegram', opts)).toMatchObject({ allowed: true, reason: SELF_HOST_UNLIMITED });
  });

  it('stays fail-closed without the explicit deployment flag', async () => {
    const r = await checkModuleAccess('u', 'k', 'ws-sh2', 'contacts');
    expect(r.allowed).toBe(false);
    expect(r.reason).not.toBe(SELF_HOST_UNLIMITED);
  });

  it('is shown every section, with no limits', () => {
    const snap = unlimitedEntitlements();
    expect(Object.values(snap.modules).every((m) => m.value === true)).toBe(true);
    expect(Object.values(snap.channels).every((c) => c.value === true)).toBe(true);
    expect(Object.values(snap.features).every((f) => f.value === true)).toBe(true);
    expect(Object.values(snap.limits).every((l) => l.value === -1)).toBe(true);
  });

  it('treats only an absent override table as "no overrides"', () => {
    const absent = { code: 'PGRST205', message: "Could not find the table 'public.workspace_limit_overrides' in the schema cache" };
    expect(isRelationMissing(absent, 'workspace_limit_overrides')).toBe(true);
    expect(isRelationMissing(absent, 'workspace_module_overrides')).toBe(false);
    expect(isRelationMissing({ code: '42P01', message: 'relation "public.workspace_module_overrides" does not exist' }, 'workspace_module_overrides')).toBe(true);
    expect(isRelationMissing({ code: '57014', message: 'canceling statement due to statement timeout' }, 'workspace_limit_overrides')).toBe(false);
    expect(isRelationMissing({ code: '42501', message: 'permission denied for table workspace_limit_overrides' }, 'workspace_limit_overrides')).toBe(false);
  });
});

