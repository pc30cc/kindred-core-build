/**
 * Services that enforce plan limits themselves (SEO, Web/Bot Analytics,
 * Brand Radar, AI Agent data sources, AI KB Builder) resolve every registry
 * limit exactly as GET /api/plans/workspace/:id/effective shows it:
 * workspace override ?? plan ?? registry default. They used to fill a key the
 * plan JSON left out from their own per-plan-slug tables, so a Pro plan
 * without the key was shown the registry default and enforced another number.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Info = {
  plan: { slug: string; name: string };
  subscription: null;
  entitlements: Record<string, boolean>;
  limits: Record<string, number>;
  planLimits: Record<string, number>;
  limitOverrides: Record<string, { value: number; note: string | null }>;
};

let planInfo: Info | Error;

vi.mock('../../../server/middleware/featureGating.js', () => ({
  getWorkspacePlanInfo: vi.fn(async () => {
    if (planInfo instanceof Error) throw planInfo;
    return planInfo;
  }),
  getWorkspacePlanInfoDetailed: vi.fn(async () =>
    planInfo instanceof Error ? { ok: false, errorCode: 'plan_status_unavailable', retryable: true } : { ok: true, value: planInfo }),
  checkEntitlementFromDB: vi.fn(),
}));

const { getCapability } = await import('../../../server/services/billing/capabilityRegistry.js');
const { resolveEffectiveEntitlements } = await import('../../../server/services/billing/effectiveEntitlements.js');
const seo = await import('../../../server/services/seo/limits.js');
const backlinks = await import('../../../server/services/seo/backlinksLimits.js');
const explorer = await import('../../../server/services/seo/explorerLimits.js');
const gsc = await import('../../../server/services/seo/gscLimits.js');
const keywords = await import('../../../server/services/seo/keywordsLimits.js');
const performance = await import('../../../server/services/seo/performanceLimits.js');
const rank = await import('../../../server/services/seo/rankTrackingLimits.js');
const webAnalytics = await import('../../../server/services/webAnalytics/limits.js');
const botAnalytics = await import('../../../server/services/botAnalytics/limits.js');
const brandRadar = await import('../../../server/services/brandRadar/limits.js');
const aiAgent = await import('../../../server/services/ai-agent/limits.js');
const aiKb = await import('../../../server/services/ai-kb/limits.js');

const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE' } as never;

function info(slug: string, planLimits: Record<string, number>, overrides: Record<string, number> = {}): Info {
  return {
    plan: { slug, name: slug },
    subscription: null,
    entitlements: {},
    limits: { ...planLimits, ...overrides },
    planLimits,
    limitOverrides: Object.fromEntries(Object.entries(overrides).map(([k, value]) => [k, { value, note: null }])),
  };
}

/** Each service resolver, and the registry keys it reports under the same name. */
const SERVICES: Array<{
  name: string;
  file: string;
  keys: readonly string[];
  resolve: () => Promise<{ limits: object; planSlug: string | null }>;
}> = [
  { name: 'seo crawl', file: 'server/services/seo/limits.ts', keys: seo.SEO_CRAWL_PLAN_KEYS, resolve: () => seo.resolveSeoLimits(CONFIG, 'ws') },
  { name: 'seo backlinks', file: 'server/services/seo/backlinksLimits.ts', keys: backlinks.SEO_BACKLINKS_PLAN_KEYS, resolve: () => backlinks.resolveBacklinksLimits(CONFIG, 'ws') },
  { name: 'seo explorer', file: 'server/services/seo/explorerLimits.ts', keys: explorer.SEO_EXPLORER_PLAN_KEYS, resolve: () => explorer.resolveExplorerLimits(CONFIG, 'ws') },
  { name: 'seo gsc', file: 'server/services/seo/gscLimits.ts', keys: gsc.SEO_GSC_PLAN_KEYS, resolve: () => gsc.resolveGscLimits(CONFIG, 'ws') },
  { name: 'seo keywords', file: 'server/services/seo/keywordsLimits.ts', keys: keywords.SEO_KEYWORDS_PLAN_KEYS, resolve: () => keywords.resolveKeywordsLimits(CONFIG, 'ws') },
  { name: 'seo performance', file: 'server/services/seo/performanceLimits.ts', keys: performance.SEO_PERFORMANCE_PLAN_KEYS, resolve: () => performance.resolvePerformanceLimits(CONFIG, 'ws') },
  { name: 'seo rank tracking', file: 'server/services/seo/rankTrackingLimits.ts', keys: rank.SEO_RANK_TRACKING_PLAN_KEYS, resolve: () => rank.resolveRankTrackingLimits(CONFIG, 'ws') },
  { name: 'web analytics', file: 'server/services/webAnalytics/limits.ts', keys: webAnalytics.WEB_ANALYTICS_PLAN_KEYS, resolve: () => webAnalytics.resolveWebAnalyticsLimits(CONFIG, 'ws') },
  { name: 'bot analytics', file: 'server/services/botAnalytics/limits.ts', keys: botAnalytics.BOT_ANALYTICS_PLAN_KEYS, resolve: () => botAnalytics.resolveBotAnalyticsLimits(CONFIG, 'ws') },
  { name: 'brand radar', file: 'server/services/brandRadar/limits.ts', keys: brandRadar.BRAND_RADAR_PLAN_KEYS, resolve: () => brandRadar.resolveBrandRadarLimits(CONFIG, 'ws') },
];

