/**
 * Follow-up 2 (Phase 7 finding) — AI Agent vs AI KB Builder plan-limit key
 * collision.
 *
 * server/services/ai-agent/limits.ts::resolveAiAgentDataLimits() (gates the
 * AI Agent's own "Web Pages" Data Hub source ingestion, consumed by
 * sourceWorker.ts and server/routes/ai-agent/knowledge.ts) and
 * server/services/ai-kb/limits.ts::resolveAiKbLimits() (gates the separate
 * AI KB Builder feature, consumed by server/routes/aiKb.ts) both read the
 * SAME three literal `billing_plans.limits` JSON keys --
 * `ai_kb_max_pages` / `ai_kb_max_depth` / `ai_kb_jobs_per_month` -- despite
 * ai-agent/limits.ts's own docstring claiming they are "distinct... so
 * admins can tune them independently." They are not: this file proves the
 * collision at the lowest deterministic layer (the two pure resolver
 * functions, with `getWorkspacePlanInfo` mocked) and then pins the fix's
 * required independence + backward-compatibility matrix.
 *
 * `ai-kb/limits.ts` is the historical/canonical owner of these three keys
 * (see docs/PLAN_DATA_RECONCILIATION.md rows 92-94, marking them
 * "canonical -- OK", and the origin seed migration
 * 20260428072256_c9c03988-...sql, which seeds max_pages/max_depth/
 * jobs_per_month together with the AI-KB-Builder-only max_articles/
 * max_chars/monthly_credits as one coherent block) and is therefore left
 * completely untouched by the fix. AI Agent gets new, explicitly-named
 * keys with a legacy fallback to the historical shared key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let planInfo: {
  plan: { slug: string; name: string };
  subscription: Record<string, unknown>;
  entitlements: Record<string, boolean>;
  limits: Record<string, number>;
  planLimits: Record<string, number>;
  limitOverrides: Record<string, { value: number; note: string | null }>;
};

vi.mock('../../../server/middleware/featureGating.js', () => ({
  getWorkspacePlanInfo: async () => planInfo,
  getWorkspacePlanInfoDetailed: async () => ({ ok: true, value: planInfo }),
}));

const { resolveAiAgentDataLimits } = await import('../../../server/services/ai-agent/limits.js');
const { resolveAiKbLimits } = await import('../../../server/services/ai-kb/limits.js');
const { resolveEffectiveEntitlements } = await import('../../../server/services/billing/effectiveEntitlements.js');

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
} as unknown as Parameters<typeof resolveAiKbLimits>[0];

function makePlanInfo(limits: Record<string, number>, slug = 'pro', overrides: Record<string, number> = {}) {
  return {
    plan: { slug, name: 'Pro' },
    subscription: {},
    entitlements: {},
    limits: { ...limits, ...overrides },
    planLimits: limits,
    limitOverrides: Object.fromEntries(Object.entries(overrides).map(([k, value]) => [k, { value, note: null }])),
  };
}

beforeEach(() => {
  planInfo = makePlanInfo({});
});

describe('Collision characterization — shared legacy key currently couples both products', () => {
  it('setting only the shared ai_kb_max_pages key: both resolvers observe the same value', async () => {
    planInfo = makePlanInfo({ ai_kb_max_pages: 42, ai_kb_max_depth: 7, ai_kb_jobs_per_month: 9 });

    const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');
    const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

    expect(agent.limits.ai_kb_max_pages).toBe(42);
    expect(builder.limits.maxPages).toBe(42);
    expect(agent.limits.ai_kb_max_depth).toBe(7);
    expect(builder.limits.maxDepth).toBe(7);
    expect(agent.limits.ai_kb_jobs_per_month).toBe(9);
    expect(builder.limits.jobsPerMonth).toBe(9);
  });
});

describe('L1/L4 — AI Agent-specific key overrides the shared legacy key for AI Agent only', () => {
  it('a distinct AI-Agent-only value must not be silently ignored in favor of the shared key', async () => {
    // Plan admin sets a DIFFERENT value intended only for AI Agent's Web
    // Pages ingestion, while AI KB Builder's historical key stays at its
    // existing value. Before the fix, resolveAiAgentDataLimits() has no
    // concept of an AI-Agent-specific key at all, so it falls through to
    // the shared `ai_kb_max_pages` (100) instead of the intended 250 --
    // this assertion FAILS on current (pre-fix) code.
    planInfo = makePlanInfo({
      ai_kb_max_pages: 100,
      ai_agent_web_source_max_pages: 250,
      ai_kb_max_depth: 3,
      ai_agent_web_source_max_depth: 6,
      ai_kb_jobs_per_month: 10,
      ai_agent_web_source_jobs_per_month: 40,
    });

    const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');
    const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

    expect(agent.limits.ai_kb_max_pages).toBe(250);
    expect(agent.limits.ai_kb_max_depth).toBe(6);
    expect(agent.limits.ai_kb_jobs_per_month).toBe(40);
    // L7 — AI KB Builder's historical key is completely unaffected by the
    // new AI-Agent-only key existing alongside it.
    expect(builder.limits.maxPages).toBe(100);
    expect(builder.limits.maxDepth).toBe(3);
    expect(builder.limits.jobsPerMonth).toBe(10);
  });
});

describe('L2 — AI KB Builder reads its own historical key, unaffected by an AI-Agent-only key', () => {
  it('AI KB Builder never reads the new ai_agent_web_source_* keys', async () => {
    planInfo = makePlanInfo({
      ai_kb_max_pages: 17,
      ai_agent_web_source_max_pages: 999,
    });

    const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

    expect(builder.limits.maxPages).toBe(17);
  });
});

describe('L3 — legacy plan compatibility (plan has ONLY the historical shared key)', () => {
  it('a plan configured before this fix (no ai_agent_web_source_* keys at all) preserves the exact previous effective limit for AI Agent', async () => {
    planInfo = makePlanInfo({ ai_kb_max_pages: 500, ai_kb_max_depth: 3, ai_kb_jobs_per_month: 20 });

    const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');
    const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

    expect(agent.limits.ai_kb_max_pages).toBe(500);
    expect(agent.limits.ai_kb_max_depth).toBe(3);
    expect(agent.limits.ai_kb_jobs_per_month).toBe(20);
    expect(builder.limits.maxPages).toBe(500);
    expect(builder.limits.maxDepth).toBe(3);
    expect(builder.limits.jobsPerMonth).toBe(20);
  });
});

describe('L5 — absent keys take the registry default, exactly as GET /effective shows them', () => {
  it('AI Agent: a Pro plan without the keys gets the registry defaults, not a per-plan table', async () => {
    planInfo = makePlanInfo({}, 'pro');

    const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');

    expect(agent.limits.ai_kb_max_pages).toBe(50);
    expect(agent.limits.ai_kb_max_depth).toBe(2);
    expect(agent.limits.ai_kb_jobs_per_month).toBe(5);
    expect(agent.limits.ai_kb_file_count).toBe(20);
    expect(agent.limits.ai_kb_file_size_mb).toBe(10);
  });

  it('AI KB Builder: registry keys take the registry default; the unregistered legacy keys keep their per-plan fallback', async () => {
    planInfo = makePlanInfo({}, 'pro');

    const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

    expect(builder.limits.maxPages).toBe(50);
    expect(builder.limits.maxDepth).toBe(2);
    expect(builder.limits.jobsPerMonth).toBe(5);
    expect(builder.limits.maxArticles).toBe(30);
    expect(builder.limits.maxChars).toBe(100_000);
    expect(builder.limits.monthlyCredits).toBe(200);
  });

  it('both resolvers agree with the /effective snapshot for every plan shape', async () => {
    const shapes = [
      makePlanInfo({}, 'pro'),
      makePlanInfo({ ai_kb_max_pages: 500, ai_kb_max_depth: 3, ai_kb_jobs_per_month: 20 }, 'business'),
      makePlanInfo({ ai_kb_max_pages: 100, ai_agent_web_source_max_pages: 250, ai_kb_file_count: 7 }, 'free'),
      makePlanInfo({ ai_kb_max_pages: 100 }, 'pro', { ai_agent_web_source_max_pages: 9, ai_kb_max_depth: 4 }),
    ];
    for (const shape of shapes) {
      planInfo = shape;
      const effective = resolveEffectiveEntitlements(shape, [], []).limits;
      const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');
      const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

      expect(agent.limits.ai_kb_max_pages).toBe(effective.ai_agent_web_source_max_pages.value);
      expect(agent.limits.ai_kb_max_depth).toBe(effective.ai_agent_web_source_max_depth.value);
      expect(agent.limits.ai_kb_jobs_per_month).toBe(effective.ai_agent_web_source_jobs_per_month.value);
      expect(agent.limits.ai_kb_file_count).toBe(effective.ai_kb_file_count.value);
      expect(agent.limits.ai_kb_file_size_mb).toBe(effective.ai_kb_file_size_mb.value);
      expect(builder.limits.maxPages).toBe(effective.ai_kb_max_pages.value);
      expect(builder.limits.maxDepth).toBe(effective.ai_kb_max_depth.value);
      expect(builder.limits.jobsPerMonth).toBe(effective.ai_kb_jobs_per_month.value);
    }
  });

  it('a workspace override wins over the plan for the key it names', async () => {
    planInfo = makePlanInfo({ ai_agent_web_source_max_pages: 250, ai_kb_max_depth: 3 }, 'pro', {
      ai_agent_web_source_max_pages: 9,
      ai_kb_max_depth: 4,
    });

    const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');
    const builder = await resolveAiKbLimits(CONFIG, 'ws-1');

    expect(agent.limits.ai_kb_max_pages).toBe(9);
    expect(builder.limits.maxDepth).toBe(4);
    // The AI KB Builder override is not the AI Agent's key: the agent reads
    // the plan's shared key (its legacy alias), not the builder's override.
    expect(agent.limits.ai_kb_max_depth).toBe(3);
  });
});

describe('AI Agent file-ingestion keys were never part of the collision (unchanged, no fallback needed)', () => {
  it('ai_kb_file_count / ai_kb_file_size_mb are AI-Agent-exclusive and remain read directly', async () => {
    planInfo = makePlanInfo({ ai_kb_file_count: 77, ai_kb_file_size_mb: 33 });

    const agent = await resolveAiAgentDataLimits(CONFIG, 'ws-1');

    expect(agent.limits.ai_kb_file_count).toBe(77);
    expect(agent.limits.ai_kb_file_size_mb).toBe(33);
  });
});
