/**
 * RESTRICTED-NETWORK ENTRYPOINT COVERAGE — AI Playground.
 *
 * Drives the real production entrypoint (`runPlayground`) with provider
 * egress blocked for Core and only the AI Runtime reachable. Nothing on the
 * AI egress path is mocked: resolveAIConfig → executeAICompletion →
 * runtimeClient → the REAL runtime handler → provider mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installRestrictedNetwork,
  restrictedServerConfig,
  RUNTIME_BASE,
  type RestrictedNetwork,
} from './helpers/restrictedNetwork.js';
import { AI_RUNTIME_ROUTES } from '../../../shared/ai/internalRoutes.js';

const usageLogs: any[] = [];
const logRuns: any[] = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () =>
          table === 'provider_configs'
            ? {
                data: {
                  provider_name: 'openai',
                  config: { api_key: 'sk-workspace-key', model: 'gpt-4o-mini' },
                },
                error: null,
              }
            : { data: null, error: null },
        insert: async (row: any) => {
          if (table === 'ai_usage_logs') usageLogs.push(row);
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => ({
    mode: 'auto_reply_always',
    answer_guidance: 'balanced',
    answer_only_from_kb: false,
    handoff_when_no_kb_match: false,
    handoff_on_low_confidence: false,
    handoff_on_human_request: false,
    handoff_keywords: [],
    confidence_threshold: 0.5,
    fallback_message: 'A human will reply shortly.',
    handoff_message_localized: {},
  }),
}));

vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({
  retrieveSources: async () => [
    { id: 'kb-1', kind: 'kb_article', title: 'Reset password', slug: 'reset', locale: 'en', score: 0.9, content: 'Use the reset link.' },
  ],
}));

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  logRun: async (_c: any, input: any) => {
    logRuns.push(input);
    return `run-${logRuns.length}`;
  },
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
}));

const { runPlayground } = await import('../../../server/services/ai-agent/playground.js');

const CONFIG = restrictedServerConfig();
let net: RestrictedNetwork;

beforeEach(() => {
  usageLogs.length = 0;
  logRuns.length = 0;
  net = installRestrictedNetwork();
});
afterEach(() => vi.unstubAllGlobals());

describe('restricted network — AI Playground entrypoint', () => {
  it('answers a playground question through the AI Runtime with zero provider egress from Core', async () => {
    const result = await runPlayground(CONFIG, {
      workspaceId: 'ws-1',
      question: 'How do I reset my password?',
      locale: 'en',
    });

    // Succeeded through the real runtime handler + provider mock.
    expect(result.action).toBe('answer');
    expect(result.answer).toBe('hello from provider');

    // AI_RUNTIME_URL remained reachable and was the only AI egress from Core.
    expect(net.runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    // Provider sockets originated only from the Runtime.
    expect(net.providerHits).toHaveLength(1);
    // No direct provider request — and no fallback provider request either.
    expect(net.coreProviderViolations).toEqual([]);
    expect(net.otherHits).toEqual([]);
    expect(usageLogs).toHaveLength(1);
    expect(usageLogs[0]).toMatchObject({ success: true, endpoint: 'complete' });
  });
});