const ALL_REGISTRY_KEYS = [
  ...SERVICES.flatMap((s) => s.keys),
  ...aiAgent.AI_AGENT_DATA_PLAN_KEYS,
  ...aiKb.AI_KB_BUILDER_PLAN_KEYS,
];

/** A plan that sets every key to a distinct value. */
function everyKeySet(): Record<string, number> {
  return Object.fromEntries(ALL_REGISTRY_KEYS.map((key, i) => [key, 1000 + i]));
}

beforeEach(() => {
  planInfo = info('pro', {});
});

describe('service limit keys', () => {
  it('are registry limits with a numeric default', () => {
    for (const key of ALL_REGISTRY_KEYS) {
      const cap = getCapability(key);
      expect(cap?.type, key).toBe('limit');
      expect(typeof cap?.defaultValue, key).toBe('number');
    }
  });

  it('have no per-plan fallback number left in the service source', () => {
    for (const service of [...SERVICES, { file: 'server/services/ai-agent/limits.ts', keys: aiAgent.AI_AGENT_DATA_PLAN_KEYS }]) {
      const src = readFileSync(resolve(process.cwd(), service.file), 'utf8');
      for (const key of service.keys) {
        expect(src, `${service.file}: ${key}`).not.toMatch(new RegExp(`\\b${key}\\s*:\\s*-?\\d`));
      }
    }
  });
});

describe.each(SERVICES)('$name limits', (service) => {
  const pick = (limits: object) => Object.fromEntries(service.keys.map((k) => [k, (limits as Record<string, number>)[k]]));
  const effective = (i: Info) =>
    Object.fromEntries(service.keys.map((k) => [k, resolveEffectiveEntitlements(i, [], []).limits[k].value]));

  it('a paid plan without the keys gets the registry defaults, as /effective shows', async () => {
    for (const slug of ['free', 'pro', 'business', 'enterprise']) {
      planInfo = info(slug, {});
      const out = await service.resolve();
      expect(pick(out.limits)).toEqual(Object.fromEntries(service.keys.map((k) => [k, getCapability(k)!.defaultValue])));
      expect(pick(out.limits)).toEqual(effective(planInfo));
    }
  });

  it('keeps every value the plan sets', async () => {
    const planLimits = everyKeySet();
    planInfo = info('pro', planLimits);
    const out = await service.resolve();
    expect(pick(out.limits)).toEqual(Object.fromEntries(service.keys.map((k) => [k, planLimits[k]])));
  });

  it('lets a workspace override win over the plan, as /effective does', async () => {
    const [first] = service.keys;
    planInfo = info('pro', everyKeySet(), { [first]: 7 });
    const out = await service.resolve();
    expect((out.limits as Record<string, number>)[first]).toBe(7);
    expect(pick(out.limits)).toEqual(effective(planInfo));
  });

  it('falls back to the registry defaults as the Free plan when the plan cannot be read', async () => {
    planInfo = new Error('free_plan_not_found');
    const out = await service.resolve();
    expect(out.planSlug).toBe('free');
    expect(pick(out.limits)).toEqual(Object.fromEntries(service.keys.map((k) => [k, getCapability(k)!.defaultValue])));
  });
});

describe('SEO crawl tuning knobs (not registry capabilities)', () => {
  it('keep their per-plan fallback, and a plan value still wins', async () => {
    expect(getCapability('seo_max_duration_seconds')).toBeUndefined();
    planInfo = info('pro', {});
    expect((await seo.resolveSeoLimits(CONFIG, 'ws')).limits.seo_max_duration_seconds).toBe(1800);
    planInfo = info('free', {});
    expect((await seo.resolveSeoLimits(CONFIG, 'ws')).limits.seo_max_duration_seconds).toBe(300);
    planInfo = info('pro', { seo_max_duration_seconds: 42 });
    expect((await seo.resolveSeoLimits(CONFIG, 'ws')).limits.seo_max_duration_seconds).toBe(42);
  });
});

describe('GET /api/billing/entitlement (checkEntitlement)', () => {
  it('answers with the enforcement check, registry default included', async () => {
    const gating = await import('../../../server/middleware/featureGating.js');
    const { checkEntitlement } = await import('../../../server/services/billing/index.js');
    const check = vi.mocked(gating.checkEntitlementFromDB);

    check.mockResolvedValueOnce({ allowed: true, plan: 'pro', reason: 'registry_default' });
    await expect(checkEntitlement('u', 'k', 'ws', 'knowledge_base')).resolves.toEqual({ allowed: true });
    expect(check).toHaveBeenLastCalledWith('u', 'k', 'ws', 'knowledge_base');

    check.mockResolvedValueOnce({ allowed: true, limit: 25, limitValid: true, plan: 'pro' });
    await expect(checkEntitlement('u', 'k', 'ws', 'max_agents')).resolves.toEqual({ allowed: true, limit: 25 });

    check.mockResolvedValueOnce({ allowed: false, plan: 'error', reason: 'rpc_error' });
    await expect(checkEntitlement('u', 'k', 'ws', 'sso')).resolves.toEqual({ allowed: false });
  });
});
