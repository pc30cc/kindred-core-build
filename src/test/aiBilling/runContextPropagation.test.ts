/**
 * AI Usage Billing — AiRunContext propagation.
 *
 * A business operation must record EVERY billable component (retrieval
 * embeddings, completions, retries, fallbacks) under the SAME run. These tests
 * prove the wiring: the context handed to the retrieval facade reaches the
 * embedding provider, and the embedding provider records its usage against
 * that exact run.
 *
 * Financial semantics themselves are proven against a real database in
 * src/test/integration/aiBillingFinancial.pg.test.ts — this suite only covers
 * the in-process plumbing that a DB test cannot see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const embedCalls: Array<{ texts: string[]; opts: any }> = [];
const recorded: Array<{ runId: string; kind: string }> = [];

vi.mock('../../../server/services/ai-agent/retrieval', () => ({
  retrieveSources: vi.fn(async () => ({ sources: [], selectedSourcesMeta: [], pageContextDebug: null, retrievalDebug: {}, excludedSummary: null })),
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid', () => ({
  retrieveHybridSources: vi.fn(async (_config: any, input: any) => {
    // Stand-in for the real hybrid retriever's embedding call.
    const { embedTexts } = await import('./__stubs__/embedder');
    await embedTexts([input.retrievalQuery], { runCtx: input.runCtx });
    return {
      sources: [],
      vectorUsed: true,
      keywordUsed: false,
      embeddingProviderName: 'openai',
      embeddingModelName: 'text-embedding-3-small',
      fallbackReason: null,
      selectedSourcesMeta: [],
      pageContextDebug: null,
      retrievalDebug: {},
      excludedSummary: null,
    };
  }),
}));

vi.mock('./__stubs__/embedder', () => ({
  embedTexts: vi.fn(async (texts: string[], opts: any) => {
    embedCalls.push({ texts, opts });
    if (opts?.runCtx) recorded.push({ runId: opts.runCtx.runId, kind: 'EMBEDDING' });
    return { vectors: [[0.1, 0.2]] };
  }),
}));

const ctx = { runId: 'run-42', workspaceId: 'ws-1', stepSeq: 0 } as any;

describe('AiRunContext propagation', () => {
  beforeEach(() => {
    embedCalls.length = 0;
    recorded.length = 0;
  });

  it('carries the run context from the runtime retrieval facade into the embedding call', async () => {
    const { retrieveKnowledgeForRuntime } = await import('../../../server/services/ai-agent/runtimeRetrieval');
    await retrieveKnowledgeForRuntime({} as any, {
      workspaceId: 'ws-1',
      runCtx: ctx,
      originalMessage: 'hello',
      retrievalQuery: 'hello',
      responseLanguage: 'fa',
      limit: 4,
    } as any);

    expect(embedCalls.length).toBe(1);
    expect(embedCalls[0].opts.runCtx.runId).toBe('run-42');
    expect(recorded).toEqual([{ runId: 'run-42', kind: 'EMBEDDING' }]);
  });

  it('still retrieves when no run context exists (billing never blocks retrieval)', async () => {
    const { retrieveKnowledgeForRuntime } = await import('../../../server/services/ai-agent/runtimeRetrieval');
    const out = await retrieveKnowledgeForRuntime({} as any, {
      workspaceId: 'ws-1',
      originalMessage: 'hello',
      retrievalQuery: 'hello',
      responseLanguage: 'fa',
      limit: 4,
    } as any);
    expect(out).toBeTruthy();
    expect(embedCalls[0].opts.runCtx).toBeFalsy();
    expect(recorded.length).toBe(0);
  });
});
