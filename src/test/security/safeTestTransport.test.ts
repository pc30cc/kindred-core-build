import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({}) }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

const {
  createSafeTestFetch,
  SafeTransportError,
  providerHostPolicy,
  OFFICIAL_AI_PROVIDER_HOSTS,
  MAX_TEST_REDIRECTS,
} = await import('../../../server/lib/safeTestTransport.js');

type Hop = { status: number; headers?: Record<string, string>; body?: string; timeout?: boolean };

/** Records every connection attempt and replays scripted hops. */
function fakeRequest(hops: Hop[]) {
  const seen: Array<{ host: string; servername: string; address: string; path: string; method: string; headers: Record<string, string>; body?: string; timeout: number }> = [];
  const rawOptions: any[] = [];
  let i = 0;
  const impl: any = (options: any, cb: (res: any) => void) => {
    const hop = hops[Math.min(i, hops.length - 1)];
    i++;
    rawOptions.push(options);
    const req: any = new EventEmitter();
    let written: string | undefined;
    // Resolve the pinned address by invoking the transport's lookup function.
    let address = '';
    options.lookup(options.host, {}, (_e: unknown, addr: string) => {
      address = addr;
    });
    req.write = (chunk: string) => {
      written = chunk;
    };
    req.destroy = () => {};
    req.end = () => {
      seen.push({
        host: options.host,
        servername: options.servername,
        address,
        path: options.path,
        method: options.method,
        headers: options.headers,
        body: written,
        timeout: options.timeout,
      });
      setImmediate(() => {
        if (hop.timeout) {
          req.emit('timeout');
          return;
        }
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
  return { impl, seen, rawOptions };
}

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function make(hops: Hop[], overrides: Record<string, unknown> = {}) {
  const { impl, seen, rawOptions } = fakeRequest(hops);
  const fetchImpl = createSafeTestFetch({
    lookupImpl: publicDns as never,
    requestImpl: impl,
    ...overrides,
  });
  return { fetchImpl, seen, rawOptions };
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no_error';
  } catch (err) {
    return err instanceof SafeTransportError ? err.reason : 'other';
  }
}

describe('safe test transport — initial URL validation', () => {
  it.each([
    ['http://example.com', 'unsafe_scheme'],
    ['https://user:pass@example.com', 'credentials_not_allowed'],
    ['https://localhost', 'host_not_allowed'],
    ['https://metadata.google.internal', 'host_not_allowed'],
    ['https://svc.internal', 'host_not_allowed'],
    ['https://api.example.localhost', 'host_not_allowed'],
    ['https://127.0.0.1', 'blocked_ip'],
    ['https://169.254.169.254', 'blocked_ip'],
    ['https://10.0.0.1', 'blocked_ip'],
    ['https://192.168.1.1', 'blocked_ip'],
    ['https://[::1]', 'blocked_ip'],
    ['https://[::ffff:127.0.0.1]', 'blocked_ip'],
  ])('rejects %s', async (url, reason) => {
    const { fetchImpl, seen } = make([{ status: 200 }]);
    expect(await reasonOf(fetchImpl(url))).toBe(reason);
    expect(seen).toHaveLength(0);
  });

  it('rejects a trailing-dot bypass of an internal hostname', async () => {
    const { fetchImpl } = make([{ status: 200 }]);
    expect(await reasonOf(fetchImpl('https://metadata.google.internal./x'))).toBe('host_not_allowed');
  });
});

describe('safe test transport — DNS handling', () => {
  it('allows a public IPv4 answer', async () => {
    const { fetchImpl } = make([{ status: 200, body: '{}' }]);
    expect((await fetchImpl('https://api.openai.com/v1/chat/completions')).status).toBe(200);
  });

  it('allows a public IPv6 answer', async () => {
    const { fetchImpl } = make([{ status: 200, body: '{}' }], {
      lookupImpl: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
    });
    expect((await fetchImpl('https://api.openai.com/v1')).status).toBe(200);
  });

  it('rejects when any answer is private', async () => {
    const { fetchImpl, seen } = make([{ status: 200 }], {
      lookupImpl: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    expect(await reasonOf(fetchImpl('https://api.openai.com/v1'))).toBe('blocked_ip');
    expect(seen).toHaveLength(0);
  });

  it('rejects on DNS error and on an empty answer set', async () => {
    const a = make([{ status: 200 }], { lookupImpl: async () => { throw new Error('ENOTFOUND'); } });
    expect(await reasonOf(a.fetchImpl('https://api.openai.com/v1'))).toBe('dns_failure');
    const b = make([{ status: 200 }], { lookupImpl: async () => [] });
    expect(await reasonOf(b.fetchImpl('https://api.openai.com/v1'))).toBe('dns_failure');
  });
});

describe('safe test transport — pinning', () => {
  it('connects to the verified address while keeping hostname for TLS/SNI', async () => {
    const lookupImpl = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const { fetchImpl, seen } = make([{ status: 200, body: '{}' }], { lookupImpl });
    await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-placeholder' },
      body: '{"a":1}',
    });
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(seen[0].address).toBe('93.184.216.34');
    expect(seen[0].host).toBe('api.openai.com');
    expect(seen[0].servername).toBe('api.openai.com');
    expect(seen[0].path).toBe('/v1/chat/completions');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers.Authorization).toBe('Bearer test-placeholder');
    expect(seen[0].body).toBe('{"a":1}');
  });

  it('rebinding after validation cannot change the connected address', async () => {
    let call = 0;
    const lookupImpl = async () => {
      call++;
      return call === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    const { fetchImpl, seen } = make([{ status: 200, body: '{}' }], { lookupImpl });
    await fetchImpl('https://api.openai.com/v1');
    expect(seen[0].address).toBe('93.184.216.34');
    expect(call).toBe(1);
  });
});

describe('safe test transport — redirects', () => {
  it('rejects a redirect to a private IP host', async () => {
    const { fetchImpl } = make([
      { status: 302, headers: { location: 'https://169.254.169.254/latest' } },
      { status: 200 },
    ]);
    expect(await reasonOf(fetchImpl('https://api.openai.com/v1'))).toBe('redirect_blocked');
  });

  it('rejects a same-origin redirect whose re-resolved address is private', async () => {
    let call = 0;
    const lookupImpl = async () => {
      call++;
      return call === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.1.2.3', family: 4 }];
    };
    const { fetchImpl } = make(
      [{ status: 302, headers: { location: 'https://api.openai.com/x' } }, { status: 200 }],
      { lookupImpl },
    );
    expect(await reasonOf(fetchImpl('https://api.openai.com/v1'))).toBe('blocked_ip');
  });

  it('rejects a cross-host redirect for an official provider', async () => {
    const { fetchImpl } = make(
      [{ status: 302, headers: { location: 'https://evil-openai.com/v1' } }, { status: 200 }],
      { isHostAllowed: providerHostPolicy('openai') },
    );
    expect(await reasonOf(fetchImpl('https://api.openai.com/v1'))).toBe('redirect_blocked');
  });

  it('rejects a redirect without Location and one carrying credentials', async () => {
    const a = make([{ status: 302 }, { status: 200 }]);
    expect(await reasonOf(a.fetchImpl('https://api.openai.com/v1'))).toBe('redirect_blocked');
    const b = make([
      { status: 302, headers: { location: 'https://user:pass@api.openai.com/x' } },
      { status: 200 },
    ]);
    expect(await reasonOf(b.fetchImpl('https://api.openai.com/v1'))).toBe('credentials_not_allowed');
  });

  it('rejects a redirect loop / the fourth redirect', async () => {
    const { fetchImpl, seen } = make([
      { status: 302, headers: { location: 'https://a.example.com/1' } },
    ]);
    expect(await reasonOf(fetchImpl('https://a.example.com/0'))).toBe('too_many_redirects');
    expect(seen).toHaveLength(MAX_TEST_REDIRECTS + 1);
  });

  it('follows a same-origin redirect after full re-validation', async () => {
    const { fetchImpl, seen } = make([
      { status: 302, headers: { location: 'https://a.example.com/next' } },
      { status: 200, body: '{"ok":true}' },
    ]);
    const res = await fetchImpl('https://a.example.com/start');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(seen.map((s) => s.host)).toEqual(['a.example.com', 'a.example.com']);
    expect(seen.map((s) => s.path)).toEqual(['/start', '/next']);
  });

  it('preserves method and body across 307/308 and downgrades 303', async () => {
    const keep = make([
      { status: 307, headers: { location: 'https://a.example.com/y' } },
      { status: 200, body: '{}' },
    ]);
    await keep.fetchImpl('https://a.example.com/x', { method: 'POST', body: '{"a":1}' });
    expect(keep.seen[1].method).toBe('POST');
    expect(keep.seen[1].body).toBe('{"a":1}');

    const downgrade = make([
      { status: 303, headers: { location: 'https://a.example.com/y' } },
      { status: 200, body: '{}' },
    ]);
    await downgrade.fetchImpl('https://a.example.com/x', { method: 'POST', body: '{"a":1}' });
    expect(downgrade.seen[1].method).toBe('GET');
    expect(downgrade.seen[1].body).toBeUndefined();
  });
});

describe('safe test transport — timeout', () => {
  it('fails closed when the first request times out', async () => {
    const { fetchImpl } = make([{ status: 0, timeout: true }]);
    expect(await reasonOf(fetchImpl('https://api.openai.com/v1'))).toBe('timeout');
  });

  it('fails closed when a redirected hop times out', async () => {
    const { fetchImpl } = make([
      { status: 302, headers: { location: 'https://b.example.com/x' } },
      { status: 0, timeout: true },
    ]);
    expect(await reasonOf(fetchImpl('https://a.example.com/x'))).toBe('timeout');
  });

  it('shares one deadline across the chain', async () => {
    const { fetchImpl, seen } = make(
      [
        { status: 302, headers: { location: 'https://b.example.com/x' } },
        { status: 200, body: '{}' },
      ],
      { timeoutMs: 5000 },
    );
    await fetchImpl('https://a.example.com/x');
    expect(seen[0].timeout).toBeLessThanOrEqual(5000);
    expect(seen[1].timeout).toBeLessThanOrEqual(seen[0].timeout);
  });
});

describe('provider host policy', () => {
  it('matches official hosts exactly', () => {
    const openai = providerHostPolicy('openai');
    expect(openai?.('api.openai.com')).toBe(true);
    expect(openai?.('evil-openai.com')).toBe(false);
    expect(openai?.('api.openai.com.attacker.tld')).toBe(false);
    expect(Object.keys(OFFICIAL_AI_PROVIDER_HOSTS)).toContain('anthropic');
  });

  it('leaves self-hosted providers unrestricted by host name', () => {
    expect(providerHostPolicy('ollama')).toBeUndefined();
    expect(providerHostPolicy('azure_openai')).toBeUndefined();
  });
});