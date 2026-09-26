/**
 * KB Builder crawler (worker/intelligence/processor.ts) SSRF regression.
 *
 * The processor used to run its own weak guard: `redirect: 'follow'` (hops
 * never re-checked), a private-IP regex that missed 127/8 (except .1), 0/8,
 * 100.64/10 and IPv4-mapped IPv6, fail-OPEN on DNS errors, and a check-then-
 * fetch DNS-rebinding gap. It now goes through the shared hardened transport
 * (safeCrawlFetch). These tests drive the real `fetchPage` with only the
 * socket (fetchImpl) and resolver (lookupImpl) stubbed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../server/services/ai-kb/credits.js', () => ({
  consumeAiCredits: async () => ({ success: true }),
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({
  logGateBypass: async () => {},
  isGlobalAdmin: async () => false,
}));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({}) }));

const { fetchPage } = await import('../../../worker/intelligence/processor.js');

const ROOT = 'docs.example.com';
type Answer = { address: string; family: number };
type FetchImpl = NonNullable<Parameters<typeof fetchPage>[2]>['fetchImpl'];

/** Per-host DNS table; unknown hosts fail like NXDOMAIN. */
function dns(table: Record<string, Answer[] | Error>) {
  return async (host: string) => {
    const hit = table[host];
    if (!hit) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    if (hit instanceof Error) throw hit;
    return hit;
  };
}

const PUBLIC: Answer[] = [{ address: '93.184.216.34', family: 4 }];

