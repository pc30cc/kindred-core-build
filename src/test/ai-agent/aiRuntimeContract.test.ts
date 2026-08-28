/**
 * Behavioural tests for the Core ⇄ AI Runtime boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleComplete,
  handleTest,
  handleEmbed,
  statusForCode,
} from '../../../runtime/ai/service.js';
import {
  runtimeComplete,
  isAiRuntimeConfigured,
  AiRuntimeError,
} from '../../../server/services/ai/runtimeClient.js';
import {
  AI_RUNTIME_ROUTES,
  AI_RUNTIME_SECRET_HEADER,
  AI_RUNTIME_CONTRACT_HEADER,
  AI_RUNTIME_CONTRACT_VERSION,
} from '../../../shared/ai/internalRoutes.js';

const baseConfig: any = {
  aiRuntimeBaseUrl: 'https://ai-runtime.example.com',
  aiRuntimeInternalSecret: 'runtime-secret',
};

describe('Core → AI Runtime client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fails closed with runtime_not_configured when no runtime is deployed', async () => {
    const spy = vi.spyOn(globalThis, 'fetch' as any);
    await expect(
      runtimeComplete({} as any, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceId: 'w',
        prompt: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'runtime_not_configured' });
    // The decisive assertion: no outbound request at all from Core.
    expect(spy).not.toHaveBeenCalled();
    expect(isAiRuntimeConfigured({} as any)).toBe(false);
  });

  it('posts to the shared route with both credential headers and the contract version', async () => {
    let seen: any;
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({ ok: true, response: { text: 'hi', model: 'm', provider: 'openai', promptTokens: 1, completionTokens: 1, totalTokens: 2, latencyMs: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const out = await runtimeComplete(baseConfig, { provider: 'openai', apiKey: 'k', model: 'm' }, {
      workspaceId: 'w',
      prompt: 'hi',
    });

    expect(out.text).toBe('hi');
    expect(seen.url).toBe(`https://ai-runtime.example.com${AI_RUNTIME_ROUTES.complete}`);
    expect(seen.init.headers[AI_RUNTIME_SECRET_HEADER]).toBe('runtime-secret');
    expect(seen.init.headers.Authorization).toBe('Bearer runtime-secret');
    expect(seen.init.headers[AI_RUNTIME_CONTRACT_HEADER]).toBe(AI_RUNTIME_CONTRACT_VERSION);
  });

  it('surfaces the runtime error code instead of a generic failure', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'provider_error', message: 'OpenAI error: bad key' }), { status: 502 }),
    );
    await expect(
      runtimeComplete(baseConfig, { provider: 'openai', apiKey: 'k', model: 'm' }, { workspaceId: 'w', prompt: 'x' }),
    ).rejects.toBeInstanceOf(AiRuntimeError);
  });

  it('classifies a transport failure as runtime_unreachable', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('fetch failed'));
    await expect(
      runtimeComplete(baseConfig, { provider: 'openai', apiKey: 'k', model: 'm' }, { workspaceId: 'w', prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'runtime_unreachable' });
  });
});

describe('AI Runtime handlers', () => {
  it('rejects malformed requests before touching a provider', async () => {
    const spy = vi.spyOn(globalThis, 'fetch' as any);
    expect(await handleComplete({})).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await handleComplete({ config: { provider: 'openai', model: 'm' } })).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(await handleEmbed({ config: { provider: 'openai', model: 'm' }, texts: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects unknown providers with a stable code', async () => {
    const res = await handleComplete({
      config: { provider: 'not-a-provider', apiKey: 'k', model: 'm' },
      request: { workspaceId: 'w', prompt: 'hi' },
    });
    expect(res).toMatchObject({ ok: false, code: 'unsupported_provider' });
    expect(statusForCode('unsupported_provider')).toBe(400);
  });

  it('rejects non OpenAI-compatible embedding providers', async () => {
    const res = await handleEmbed({ config: { provider: 'anthropic', apiKey: 'k', model: 'm' }, texts: ['a'] });
    expect(res).toMatchObject({ ok: false, code: 'unsupported_provider' });
  });

  it('blocks a private-network baseUrl during a connection test (SSRF)', async () => {
    const res: any = await handleTest({
      config: { provider: 'azure_openai', apiKey: 'k', model: 'm', baseUrl: 'https://127.0.0.1/v1' },
    });
    expect(res.ok).toBe(true);
    expect(res.data.result.success).toBe(false);
    expect(String(res.data.result.error)).toMatch(/blocked_ip|host_not_allowed|network error/i);
  });

  it('maps failure codes to sane HTTP statuses', () => {
    expect(statusForCode('runtime_unauthorized')).toBe(401);
    expect(statusForCode('contract_mismatch')).toBe(409);
    expect(statusForCode('provider_error')).toBe(502);
    expect(statusForCode('internal_error')).toBe(500);
  });
});
