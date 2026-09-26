/**
 * AI Runtime — workspace-supplied provider base_url SSRF.
 *
 * `provider_configs.config.base_url` is editable by a workspace admin. The
 * runtime used to hand it to plain global fetch for completions and
 * embeddings (only /api/ai/test was guarded). Now:
 *   - workspace-scoped base URLs go through the SSRF-safe transport (provider
 *     host policy, public-address check, DNS pinning, same-origin redirects);
 *   - the operator's platform default (endpointScope 'platform') and the
 *     runtime's own catalog defaults keep the existing transport, so a
 *     self-hosted deployment can still use a private LLM;
 *   - AI_PROVIDER_PRIVATE_HOSTS lets the operator explicitly allow specific
 *     private hosts for workspaces too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { handleComplete, handleEmbed, providerFetchFor } = await import('../../../runtime/ai/service.js');
const { createSafeProviderFetch, SafeTransportError } = await import('../../../runtime/ai/providers/safeTransport.js');
const { checkWorkspaceProviderBaseUrl, isOperatorAllowedPrivateHost } = await import(
  '../../../shared/ai/endpointPolicy.js'
);

const COMPLETION = JSON.stringify({
  choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

let fetchCalls: string[];
beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal('fetch', async (input: any) => {
    fetchCalls.push(String(input));
    return new Response(
      String(input).includes('/embeddings') ? JSON.stringify({ data: [{ embedding: [0.1] }] }) : COMPLETION,
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_PROVIDER_PRIVATE_HOSTS;
});

const complete = (config: Record<string, unknown>) =>
  handleComplete({ config: { apiKey: 'k', model: 'm', ...config }, request: { workspaceId: 'ws', prompt: 'p' } });

describe('transport selection', () => {
  it('only workspace-supplied base URLs get the restricted transport', () => {
    expect(providerFetchFor({ provider: 'openai' })).toBeUndefined();
    expect(providerFetchFor({ provider: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1', endpointScope: 'platform' })).toBeUndefined();
    expect(typeof providerFetchFor({ provider: 'ollama', baseUrl: 'https://x.example/v1', endpointScope: 'workspace' })).toBe('function');
    // Missing scope fails closed (treated as workspace).
    expect(typeof providerFetchFor({ provider: 'ollama', baseUrl: 'https://x.example/v1' })).toBe('function');
  });
});

describe('completions / embeddings with a workspace base URL', () => {
  it.each([
    'https://169.254.169.254/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://[::ffff:a9fe:a9fe]/v1',
    'https://127.0.0.2/v1',
    'https://100.64.0.1/v1',
    'http://93.184.216.34/v1',
    'https://metadata.google.internal/v1',
    'https://localhost/v1',
  ])('refuses %s without ever opening a socket', async (baseUrl) => {
    const res: any = await complete({ provider: 'azure_openai', baseUrl, endpointScope: 'workspace' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('provider_error');
    expect(res.message).toMatch(/blocked_ip|host_not_allowed|unsafe_scheme/);
    expect(fetchCalls).toEqual([]);
  });

  it('applies the official-provider host policy to a workspace base URL', async () => {
    const res: any = await complete({ provider: 'openai', baseUrl: 'https://evil.example.com/v1', endpointScope: 'workspace' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/host_not_allowed/);
    expect(fetchCalls).toEqual([]);
  });

  it('guards embeddings the same way', async () => {
    const res: any = await handleEmbed({
      config: { provider: 'ollama', apiKey: '', model: 'e', baseUrl: 'https://169.254.169.254/v1', endpointScope: 'workspace' },
      texts: ['a'],
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/blocked_ip/);
    expect(fetchCalls).toEqual([]);
  });
});

describe('operator-configured providers keep working', () => {
  it('platform default may point at a private/self-hosted LLM (existing transport)', async () => {
    const res: any = await complete({ provider: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1', endpointScope: 'platform' });
    expect(res.ok).toBe(true);
    expect(fetchCalls).toEqual(['http://10.0.0.5:11434/v1/chat/completions']);
  });

  it('platform default embeddings are unchanged too', async () => {
    const res: any = await handleEmbed({
      config: { provider: 'ollama', apiKey: '', model: 'e', baseUrl: 'http://ollama:11434/v1', endpointScope: 'platform' },
      texts: ['a'],
    });
    expect(res.ok).toBe(true);
    expect(fetchCalls).toEqual(['http://ollama:11434/v1/embeddings']);
  });

  it('catalog default endpoint (no base URL) is unchanged', async () => {
    const res: any = await complete({ provider: 'openai' });
    expect(res.ok).toBe(true);
    expect(fetchCalls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });
});

// ── Transport-level checks (DNS + socket stubbed) ───────────────────────
type Hop = { status: number; headers?: Record<string, string>; body?: string };
function fakeRequest(hops: Hop[]) {
  const seen: Array<{ protocol: string; host: string; port: number; address: string; servername?: string }> = [];
  let i = 0;
  const impl: any = (options: any, cb: (res: any) => void) => {
    const hop = hops[Math.min(i++, hops.length - 1)];
    const req: any = new EventEmitter();
    let address = '';
    options.lookup(options.host, {}, (_e: unknown, addr: string) => { address = addr; });
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      seen.push({ protocol: options.protocol, host: options.host, port: options.port, address, servername: options.servername });
      setImmediate(() => {
        const res: any = new EventEmitter();
        res.statusCode = hop.status;
        res.statusMessage = 'OK';
        res.headers = hop.headers || {};
        res.destroy = () => {};
        cb(res);
        setImmediate(() => {
          if (hop.body) res.emit('data', Buffer.from(hop.body));
          res.emit('end');
        });
      });
    };
    return req;
  };
  return { impl, seen };
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'no_error'; } catch (err: any) {
    return err instanceof SafeTransportError ? err.reason : err?.name || 'other';
  }
}

describe('safe provider transport', () => {
  it('rejects a public-looking host that resolves to an IPv4-mapped metadata address', async () => {
    const { impl, seen } = fakeRequest([{ status: 200, body: '{}' }]);
    const f = createSafeProviderFetch({
      requestImpl: impl,
      lookupImpl: async () => [{ address: '::ffff:169.254.169.254', family: 6 }] as any,
    });
    expect(await reasonOf(f('https://llm.example.com/v1/chat/completions', { method: 'POST', body: '{}' }))).toBe('blocked_ip');
    expect(seen).toHaveLength(0);
  });

  it('refuses a redirect to a private IP', async () => {
    const { impl, seen } = fakeRequest([
      { status: 307, headers: { location: 'https://10.0.0.1/v1/chat/completions' } },
      { status: 200, body: '{}' },
    ]);
    const f = createSafeProviderFetch({ requestImpl: impl, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] as any });
    expect(await reasonOf(f('https://llm.example.com/v1/chat/completions', { method: 'POST', body: '{}' }))).toBe('redirect_blocked');
    expect(seen).toHaveLength(1);
  });

  it('pins the validated address and keeps SNI on the hostname', async () => {
    const { impl, seen } = fakeRequest([{ status: 200, body: COMPLETION }]);
    const f = createSafeProviderFetch({ requestImpl: impl, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] as any });
    const res = await f('https://llm.example.com/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'hi' } }] });
    expect(seen[0]).toMatchObject({ host: 'llm.example.com', servername: 'llm.example.com', address: '93.184.216.34', port: 443 });
  });

  it('honours an operator allow-listed private host (http allowed, still pinned)', async () => {
    const { impl, seen } = fakeRequest([{ status: 200, body: COMPLETION }]);
    const allow = (h: string) => h === 'ollama.lan';
    const f = createSafeProviderFetch({
      requestImpl: impl,
      isPrivateHostAllowed: allow,
      lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }] as any,
    });
    const res = await f('http://ollama.lan:11434/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ protocol: 'http:', host: 'ollama.lan', port: 11434, address: '10.0.0.5' });
    expect(seen[0].servername).toBeUndefined();

    // A host NOT on the list stays blocked, and an allow-listed host cannot
    // redirect somewhere else.
    const blocked = createSafeProviderFetch({
      requestImpl: fakeRequest([{ status: 200 }]).impl,
      isPrivateHostAllowed: allow,
      lookupImpl: async () => [{ address: '10.0.0.6', family: 4 }] as any,
    });
    expect(await reasonOf(blocked('http://other.lan/v1'))).toBe('unsafe_scheme');
    expect(await reasonOf(blocked('https://other.lan/v1'))).toBe('blocked_ip');
    const hop = fakeRequest([{ status: 302, headers: { location: 'http://169.254.169.254/' } }, { status: 200 }]);
    const redirecting = createSafeProviderFetch({
      requestImpl: hop.impl,
      isPrivateHostAllowed: allow,
      lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }] as any,
    });
    expect(await reasonOf(redirecting('http://ollama.lan:11434/v1'))).toBe('unsafe_scheme');
    expect(hop.seen).toHaveLength(1);
  });

  it('honours the caller AbortSignal', async () => {
    const { impl } = fakeRequest([{ status: 200, body: '{}' }]);
    const f = createSafeProviderFetch({ requestImpl: impl, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] as any });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await reasonOf(f('https://llm.example.com/v1', { signal: ctrl.signal }))).toBe('AbortError');
  });

  it('caps the buffered response size', async () => {
    const { impl } = fakeRequest([{ status: 200, body: 'x'.repeat(2048) }]);
    const f = createSafeProviderFetch({
      requestImpl: impl,
      maxResponseBytes: 1024,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] as any,
    });
    expect(await reasonOf(f('https://llm.example.com/v1'))).toBe('response_too_large');
  });
});

describe('shared endpoint policy (Core write validation + runtime allow-list)', () => {
  it.each([
    'http://93.184.216.34/v1',
    'https://169.254.169.254/latest',
    'https://[::ffff:169.254.169.254]/',
    'https://127.0.0.1:11434/v1',
    'https://user:pass@93.184.216.34/v1',
    'https://svc.internal/v1',
    'not a url',
  ])('rejects %s', async (url) => {
    expect((await checkWorkspaceProviderBaseUrl(url, {})).ok).toBe(false);
  });

  it('accepts a public https IP literal', async () => {
    expect(await checkWorkspaceProviderBaseUrl('https://93.184.216.34/v1', {})).toEqual({ ok: true });
  });

  it('accepts an operator allow-listed private host, http included', async () => {
    const env = { AI_PROVIDER_PRIVATE_HOSTS: 'ollama.internal, 10.0.0.5' };
    expect(await checkWorkspaceProviderBaseUrl('http://ollama.internal:11434/v1', env)).toEqual({ ok: true });
    expect(await checkWorkspaceProviderBaseUrl('http://10.0.0.5:11434/v1', env)).toEqual({ ok: true });
    expect((await checkWorkspaceProviderBaseUrl('http://10.0.0.6:11434/v1', env)).ok).toBe(false);
    expect(isOperatorAllowedPrivateHost('OLLAMA.internal.', env)).toBe(true);
    expect(isOperatorAllowedPrivateHost('evil-ollama.internal', env)).toBe(false);
  });

  it('runtime honours AI_PROVIDER_PRIVATE_HOSTS for a workspace base URL', async () => {
    process.env.AI_PROVIDER_PRIVATE_HOSTS = '10.0.0.9';
    const denied: any = await complete({ provider: 'ollama', baseUrl: 'http://10.0.0.8:1/v1', endpointScope: 'workspace' });
    expect(denied.message).toMatch(/unsafe_scheme/);
    expect(fetchCalls).toEqual([]);
    // The allow-listed host passes the policy. A pre-aborted signal stops the
    // request right after validation, so no socket is opened in the test.
    const ctrl = new AbortController();
    ctrl.abort();
    const f = providerFetchFor({ provider: 'ollama', baseUrl: 'http://10.0.0.9:1/v1', endpointScope: 'workspace' })!;
    expect(await reasonOf(f('http://10.0.0.9:1/v1', { signal: ctrl.signal }))).toBe('AbortError');
    const g = providerFetchFor({ provider: 'ollama', baseUrl: 'http://10.0.0.8:1/v1', endpointScope: 'workspace' })!;
    expect(await reasonOf(g('http://10.0.0.8:1/v1', { signal: ctrl.signal }))).toBe('unsafe_scheme');
  });
});
