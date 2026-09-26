// @vitest-environment node
/**
 * Meta (WhatsApp Cloud / Instagram) webhook + media hardening.
 *
 *  - X-Hub-Signature-256 verification (HMAC-SHA256 of the raw body with the
 *    Meta app secret), wired Gateway → Core;
 *  - Core ingest rejects an integration reached through another provider's
 *    webhook path;
 *  - Instagram media downloads only touch Meta hosts and only send the access
 *    token to the Graph API host (never to a webhook-supplied URL);
 *  - WhatsApp media ids must be numeric before they reach a Graph path.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (host: string) => {
    if (host.endsWith('.internal-test')) return [{ address: '10.1.2.3', family: 4 }];
    return [{ address: '157.240.1.35', family: 4 }];
  };
  return { ...actual, lookup, default: { ...actual, lookup } };
});

import {
  appSecretFromCredential,
  isMetaSignedDialect,
  platformMetaAppSecrets,
  verifyMetaSignature,
} from '../../../server/services/channels/metaSignature.js';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

function sign(body: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('X-Hub-Signature-256 verification', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

  it('accepts the correct signature and rejects everything else', () => {
    expect(verifyMetaSignature(body, sign(body, 'app-secret'), ['app-secret'])).toBe(true);
    expect(verifyMetaSignature(body, sign(body, 'app-secret').toUpperCase().replace('SHA256=', 'sha256='), ['app-secret'])).toBe(true);
    expect(verifyMetaSignature(body, sign(body, 'other'), ['app-secret'])).toBe(false);
    expect(verifyMetaSignature(Buffer.from('{"tampered":1}'), sign(body, 'app-secret'), ['app-secret'])).toBe(false);
    expect(verifyMetaSignature(body, null, ['app-secret'])).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', ['app-secret'])).toBe(false);
    expect(verifyMetaSignature(body, sign(body, 'app-secret'), [])).toBe(false);
  });

  it('accepts any of several configured secrets', () => {
    expect(verifyMetaSignature(body, sign(body, 'b'), ['a', 'b'])).toBe(true);
  });

  it('reads the optional app_secret from the credential envelope and META_APP_SECRET', () => {
    expect(appSecretFromCredential(JSON.stringify({ access_token: 'x', app_secret: ' s3cret ' }))).toBe('s3cret');
    expect(appSecretFromCredential(JSON.stringify({ access_token: 'x' }))).toBeNull();
    expect(appSecretFromCredential('not json')).toBeNull();
    expect(platformMetaAppSecrets({ META_APP_SECRET: 'a, b,,' } as NodeJS.ProcessEnv)).toEqual(['a', 'b']);
    expect(platformMetaAppSecrets({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('applies only to the Meta dialects', () => {
    expect(isMetaSignedDialect('whatsapp-cloud')).toBe(true);
    expect(isMetaSignedDialect('instagram-graph')).toBe(true);
    expect(isMetaSignedDialect('telegram-bot')).toBe(false);
  });

  it('is wired end to end: gateway forwards raw body + header, Core verifies', () => {
    const gateway = read('channels/server.ts');
    expect(gateway).toContain("raw_body_b64: rawBody ? rawBody.toString('base64') : undefined");
    expect(gateway).toContain("req.header('x-hub-signature-256')");
    const ingest = read('server/routes/internalChannels.ts');
    expect(ingest).toContain('verifyMetaSignature(raw, parsed.data.signature_256, secrets)');
    expect(ingest).toContain("return res.status(401).json({ error: 'invalid_signature' })");
  });

  it('Core ingest rejects a provider/integration mismatch as an unknown integration', () => {
    const ingest = read('server/routes/internalChannels.ts');
    expect(ingest).toMatch(/if \(integration\.provider !== parsed\.data\.provider\) \{[\s\S]{0,300}unknown_integration/);
  });
});

describe('Instagram media download', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const credential = JSON.stringify({ ig_account_id: '1784', access_token: 'EAAtoken1234567890123456789' });

  it('rejects non-Meta hosts in getFile and downloadFile without a request', async () => {
    const ig = await import('../../../channels/providers/instagram/client.js');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(ig.getFile(credential, 'https://attacker.example/x.jpg')).rejects.toMatchObject({ retryable: false });
    await expect(ig.downloadFile(credential, 'https://attacker.example/x.jpg', 1000)).rejects.toMatchObject({ retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never sends the access token to a CDN host', async () => {
    const ig = await import('../../../channels/providers/instagram/client.js');
    const seen: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get('authorization') });
      return new Response(new Uint8Array(4), { status: 200 });
    }) as typeof fetch;
    const bytes = await ig.downloadFile(credential, 'https://scontent.xx.fbcdn.net/v/t1/abc.jpg?oh=1&oe=2', 1000);
    expect(bytes.byteLength).toBe(4);
    expect(seen).toEqual([{ url: 'https://scontent.xx.fbcdn.net/v/t1/abc.jpg?oh=1&oe=2', auth: null }]);
  });

  it('refuses a redirect off Meta hosts and never forwards the token', async () => {
    const ig = await import('../../../channels/providers/instagram/client.js');
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } });
    }) as typeof fetch;
    await expect(ig.downloadFile(credential, 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', 1000)).rejects.toMatchObject({
      retryable: false,
    });
    expect(seen).toEqual(['https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1']);
  });

  it('enforces the byte cap while streaming', async () => {
    const ig = await import('../../../channels/providers/instagram/client.js');
    globalThis.fetch = (async () => new Response(new Uint8Array(5000), { status: 200 })) as typeof fetch;
    await expect(ig.downloadFile(credential, 'https://scontent.cdninstagram.com/a.mp4', 1000)).rejects.toMatchObject({
      httpStatus: 413,
    });
  });
});

describe('WhatsApp media id validation', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('refuses a non-numeric media id before any Graph call', async () => {
    const wa = await import('../../../channels/providers/whatsapp/client.js');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const credential = JSON.stringify({ phone_number_id: '123456', access_token: 'EAAtoken1234567890123456789' });
    await expect(wa.getFile(credential, '123456/messages')).rejects.toMatchObject({ retryable: false });
    await expect(wa.getFile(credential, '../me?fields=id')).rejects.toMatchObject({ retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not replay the token to a cross-origin redirect target', async () => {
    const wa = await import('../../../channels/providers/whatsapp/client.js');
    const seen: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.startsWith('https://lookaside.fbsbx.com/')) {
        return new Response(null, { status: 302, headers: { location: 'https://mmg.whatsapp.net/d/f/abc.enc' } });
      }
      return new Response(new Uint8Array(3), { status: 200 });
    }) as typeof fetch;
    const credential = JSON.stringify({ phone_number_id: '123456', access_token: 'EAAtoken1234567890123456789' });
    const bytes = await wa.downloadFile(credential, 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', 1000);
    expect(bytes.byteLength).toBe(3);
    expect(seen[0].auth).toBe('Bearer EAAtoken1234567890123456789');
    expect(seen[1]).toEqual({ url: 'https://mmg.whatsapp.net/d/f/abc.enc', auth: null });
  });
});
