/**
 * Phase 6-S5-R2 — Knowledge Base authorization, ownership invariants and
 * durable outbox guarantees.
 *
 * Two layers:
 *  1. Static invariants (always run) — the code paths that enforce
 *     permissions, module gates and atomic leases must not regress.
 *  2. Behavioural RLS / concurrency tests (opt-in) — run against a real
 *     PostgreSQL/PostgREST instance when KB_TEST_SUPABASE_URL,
 *     KB_TEST_ANON_KEY and KB_TEST_SERVICE_ROLE_KEY are set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('KB write authorization', () => {
  it('every KB mutation route requires the granular manage permission', () => {
    const src = read('server/routes/knowledgeBase.ts');
    const mutations = src.match(/knowledgeBaseRouter\.(post|patch|delete)\([\s\S]*?\n\}\);/g) ?? [];
    expect(mutations.length).toBeGreaterThanOrEqual(6);
    for (const handler of mutations) {
      expect(handler).toMatch(/'can_manage_knowledge_base'/);
    }
  });

  it('publishing is a distinct permission from editing', () => {
    const src = read('server/routes/knowledgeBase.ts');
    expect(src).toMatch(/can_publish_knowledge_base/);
    expect(src).toMatch(/denyIfCannotPublish/);
    // Both article write paths must run the publish check.
    const articleWrites = src.match(/knowledgeBaseRouter\.(post|patch)\('\/articles[\s\S]*?\n\}\);/g) ?? [];
    expect(articleWrites).toHaveLength(2);
    for (const handler of articleWrites) expect(handler).toMatch(/denyIfCannotPublish/);
  });

  it('the permission check fails closed', () => {
    const src = read('server/services/knowledge-base/access.ts');
    expect(src).toMatch(/has_workspace_permission/);
    expect(src).toMatch(/granted = false;/);
  });

  it('mutations still verify workspace ownership of the resource', () => {
    const src = read('server/routes/knowledgeBase.ts');
    expect(src).toMatch(/assertOwnership/);
    // Category assignment is validated against the caller's workspace.
    expect(src).toMatch(/'knowledge_base_categories', parsed\.data\.category_id, g\.workspaceId/);
  });
});

describe('AI KB Builder plan enforcement', () => {
  const src = read('server/routes/aiKb.ts');

  it('review/publish paths run the module gate, not only membership', () => {
    const loadGenerated = src.match(/async function loadGenerated[\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(loadGenerated).toMatch(/ensureModulesEnabled/);
    const publishAll = src.match(/publish-all'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(publishAll).toMatch(/ensureModulesEnabled/);
  });

  it('gates both knowledge_base and ai_kb_builder independently', () => {
    expect(src).toMatch(/\['knowledge_base', 'ai_kb_builder'\]/);
  });

  it('never writes a KB article outside the generated draft workspace', () => {
    const upsert = src.match(/async function upsertKbArticleFromGenerated[\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(upsert).toMatch(/\.eq\('workspace_id', gen\.workspace_id\)/);
    expect(upsert).toMatch(/kb_article_workspace_mismatch/);
  });
});

describe('Durable KB → AI outbox', () => {
  const src = read('server/services/ai-agent/knowledgeIndex/kbEvents.ts');

  it('claims events through the atomic lease RPC', () => {
    expect(src).toMatch(/claim_kb_change_events/);
    expect(src).not.toMatch(/\.from\('knowledge_base_change_events'\)\s*\n?\s*\.select/);
  });

  it('completes and fails events through dedicated RPCs (no silent drops)', () => {
    expect(src).toMatch(/complete_kb_change_events/);
    expect(src).toMatch(/fail_kb_change_events/);
  });

  it('enforces lease ownership on every terminal transition', () => {
    for (const rpc of ['complete_kb_change_events', 'defer_kb_change_events', 'fail_kb_change_events']) {
      const call = src.match(new RegExp(`rpc\\('${rpc}',[\\s\\S]*?\\}\\);`))?.[0] ?? '';
      expect(call, rpc).toMatch(/_claim_token: token/);
      expect(call, rpc).toMatch(/_worker_id: workerId/);
    }
    // A rejected ownership transition is counted, never treated as success.
    expect(src).toMatch(/leaseLost/);
  });

  it('defers temporary conditions instead of consuming attempts', () => {
    expect(src).toMatch(/defer_kb_change_events/);
    for (const code of [
      'knowledge_base_plan_required',
      'ai_assistant_plan_required',
      'ai_platform_disabled',
      'ai_provider_unavailable',
      'entitlement_lookup_failed',
    ]) {
      expect(src, code).toContain(code);
    }
    // Plan-off must NOT complete the event any more.
    expect(src).not.toMatch(/skippedNoPlan/);
  });

  it('only real errors consume attempts, with permanent classification', () => {
    expect(src).toMatch(/classifyRebuildError/);
    expect(src).toMatch(/permanent: true/);
    expect(src).toMatch(/index_rebuild_failed/);
  });

  it('treats a non-completed rebuild as a deferral, never a success', () => {
    expect(src).toMatch(/terminalState !== 'completed'/);
  });

  it('exposes deterministic catch-up used by plan changes', () => {
    expect(src).toMatch(/enqueue_kb_catchup/);
    expect(read('server/routes/plans.ts')).toMatch(/handleWorkspaceEntitlementChanged/);
  });

  it('surfaces catch-up failures instead of swallowing them', () => {
    expect(src).toMatch(/catchup_enqueue_failed/);
    expect(src).toMatch(/CatchupResult/);
  });

  it('passes a stable worker id so leases are attributable', () => {
    expect(read('worker/intelligence/index.ts')).toMatch(/workerId: WORKER_ID/);
  });
});

describe('Index reconciliation', () => {
  const src = read('server/services/ai-agent/knowledgeIndex/sync.ts');

  it('retires kb_article chunks whose article is no longer eligible', () => {
    expect(src).toMatch(/staleSourcesReconciled/);
    expect(src).toMatch(/eligibleArticleIds/);
    expect(src).toMatch(/\.eq\('source_type', 'kb_article'\)/);
  });

  it('reports an authoritative terminal state to the outbox worker', () => {
    expect(src).toMatch(/terminalState/);
    expect(src).toMatch(/deferred_provider_unavailable/);
  });
});

describe('Central entitlement-change funnel', () => {
  const src = read('server/services/billing/entitlementChange.ts');

  it('clears the entitlement cache and enqueues catch-up in one place', () => {
    expect(src).toMatch(/clearEntitlementCache/);
    expect(src).toMatch(/enqueueKnowledgeBaseCatchup/);
  });

  it('is wired into every real entitlement transition path', () => {
    expect(read('server/routes/plans.ts')).toMatch(/source: 'admin_assign'/);
    expect(read('server/routes/plans.ts')).toMatch(/source: 'admin_revoke'/);
    expect(read('server/routes/billing.ts')).toMatch(/source: 'admin_grant'/);
    expect(read('server/services/billing/index.ts')).toMatch(/handleWorkspaceEntitlementChanged/);
  });

  it('never throws into the billing path', () => {
    expect(src).toMatch(/errorCode\?: 'catchup_enqueue_failed'/);
  });
});

describe('AI KB Builder is a FEATURE gate, not a module gate', () => {
  const src = read('server/services/ai-kb/access.ts');

  it('checks ai_kb_builder through the entitlement (feature) path', () => {
    expect(src).toMatch(/checkEntitlementFromDB[\s\S]*?'ai_kb_builder'/);
  });

  it('gates knowledge_base and ai_assistant as modules, plus the platform switch', () => {
    expect(src).toMatch(/'knowledge_base', error: 'knowledge_base_plan_required'/);
    expect(src).toMatch(/'ai_assistant', error: 'ai_assistant_plan_required'/);
    expect(src).toMatch(/assertAiAgentPlatformEnabledForWorkspace/);
  });

  it('routes use the central guard and never leak raw DB errors', () => {
    const routes = read('server/routes/aiKb.ts');
    expect(routes).toMatch(/gateAiKb/);
    expect(routes).not.toMatch(/details: err\?\.message/);
    expect(routes).not.toMatch(/ensureModulesEnabled/);
  });
});

// ─── Behavioural (opt-in, needs a real database) ───────────────
const URL_ = process.env.KB_TEST_SUPABASE_URL;
const ANON = process.env.KB_TEST_ANON_KEY;
const SERVICE = process.env.KB_TEST_SERVICE_ROLE_KEY;
const live = Boolean(URL_ && ANON && SERVICE);

describe.skipIf(!live)('RLS behaviour against a real database', () => {
  const rest = (path: string, key: string, init: RequestInit = {}) =>
    fetch(`${URL_}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  it('anonymous clients cannot insert KB articles', async () => {
    const res = await rest('knowledge_base_articles', ANON!, {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: '00000000-0000-0000-0000-000000000000',
        slug: 'rls-probe', locale: 'en', title: 'probe', content: '', excerpt: '',
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('anonymous clients cannot delete KB categories', async () => {
    const res = await rest('knowledge_base_categories?slug=eq.__never__', ANON!, { method: 'DELETE' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('service role can claim outbox events atomically and only once', async () => {
    const claim = () =>
      rest('rpc/claim_kb_change_events', SERVICE!, {
        method: 'POST',
        body: JSON.stringify({ _worker_id: `test-${Math.random()}`, _limit: 50 }),
      }).then((r) => r.json() as Promise<Array<{ id: string }>>);

    const [a, b] = await Promise.all([claim(), claim()]);
    const ids = new Set([...a, ...b].map((r) => r.id));
    expect(ids.size).toBe(a.length + b.length);
  });
});
