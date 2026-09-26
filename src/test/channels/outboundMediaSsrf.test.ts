// @vitest-environment node
/**
 * Outbound channel media — SSRF hardening.
 *
 * Attack: an operator (or anyone able to post a message) put
 * `metadata.attachments[].url` = an internal URL on a channel reply. The DB
 * trigger copied it into a `<provider>_outbound_media` job, the worker
 * fetched it (following redirects, unbounded) and uploaded the response to
 * the attacker's Telegram chat.
 *
 * Defence in depth pinned here:
 *   1. Core strips server-owned keys (`attachments`, `channel_*`, …) from
 *      client-supplied message metadata;
 *   2. the worker only trusts the signed media route on its own Core bases;
 *      everything else must resolve to a public address, every redirect hop
 *      is re-validated, and the body is byte-capped;
 *   3. the X client applies the same guard to the URL it fetches itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOutboundMediaCandidate,
  isSignedAttachmentPath,
  isSignedAttachmentUrl,
  outboundMediaCandidates,
  trustedCoreOrigins,
} from '../../../worker/channels/outboundMedia.js';
import { BoundedFetchError, fetchBytesBounded, hostMatches } from '../../../shared/net/boundedFetch.js';
import { sanitizeClientMessageMetadata } from '../../../server/services/channels/clientMessageMetadata.js';

const ATT_ID = '0b9d6c1e-2f3a-4b5c-8d7e-9f0a1b2c3d4e';
const SIGNED_PATH = `/api/conversation-attachments/${ATT_ID}/public?exp=1900000000&sig=${'A'.repeat(43)}`;

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];

function bytesResponse(bytes: number, init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(bytes).fill(7), { status: 200, ...init });
}

describe('client message metadata sanitation (Core)', () => {
  it('drops attachments, channel_* markers and route-owned ids, keeps the rest', () => {
    const out = sanitizeClientMessageMetadata({
      source: 'inbox',
      attachments: [{ url: 'http://169.254.169.254/latest/meta-data/' }],
      channel_inbound: 'true',
      channel_delivery_skip: 'true',
      attachment_id: 'x',
      client_message_id: 'y',
      custom: 1,
    });
    expect(out).toEqual({ source: 'inbox', custom: 1 });
  });

  it('is wired into POST /send-message before the insert', () => {
    const route = readFileSync(resolve(process.cwd(), 'server/routes/conversations.ts'), 'utf8');
    expect(route).toContain('sanitizeClientMessageMetadata(parsed.data.metadata)');
    expect(route).not.toMatch(/\.\.\.\(parsed\.data\.metadata \?\? \{\}\)/);
  });
});

describe('signed media route recognition', () => {
  it('accepts exactly the route mediaOutbound.ts mints', () => {
    expect(isSignedAttachmentPath(SIGNED_PATH)).toBe(true);
    expect(isSignedAttachmentUrl(`https://api.example.com${SIGNED_PATH}`)).toBe(true);
  });

  it('rejects other paths, protocol-relative paths and unsigned routes', () => {
    expect(isSignedAttachmentPath('/internal/channels/ready')).toBe(false);
    expect(isSignedAttachmentPath(`//evil.example${SIGNED_PATH}`)).toBe(false);
    expect(isSignedAttachmentPath(`/api/conversation-attachments/${ATT_ID}/public`)).toBe(false);
    expect(isSignedAttachmentPath(`/api/conversation-attachments/${ATT_ID}/../../admin?exp=1&sig=${'A'.repeat(43)}`)).toBe(false);
  });

  it('only combines a relative path with internal bases when it is the signed route', () => {
    const bases = ['http://core:3000'];
    expect(outboundMediaCandidates({ url: 'https://x.test/a', path: '/metrics' }, bases)).toEqual(['https://x.test/a']);
    expect(outboundMediaCandidates({ url: `https://api.example.com${SIGNED_PATH}`, path: SIGNED_PATH }, bases)).toEqual([
      `https://api.example.com${SIGNED_PATH}`,
      `http://core:3000${SIGNED_PATH}`,
    ]);
  });
});

describe('worker outbound media fetch policy', () => {
  const trusted = trustedCoreOrigins(['http://core:3000/', undefined, 'not a url']);

  it('fetches the signed route from its own (internal) Core base', async () => {
    const fetchImpl = vi.fn(async () => bytesResponse(10));
    const bytes = await fetchOutboundMediaCandidate(`http://core:3000${SIGNED_PATH}`, {
      trustedOrigins: trusted,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: privateLookup,
    });
    expect(bytes.byteLength).toBe(10);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('http://core:3000/'), expect.objectContaining({ redirect: 'manual' }));
  });

  it('refuses a non-signed path on the internal Core base', async () => {
    const fetchImpl = vi.fn(async () => bytesResponse(10));
    await expect(
      fetchOutboundMediaCandidate('http://core:3000/internal/channels/health', {
        trustedOrigins: trusted,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: privateLookup,
      }),
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/admin',
    'http://[::1]/',
    'http://localhost/x',
    'http://metadata.google.internal/computeMetadata/v1/',
    'file:///etc/passwd',
  ])('refuses internal target %s without a request', async (url) => {
    const fetchImpl = vi.fn(async () => bytesResponse(10));
    await expect(
      fetchOutboundMediaCandidate(url, { trustedOrigins: trusted, fetchImpl: fetchImpl as unknown as typeof fetch, lookupImpl: publicLookup }),
    ).rejects.toBeInstanceOf(BoundedFetchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a public-looking hostname that resolves to a private address', async () => {
    const fetchImpl = vi.fn(async () => bytesResponse(10));
    await expect(
      fetchOutboundMediaCandidate('https://rebind.example/x', {
        trustedOrigins: trusted,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: privateLookup,
      }),
    ).rejects.toMatchObject({ reason: 'blocked_ip' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-validates redirect hops: public → internal is refused', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith('https://public.example')
        ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } })
        : bytesResponse(10),
    );
    await expect(
      fetchOutboundMediaCandidate(`https://public.example${SIGNED_PATH}`, {
        trustedOrigins: trusted,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: publicLookup,
      }),
    ).rejects.toMatchObject({ reason: 'blocked_ip' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never follows a redirect from the trusted internal Core base', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://public.example/' } }));
    await expect(
      fetchOutboundMediaCandidate(`http://core:3000${SIGNED_PATH}`, {
        trustedOrigins: trusted,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: publicLookup,
      }),
    ).rejects.toMatchObject({ reason: 'redirect_blocked' });
  });

  it('caps the streamed body size', async () => {
    await expect(
      fetchOutboundMediaCandidate(`http://core:3000${SIGNED_PATH}`, {
        trustedOrigins: trusted,
        maxBytes: 1024,
        fetchImpl: (async () => bytesResponse(4096)) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('refuses a declared Content-Length above the cap before reading', async () => {
    await expect(
      fetchBytesBounded('https://public.example/x', {
        maxBytes: 10,
        validate: () => undefined,
        fetchImpl: (async () => bytesResponse(5, { headers: { 'content-length': '999999' } })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });
});

describe('boundedFetch host allow-list matcher', () => {
  it('matches exact names and wildcard subdomains only', () => {
    expect(hostMatches('scontent.xx.fbcdn.net', ['*.fbcdn.net'])).toBe(true);
    expect(hostMatches('fbcdn.net', ['*.fbcdn.net'])).toBe(false);
    expect(hostMatches('evilfbcdn.net', ['*.fbcdn.net'])).toBe(false);
    expect(hostMatches('LOOKASIDE.FBSBX.COM.', ['lookaside.fbsbx.com'])).toBe(true);
  });
});

describe('X client outbound media URL', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('never fetches an internal URL itself (falls back to sending the link)', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ data: { dm_event_id: '42' } }), { status: 201 });
    }) as typeof fetch;
    const x = await import('../../../channels/providers/x/client.js');
    const credential = JSON.stringify({ api_key: 'k'.repeat(12), api_secret: 's'.repeat(12), access_token: 't'.repeat(12), access_token_secret: 'u'.repeat(12) });
    await x.sendMedia(credential, { chatId: '1-2', kind: 'photo', url: 'http://169.254.169.254/latest/meta-data/', caption: null });
    expect(calls.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });
});
