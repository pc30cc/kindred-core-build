/**
 * RESTRICTED-NETWORK ENTRYPOINT COVERAGE — KB Builder AI generation.
 *
 * Runs the real KB Builder job processor (`processJob` → generateArticle)
 * with provider egress blocked for Core. Two distinct egress classes are
 * exercised at once:
 *   - the crawler's own HTTP fetch to the customer domain (allowed from Core)
 *   - the AI generation call, which must go out ONLY through the AI Runtime
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeSupabase } from '../ai-agent/helpers/engineFixtures.js';
import {
  installRestrictedNetwork,
  defaultProviderResponse,
  RUNTIME_BASE,
  RUNTIME_SECRET,
  type RestrictedNetwork,
} from './helpers/restrictedNetwork.js';
import { AI_RUNTIME_ROUTES } from '../../../shared/ai/internalRoutes.js';

const WORKSPACE_ID = 'ws-1';
const CRAWL_HOST = 'docs.example.com';

vi.mock('../../../server/services/ai-kb/credits.js', () => ({
  consumeAiCredits: async () => ({ success: true, credits_used: 1, credits_limit: 100 }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  logGateBypass: async () => {},
  isGlobalAdmin: async () => false,
}));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

const { processJob } = await import('../../../worker/intelligence/processor.js');

let fakeSb: any;
let net: RestrictedNetwork;

const PAGE_HTML = `<html><head><title>Reset your password</title></head><body>
<h1>Reset your password</h1>
<p>Open settings, choose security, then click reset password. A link is emailed to you.</p>
</body></html>`;

const DRAFT_JSON = JSON.stringify({
  title: 'Reset your password',
  slug: 'reset-your-password',
  excerpt: 'How to reset your password.',
  content_html: '<p>Open settings and click reset password.</p>',
  confidence: 0.9,
  locale: 'en',
});

beforeEach(() => {
  fakeSb = makeFakeSupabase({
    provider_configs: [{
      id: 'pc-1',
      workspace_id: WORKSPACE_ID,
      provider_type: 'ai',
      is_active: true,
      provider_name: 'openai',
      config: { api_key: 'sk-key', model: 'gpt-4o-mini' },
    }],
    ai_kb_jobs: [{ id: 'job-1', workspace_id: WORKSPACE_ID, pages_failed: 0 }],
  });
  net = installRestrictedNetwork({
    // The crawler legitimately reaches the customer's own website from Core.
    allowHost: (url, host) => {
      if (host !== CRAWL_HOST) return undefined;
      const res = new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      // The crawler re-validates the post-redirect host via `res.url`.
      Object.defineProperty(res, 'url', { value: url });
      return res;
    },

    providerResponse: (url) =>
      url.includes('/embeddings')
        ? defaultProviderResponse(url)
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: DRAFT_JSON }, finish_reason: 'stop' }],
              model: 'gpt-4o-mini',
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('restricted network — KB Builder AI generation', () => {
  it('generates an article draft through the AI Runtime while Core only reaches the crawled site', async () => {
    const env: any = {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'SERVICE_KEY',
      aiRuntimeBaseUrl: RUNTIME_BASE,
      aiRuntimeInternalSecret: RUNTIME_SECRET,
    };
    const job = {
      id: 'job-1',
      workspace_id: WORKSPACE_ID,
      source_domain: CRAWL_HOST,
      locale: 'en',
      pages_failed: 0,
      plan_snapshot: { maxPages: 1, maxDepth: 0, maxArticles: 1 },
    };

    await processJob(fakeSb, env, job);

    const drafts = (fakeSb.__store['ai_kb_generated_articles'] || []) as any[];
    expect(drafts.length).toBe(1);
    expect(drafts[0].title).toBe('Reset your password');

    // The AI hop went through the runtime; the crawl hop did not.
    expect(net.runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    expect(net.providerHits).toHaveLength(1);
    expect(net.otherHits.every((u) => u.includes(CRAWL_HOST))).toBe(true);
    expect(net.coreProviderViolations).toEqual([]);
  });
});
