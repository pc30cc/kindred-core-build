/**
 * RESTRICTED-NETWORK ACCEPTANCE SUITE.
 *
 * Simulates the real production topology:
 *
 *   IRAN / restricted network                 EXTERNAL / unrestricted network
 *   ┌───────────────────────────┐             ┌──────────────────────────────┐
 *   │ Core (this process)       │ ──HTTPS──▶  │ AI Runtime ──▶ AI providers  │
 *   │ provider egress: BLOCKED  │             │ provider egress: ALLOWED     │
 *   └───────────────────────────┘             └──────────────────────────────┘
 *
 * A single global fetch stub plays the network. Any request Core makes to a
 * provider host fails the way a censored/firewalled egress fails (and is
 * recorded as a hard violation). Requests to the AI Runtime base URL are
 * dispatched into the REAL runtime handlers, and only while a handler runs is
 * provider egress permitted.
 *
 * Consequence: if any Core code path ever regains a direct provider socket,
 * these tests fail — not because of a string match, but because the request
 * physically cannot succeed in this topology.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const usageLogs: any[] = [];
const supabaseState: { workspaceProvider: any; globalProvider: any } = {
  workspaceProvider: null,
  globalProvider: null,
};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => makeSupabaseStub(),
}));

import {
  executeAICompletion,
  executeAICompletionWithConfig,
  resetAiIdempotency,
  newAiRequestId,
} from '../../../server/services/ai/index.js';
import { runtimeTestConnection, AiRuntimeError } from '../../../server/services/ai/runtimeClient.js';
import { buildOpenAIEmbeddingProvider } from '../../../server/services/ai-agent/embeddings/openai.js';
import { handleComplete, handleTest, handleEmbed, statusForCode } from '../../../runtime/ai/service.js';
import { AI_RUNTIME_ROUTES, AI_RUNTIME_SECRET_HEADER } from '../../../shared/ai/internalRoutes.js';

// ── Supabase stub (Core keeps the DB; the runtime never sees it) ────────────
function makeSupabaseStub() {
  const builder = (table: string) => {
    const chain: any = {
      _table: table,
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      single: async () => {
        if (table === 'provider_configs') return { data: supabaseState.workspaceProvider, error: null };
        if (table === 'app_runtime_config') return { data: supabaseState.globalProvider, error: null };
        return { data: null, error: null };
      },
      insert: async (row: any) => {
        if (table === 'ai_usage_logs') usageLogs.push(row);
        return { data: null, error: null };
      },
    };
    return chain;
  };
  return { from: builder } as any;
}

// ── The simulated network ───────────────────────────────────────────────────
const RUNTIME_BASE = 'https://ai-runtime.external.example';
const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
  'api.mistral.ai',
];

const serverConfig: any = {
  aiRuntimeBaseUrl: RUNTIME_BASE,
  aiRuntimeInternalSecret: 'runtime-secret',
};

let coreProviderViolations: string[] = [];
let providerHits: string[] = [];
let runtimeHits: string[] = [];
let insideRuntime = 0;

/** What a provider returns once the *unrestricted* side reaches it. */
function providerResponse(url: string): Response {
  if (url.includes('/embeddings')) {
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: 'text-embedding-3-small' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('anthropic')) {
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'hello from anthropic' }],
        model: 'claude',
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'hello from provider' }, finish_reason: 'stop' }],
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function installRestrictedNetwork() {
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);

    // Hop 1: Core → AI Runtime (the only egress Core is allowed).
    if (url.startsWith(RUNTIME_BASE)) {
      runtimeHits.push(url);
      const route = url.slice(RUNTIME_BASE.length);
      const headers = (init.headers || {}) as Record<string, string>;
      if (headers[AI_RUNTIME_SECRET_HEADER] !== serverConfig.aiRuntimeInternalSecret) {
        return new Response(JSON.stringify({ ok: false, error: 'runtime_unauthorized' }), { status: 401 });
      }
      const body = JSON.parse(String(init.body || '{}'));
      insideRuntime++;
      try {
        const out: any =
          route === AI_RUNTIME_ROUTES.complete
            ? await handleComplete(body)
            : route === AI_RUNTIME_ROUTES.test
              ? await handleTest(body)
              : route === AI_RUNTIME_ROUTES.embed
                ? await handleEmbed(body)
                : { ok: false, code: 'internal_error', message: 'unknown route' };
        const status = out.ok ? 200 : statusForCode(out.code);
        const payload = out.ok ? { ok: true, ...out.data } : { ok: false, error: out.code, message: out.message };
        return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      } finally {
        insideRuntime--;
      }
    }

    // Hop 2: provider sockets.
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    const isProvider = PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || host.includes('openai');
    if (isProvider) {
      if (insideRuntime === 0) {
        // Core tried to reach a provider directly — impossible in this topology.
        coreProviderViolations.push(url);
        throw new TypeError(`fetch failed: ${host} is unreachable from the restricted network`);
      }
      providerHits.push(url);
      return providerResponse(url);
    }

    throw new TypeError(`fetch failed: ${host || url} is unreachable from the restricted network`);
  });
}

beforeEach(() => {
  usageLogs.length = 0;
  coreProviderViolations = [];
  providerHits = [];
  runtimeHits = [];
  insideRuntime = 0;
  supabaseState.workspaceProvider = {
    provider_name: 'openai',
    config: { api_key: 'sk-workspace-key', model: 'gpt-4o-mini' },
  };
  supabaseState.globalProvider = null;
  resetAiIdempotency();
  installRestrictedNetwork();
});

afterEach(() => vi.unstubAllGlobals());

