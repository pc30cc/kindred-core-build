/**
 * RESTRICTED-NETWORK ENTRYPOINT COVERAGE — regression AI execution.
 *
 * Runs a real regression batch (`runRegressionBatch` → runDryRunTest) with
 * provider egress blocked for Core. The dry-run's provider orchestration
 * (resolveAIConfig / executeAICompletion / runtimeClient → REAL runtime
 * handler) is untouched; retrieval/settings are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeFakeSupabase,
  makeSettings,
  makeHybridResult,
  makeHybridSource,
} from '../ai-agent/helpers/engineFixtures.js';
import {
  installRestrictedNetwork,
  restrictedServerConfig,
  RUNTIME_BASE,
  type RestrictedNetwork,
} from './helpers/restrictedNetwork.js';
import { AI_RUNTIME_ROUTES } from '../../../shared/ai/internalRoutes.js';

const WORKSPACE_ID = 'ws-1';
const BATCH_ID = 'batch-1';

let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => makeSettings({ allowed_locales: ['en'] }),
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => makeHybridResult({ sources: [makeHybridSource()] }),
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

const { runRegressionBatch } = await import('../../../server/services/ai-agent/regressionRunner.js');

const CONFIG = restrictedServerConfig();
let net: RestrictedNetwork;

beforeEach(() => {
  fakeSb = makeFakeSupabase({
    ai_agent_regression_batches: [{
      id: BATCH_ID,
      workspace_id: WORKSPACE_ID,
      status: 'queued',
      schedule_id: null,
      metadata: {},
      total_cases: 1,
    }],
    ai_agent_test_cases: [{
      id: 'case-1',
      workspace_id: WORKSPACE_ID,
      enabled: true,
      name: 'password reset',
      input_message: 'How do I reset my password?',
      locale: 'en',
      expectations: {},
      created_at: '2026-01-01T00:00:00.000Z',
    }],
    provider_configs: [{
      id: 'pc-1',
      workspace_id: WORKSPACE_ID,
      provider_type: 'ai',
      is_active: true,
      provider_name: 'openai',
      config: { api_key: 'sk-key', model: 'gpt-4o-mini' },
    }],
  });
  net = installRestrictedNetwork();
});
afterEach(() => vi.unstubAllGlobals());

describe('restricted network — regression AI execution', () => {
  it('executes a regression case through the AI Runtime with zero provider egress from Core', async () => {
    const out = await runRegressionBatch(CONFIG as any, BATCH_ID);

    expect(out.ok).toBe(true);
    expect(out.total).toBe(1);
    expect(out.errored).toBe(0);

    // The dry-run reached the model through the runtime.
    const runs = (fakeSb.__store['ai_agent_test_runs'] || []) as any[];
    expect(runs.length).toBe(1);
    expect(runs[0].output_text).toBe('hello from provider');

    expect(net.runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    expect(net.providerHits).toHaveLength(1);
    expect(net.coreProviderViolations).toEqual([]);
    expect(net.otherHits).toEqual([]);
  });
});