function html(body = '<html><title>ok</title>ok</html>', headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

describe('KB Builder fetchPage — legitimate crawling keeps working', () => {
  it('fetches an HTML page on the verified root domain', async () => {
    const fetchImpl = vi.fn(async () => html());
    const r = await fetchPage(`https://${ROOT}/`, ROOT, { fetchImpl: fetchImpl as unknown as FetchImpl, lookupImpl: dns({ [ROOT]: PUBLIC }) });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.html).toContain('ok');
    expect(r.bytes).toBeGreaterThan(0);
    // Manual redirects + our user agent on the wire.
    const init = (fetchImpl.mock.calls[0] as unknown as [unknown, { redirect: string; headers: Record<string, string> }])[1];
    expect(init.redirect).toBe('manual');
    expect(init.headers['user-agent']).toMatch(/AiKbBuilder/);
  });

  it('follows a same-root redirect (apex → www) after re-validating the hop', async () => {
    const seen: string[] = [];
    const fetchImpl = async (u: unknown) => {
      seen.push(String(u));
      return String(u).startsWith(`https://${ROOT}/`) ? redirect(`https://www.${ROOT}/en/`) : html();
    };
    const r = await fetchPage(`https://${ROOT}/`, ROOT, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      lookupImpl: dns({ [ROOT]: PUBLIC, [`www.${ROOT}`]: PUBLIC }),
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([`https://${ROOT}/`, `https://www.${ROOT}/en/`]);
  });

  it('keeps the off-domain, non-html and size-cap rejections', async () => {
    const lookupImpl = dns({ [ROOT]: PUBLIC });
    expect((await fetchPage('https://evil.test/', ROOT, { fetchImpl: (async () => html()) as unknown as FetchImpl, lookupImpl })).reason)
      .toBe('off_domain');
    expect((await fetchPage('ftp://docs.example.com/', ROOT, { lookupImpl })).reason).toBe('bad_protocol');
    const pdf = await fetchPage(`https://${ROOT}/a.pdf`, ROOT, {
      fetchImpl: (async () => new Response('x', { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as FetchImpl,
      lookupImpl,
    });
    expect(pdf.reason).toBe('non_html');
    const big = await fetchPage(`https://${ROOT}/big`, ROOT, {
      fetchImpl: (async () => html('x'.repeat(10), { 'content-length': String(50_000_000) })) as unknown as FetchImpl,
      lookupImpl,
    });
    expect(big.reason).toBe('too_large');
  });
});

describe('KB Builder fetchPage — SSRF', () => {
  it('blocks a redirect to the cloud metadata IP (hop is re-validated, never fetched)', async () => {
    const fetchImpl = vi.fn(async () => redirect('http://169.254.169.254/latest/meta-data/'));
    const r = await fetchPage(`https://${ROOT}/`, ROOT, { fetchImpl: fetchImpl as unknown as FetchImpl, lookupImpl: dns({ [ROOT]: PUBLIC }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('redirect_unsafe');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect to an IPv4-mapped IPv6 metadata literal', async () => {
    const fetchImpl = vi.fn(async () => redirect('http://[::ffff:169.254.169.254]/latest/'));
    const r = await fetchPage(`https://${ROOT}/`, ROOT, { fetchImpl: fetchImpl as unknown as FetchImpl, lookupImpl: dns({ [ROOT]: PUBLIC }) });
    expect(r.reason).toBe('redirect_unsafe');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a same-root redirect whose host resolves to a private address', async () => {
    const fetchImpl = vi.fn(async () => redirect(`https://internal.${ROOT}/admin`));
    const r = await fetchPage(`https://${ROOT}/`, ROOT, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      lookupImpl: dns({ [ROOT]: PUBLIC, [`internal.${ROOT}`]: [{ address: '10.0.0.7', family: 4 }] }),
    });
    expect(r.reason).toBe('redirect_unsafe');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect that leaves the verified root domain', async () => {
    const fetchImpl = vi.fn(async () => redirect('https://attacker.test/'));
    const r = await fetchPage(`https://${ROOT}/`, ROOT, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      lookupImpl: dns({ [ROOT]: PUBLIC, 'attacker.test': PUBLIC }),
    });
    expect(r.reason).toBe('redirect_unsafe');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['::ffff:169.254.169.254', 6],
    ['::ffff:a9fe:a9fe', 6],
    ['::ffff:127.0.0.1', 6],
    ['127.0.0.2', 4],
    ['127.255.255.254', 4],
    ['0.0.0.0', 4],
    ['0.1.2.3', 4],
    ['100.64.0.1', 4],
    ['169.254.169.254', 4],
    ['fd00::1', 6],
  ])('refuses a root domain whose DNS answer is %s', async (address, family) => {
    const fetchImpl = vi.fn(async () => html());
    const r = await fetchPage(`https://${ROOT}/`, ROOT, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      lookupImpl: dns({ [ROOT]: [{ address, family }] }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsafe_host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when ANY answer is private (mixed public/private)', async () => {
    const fetchImpl = vi.fn(async () => html());
    const r = await fetchPage(`https://${ROOT}/`, ROOT, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      lookupImpl: dns({ [ROOT]: [...PUBLIC, { address: '::ffff:169.254.169.254', family: 6 }] }),
    });
    expect(r.reason).toBe('unsafe_host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails CLOSED on DNS errors and empty answers (no CRAWLER_STRICT_DNS escape hatch)', async () => {
    const prev = process.env.CRAWLER_STRICT_DNS;
    delete process.env.CRAWLER_STRICT_DNS;
    try {
      const fetchImpl = vi.fn(async () => html());
      const err = await fetchPage(`https://${ROOT}/`, ROOT, {
        fetchImpl: fetchImpl as unknown as FetchImpl,
        lookupImpl: dns({ [ROOT]: Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }) }),
      });
      expect(err.ok).toBe(false);
      expect(err.reason).toBe('unsafe_host');
      expect(err.detail).toBe('dns_failure');
      const empty = await fetchPage(`https://${ROOT}/`, ROOT, { fetchImpl: fetchImpl as unknown as FetchImpl, lookupImpl: dns({ [ROOT]: [] }) });
      expect(empty.reason).toBe('unsafe_host');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.CRAWLER_STRICT_DNS = prev;
    }
  });

  it('uses the pinned connect-time transport when no socket is injected', async () => {
    // No fetchImpl: the real pinnedFetch (node:http with a validating lookup)
    // runs. A loopback answer must be refused before any connection attempt.
    const r = await fetchPage(`https://${ROOT}/`, ROOT, {
      lookupImpl: dns({ [ROOT]: [{ address: '127.0.0.1', family: 4 }] }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsafe_host');
  });
});