describe('restricted network — Core succeeds only through the AI Runtime', () => {
  it('completes a chat turn: Core → runtime → provider, zero direct provider egress from Core', async () => {
    const res = await executeAICompletion(serverConfig, { workspaceId: 'ws-1', prompt: 'hi' });

    expect(res.text).toBe('hello from provider');
    expect(coreProviderViolations).toEqual([]);
    expect(runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    expect(providerHits.length).toBe(1);
    expect(usageLogs).toHaveLength(1);
    expect(usageLogs[0]).toMatchObject({ success: true, endpoint: 'complete', workspace_id: 'ws-1' });
  });

  it('works the same for the engine path that pre-resolved the provider config', async () => {
    const res = await executeAICompletionWithConfig(
      serverConfig,
      { provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-3-5-sonnet' } as any,
      { workspaceId: 'ws-1', prompt: 'hi' },
    );
    expect(res.text).toBe('hello from anthropic');
    expect(res.finishReason).toBe('stop');
    expect(coreProviderViolations).toEqual([]);
  });

  it('runs the operator connection test without Core touching the provider', async () => {
    const result = await runtimeTestConnection(serverConfig, {
      provider: 'openai',
      apiKey: 'sk-x',
      model: 'gpt-4o-mini',
    } as any);
    if (!result.success) console.log('TESTCONN', result);
    expect(result.success).toBe(true);
    expect(coreProviderViolations).toEqual([]);
    expect(runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.test}`]);
  });

  it('embeds knowledge-base text through the runtime only', async () => {
    const provider = buildOpenAIEmbeddingProvider(serverConfig, {
      provider: 'openai',
      apiKey: 'sk-x',
      model: 'text-embedding-3-small',
      dimensions: 3,
    });
    const vectors = await provider.embedTexts(['some article body']);
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(coreProviderViolations).toEqual([]);
    expect(runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.embed}`]);
  });
});

describe('restricted network — fail-closed behaviour', () => {
  it('fails with runtime_not_configured and makes no request at all when no runtime is deployed', async () => {
    await expect(
      executeAICompletion({ } as any, { workspaceId: 'ws-1', prompt: 'hi' }),
    ).rejects.toMatchObject({ code: 'runtime_not_configured' });
    expect(runtimeHits).toEqual([]);
    expect(providerHits).toEqual([]);
    expect(coreProviderViolations).toEqual([]);
    // The failure is still accounted for.
    expect(usageLogs.at(-1)).toMatchObject({ success: false });
  });

  it('reports runtime_unreachable (never a provider error) when the external server is down', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const err: any = await executeAICompletion(serverConfig, { workspaceId: 'ws-1', prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiRuntimeError);
    expect(err.code).toBe('runtime_unreachable');
  });

  it('rejects a wrong internal secret at the runtime boundary', async () => {
    const err: any = await executeAICompletion(
      { ...serverConfig, aiRuntimeInternalSecret: 'wrong' },
      { workspaceId: 'ws-1', prompt: 'hi' },
    ).catch((e) => e);
    expect(err.code).toBe('runtime_unauthorized');
    expect(providerHits).toEqual([]);
  });

  it('never leaks the provider API key into the persisted failure message', async () => {
    supabaseState.workspaceProvider = {
      provider_name: 'not-a-provider',
      config: { api_key: 'sk-super-secret-value', model: 'x' },
    };
    await executeAICompletion(serverConfig, { workspaceId: 'ws-1', prompt: 'hi' }).catch(() => null);
    expect(JSON.stringify(usageLogs)).not.toContain('sk-super-secret-value');
  });
});

describe('restricted network — one logical request, one execution', () => {
  it('replays the same requestId without a second runtime call or a second usage row', async () => {
    const requestId = newAiRequestId();
    const first = await executeAICompletionWithConfig(
      serverConfig,
      { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o-mini' } as any,
      { workspaceId: 'ws-1', prompt: 'hi', requestId },
    );
    const replay = await executeAICompletionWithConfig(
      serverConfig,
      { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o-mini' } as any,
      { workspaceId: 'ws-1', prompt: 'hi', requestId },
    );

    expect(replay).toEqual(first);
    expect(runtimeHits).toHaveLength(1);
    expect(providerHits).toHaveLength(1);
    expect(usageLogs).toHaveLength(1);
  });

  it('replays a failure as a failure instead of retrying the provider', async () => {
    const requestId = newAiRequestId();
    const cfg: any = { provider: 'nope', apiKey: 'k', model: 'm' };
    const a: any = await executeAICompletionWithConfig(serverConfig, cfg, {
      workspaceId: 'ws-1',
      prompt: 'hi',
      requestId,
    }).catch((e) => e);
    const b: any = await executeAICompletionWithConfig(serverConfig, cfg, {
      workspaceId: 'ws-1',
      prompt: 'hi',
      requestId,
    }).catch((e) => e);

    expect(a).toBeInstanceOf(Error);
    expect(b).toBe(a);
    expect(runtimeHits).toHaveLength(1);
    expect(usageLogs).toHaveLength(1);
  });

  it('treats distinct requestIds as distinct executions', async () => {
    const cfg: any = { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o-mini' };
    await executeAICompletionWithConfig(serverConfig, cfg, {
      workspaceId: 'ws-1',
      prompt: 'a',
      requestId: newAiRequestId(),
    });
    await executeAICompletionWithConfig(serverConfig, cfg, {
      workspaceId: 'ws-1',
      prompt: 'b',
      requestId: newAiRequestId(),
    });
    expect(runtimeHits).toHaveLength(2);
    expect(usageLogs).toHaveLength(2);
  });
});
