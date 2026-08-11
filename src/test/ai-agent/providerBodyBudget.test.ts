/**
 * P1 — the advertised total AI budget must cover response BODY streaming and
 * JSON parsing, not just headers. Plus execution-level retry behaviour.
 *
 * Env overrides are applied before importing the module so the module-level
 * bounded policy constants stay small and the suite stays fast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AI_HTTP_TIMEOUT_MS = '1000';
process.env.AI_RETRY_ATTEMPTS = '2';
process.env.AI_TOTAL_BUDGET_MS = '1500';

const mod = await import('../../../server/services/ai/index.js');
const { requestJsonWithRetry, testAIConnection } = mod;

/** Response whose body never finishes unless the abort signal fires. */
function slowBodyResponse(status: number, signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":'));
      const onAbort = () => controller.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      // never completes on its own
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const okBody = {
  choices: [{ message: { content: 'hello' } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

describe('total budget covers response body streaming', () => {
  it('slow successful body aborts within the total deadline', async () => {
    const started = Date.now();
    const fetchImpl = async (_u: any, init: any) => slowBodyResponse(200, init.signal);
    await expect(requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any)).rejects.toThrow(/AI network error|budget/i);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10000);

  it('slow ERROR body (500) is also bounded by the deadline', async () => {
    const started = Date.now();
    const fetchImpl = async (_u: any, init: any) => slowBodyResponse(500, init.signal);
    await expect(requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any)).rejects.toThrow(/AI network error|budget/i);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  it('slow body through the real provider path fails instead of returning a response', async () => {
    const fetchImpl = async (_u: any, init: any) => slowBodyResponse(200, init.signal);
    const r = await testAIConnection({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' } as any, { fetchImpl: fetchImpl as any });
    expect(r.success).toBe(false);
  }, 10000);

  it('normal fast body succeeds', async () => {
    const fetchImpl = async () => jsonResponse(200, okBody);
    const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
    expect(r.ok).toBe(true);
    expect((r.data as any).choices[0].message.content).toBe('hello');
  });

  it('the total wall-clock budget is never reset per attempt', async () => {
    const started = Date.now();
    let n = 0;
    const fetchImpl = async (_u: any, init: any) => { n++; return slowBodyResponse(200, init.signal); };
    await expect(requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(n).toBeLessThanOrEqual(2);
  }, 10000);
});

describe('execution-level retry behaviour', () => {
  beforeEach(() => vi.restoreAllMocks());

  for (const status of [400, 401, 403, 404]) {
    it(`${status} -> exactly 1 request, no retry`, async () => {
      let n = 0;
      const fetchImpl = async () => { n++; return jsonResponse(status, { error: { message: 'nope' } }); };
      const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
      expect(n).toBe(1);
      expect(r.status).toBe(status);
    });
  }

  for (const status of [500, 502, 503, 504]) {
    it(`${status} -> retries once then succeeds`, async () => {
      let n = 0;
      const fetchImpl = async () => { n++; return n === 1 ? jsonResponse(status, { error: { message: 'boom' } }) : jsonResponse(200, okBody); };
      const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
      expect(n).toBe(2);
      expect(r.ok).toBe(true);
    }, 10000);
  }

  it('429 with a short Retry-After retries and returns the second response', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return n === 1 ? jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }) : jsonResponse(200, okBody); };
    const started = Date.now();
    const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  }, 10000);

  it('429 with an absurd Retry-After (600s) does not wait 10 minutes', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return n === 1 ? jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '600' }) : jsonResponse(200, okBody); };
    const started = Date.now();
    const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2500);
    expect(r.status === 200 || r.status === 429).toBe(true);
  }, 10000);

  it('ECONNRESET then success -> retry occurs', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      return jsonResponse(200, okBody);
    };
    const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
  }, 10000);

  it('EAI_AGAIN then success -> bounded retry', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('getaddrinfo EAI_AGAIN api.openai.com'), { code: 'EAI_AGAIN' });
      return jsonResponse(200, okBody);
    };
    const r = await requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any);
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
  }, 10000);

  it('non-transient exception -> no retry', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; throw new RangeError('bad url component'); };
    await expect(requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any)).rejects.toThrow(/AI network error/);
    expect(n).toBe(1);
  });

  it('a hung attempt is aborted and the total budget bounds the run', async () => {
    let n = 0;
    const fetchImpl = (_u: any, init: any) => new Promise<Response>((_res, rej) => {
      n++;
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const started = Date.now();
    await expect(requestJsonWithRetry('https://x/y', {}, 2, 1000, fetchImpl as any)).rejects.toThrow(/AI network error/);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10000);
});
