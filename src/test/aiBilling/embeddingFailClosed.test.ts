/**
 * AI Usage Billing — embedding usage recording must not be swallowed under
 * ENFORCED.
 *
 * The embed call itself already happened (real provider cost incurred) by
 * the time recordStepUsage runs, so this can't gate the API call — but it
 * must still surface the failure rather than silently granting the
 * embedding for free with no audit trail. By the time a Run reaches this
 * point under ENFORCED, reserveForRun() already proved a rate card exists,
 * so a recordStepUsage failure here is a genuine anomaly, not routine
 * degradation — unlike METER_ONLY, where it's expected and must never
 * block anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordStepUsageMock = vi.fn();
vi.mock('../../../server/services/ai-billing/runContext', () => ({
  recordStepUsage: recordStepUsageMock,
}));

vi.mock('../../../server/services/ai/runtimeClient', () => ({
  runtimeEmbed: vi.fn(async (_config: any, _cfg: any, batch: string[]) => batch.map(() => [0.1, 0.2, 0.3])),
}));

const config = { supabaseUrl: 'http://localhost', supabaseServiceRoleKey: 'k' } as any;

describe('AI billing — embedding usage recording fails closed under ENFORCED', () => {
  beforeEach(() => {
    recordStepUsageMock.mockReset();
  });

  it('ENFORCED: propagates a recordStepUsage failure instead of swallowing it', async () => {
    recordStepUsageMock.mockRejectedValue(Object.assign(new Error('no rate card'), { code: 'billing_rate_not_configured' }));
    const { buildOpenAIEmbeddingProvider } = await import('../../../server/services/ai-agent/embeddings/openai');
    const provider = buildOpenAIEmbeddingProvider(config, {
      provider: 'openai', apiKey: 'sk-x', model: 'text-embedding-3-small', dimensions: 3,
    });
    const runCtx = { runId: 'run-1', mode: 'ENFORCED' } as any;

    await expect(provider.embedTexts(['hello world'], { runCtx })).rejects.toThrow('no rate card');
    expect(recordStepUsageMock).toHaveBeenCalledTimes(1);
  });

  it('METER_ONLY: swallows a recordStepUsage failure and still returns the vectors', async () => {
    recordStepUsageMock.mockRejectedValue(new Error('transient billing DB hiccup'));
    const { buildOpenAIEmbeddingProvider } = await import('../../../server/services/ai-agent/embeddings/openai');
    const provider = buildOpenAIEmbeddingProvider(config, {
      provider: 'openai', apiKey: 'sk-x', model: 'text-embedding-3-small', dimensions: 3,
    });
    const runCtx = { runId: 'run-2', mode: 'METER_ONLY' } as any;

    const out = await provider.embedTexts(['hello world'], { runCtx });
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(recordStepUsageMock).toHaveBeenCalledTimes(1);
  });

  it('no runCtx at all: never calls recordStepUsage, embedding still succeeds (unbilled, matches prior behavior when billing is unavailable)', async () => {
    const { buildOpenAIEmbeddingProvider } = await import('../../../server/services/ai-agent/embeddings/openai');
    const provider = buildOpenAIEmbeddingProvider(config, {
      provider: 'openai', apiKey: 'sk-x', model: 'text-embedding-3-small', dimensions: 3,
    });
    const out = await provider.embedTexts(['hello world']);
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(recordStepUsageMock).not.toHaveBeenCalled();
  });
});
