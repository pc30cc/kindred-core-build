/**
 * The two plugin dialects (server/services/commerce/pluginDialect.ts).
 *
 * The Iran region's packages (every shop that has a plugin installed today)
 * speak X-WebYar-* / webyar-commerce/1 under the module code `webyar`; the
 * International (RESPOK) packages, built from the same sources, speak
 * X-Platform-* / platform-commerce/1 under `respok`. Both deployments accept
 * both, and call each store in the dialect its connection recorded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

interface Sent { url: string; headers: Record<string, string>; body?: string }
const sent: Sent[] = [];
let answers: Array<{ status: number; json: unknown }> = [];

vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async (req: Sent) => {
    sent.push({ url: req.url, headers: req.headers, body: req.body });
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    return { bytes: 10, ...next };
  },
}));

const dialects = await import('../../../server/services/commerce/pluginDialect.js');
const { LEGACY_DIALECT, NEUTRAL_DIALECT, dialectForProtocol, dialectFromRedirectUri, readSignedRequestHeaders, installationHeader, isKnownProtocolVersion } = dialects;
const { buildSignedHeaders, computeSignature, sha256Hex } = await import('../../../server/services/commerce/signing.js');
const { WooCommerceConnector } = await import('../../../server/services/commerce/connectors/woocommerce.js');
const { WhmcsConnector } = await import('../../../server/services/commerce/connectors/whmcs.js');
const { OpenCartConnector, openCartApiRoute } = await import('../../../server/services/commerce/connectors/opencart.js');
const { catalogExportPaths } = await import('../../../server/services/commerce/catalogPaths.js');
const { parseWhmcsAssertion, signWhmcsAssertion } = await import('../../../server/services/commerce/whmcs/identity.js');
const { IRAN_BRAND_PATTERNS } = await import('../../../scripts/build/brandAudit.mjs');

const SECRET = 'dialect-secret';
const INSTALL = '11111111-1111-4111-8111-111111111111';
const ctx = () => ({ workspaceId: 'w', connectionId: 'c', installationId: INSTALL, capabilities: [] as never[], correlationId: 'corr', deadlineAt: Date.now() + 5_000 });

/** The plugin side: verify a request the way the PHP ReplayGuard/Signer does, in a given dialect. */
function verifiesAs(headers: Record<string, string>, prefix: string, protocol: string, method: string, path: string, body: string): boolean {
  const sts = [protocol, method, path, headers[`${prefix}Installation`], headers[`${prefix}Timestamp`], headers[`${prefix}Nonce`], createHash('sha256').update(body).digest('hex')].join('\n');
  return headers[`${prefix}Protocol`] === protocol && createHmac('sha256', SECRET).update(sts).digest('hex') === headers[`${prefix}Signature`];
}

const hasIranBrand = (s: string) => IRAN_BRAND_PATTERNS.some((re: RegExp) => re.test(s));

beforeEach(() => {
  sent.length = 0;
  answers = [];
});

describe('the dialects', () => {
  it('legacy is exactly what the installed Iran plugins speak', () => {
    expect(LEGACY_DIALECT).toMatchObject({ protocol: 'webyar-commerce/1', headerPrefix: 'X-WebYar-', moduleCode: 'webyar', identityAudience: 'webyar-widget', whmcsCanonicalPath: '/webyar/whmcs/v1' });
  });

  it('the neutral dialect carries no trace of the Iran brand', () => {
    const { id: _id, moduleCode: _code, ...wire } = NEUTRAL_DIALECT;
    expect(hasIranBrand(JSON.stringify(wire))).toBe(false);
    expect(NEUTRAL_DIALECT.moduleCode).toBe('respok');
  });

  it('both protocols are known; anything else is not', () => {
    expect(isKnownProtocolVersion('webyar-commerce/1')).toBe(true);
    expect(isKnownProtocolVersion('platform-commerce/1')).toBe(true);
    expect(isKnownProtocolVersion('webyar-commerce/2')).toBe(false);
    expect(dialectForProtocol(null)).toBe(LEGACY_DIALECT);
    expect(dialectForProtocol('unknown')).toBe(LEGACY_DIALECT);
    expect(dialectForProtocol('platform-commerce/1')).toBe(NEUTRAL_DIALECT);
  });

  it('pairing tells the builds apart by the callback the plugin registered', () => {
    expect(dialectFromRedirectUri('https://shop.example/wp-admin/admin-post.php?action=webyar_wc_pairing_callback')).toBe(LEGACY_DIALECT);
    expect(dialectFromRedirectUri('https://shop.example/wp-admin/admin-post.php?action=respok_wc_pairing_callback')).toBe(NEUTRAL_DIALECT);
    expect(dialectFromRedirectUri('https://billing.example/admin/addonmodules.php?module=respok&a=pair_callback')).toBe(NEUTRAL_DIALECT);
    expect(dialectFromRedirectUri('https://billing.example/admin/addonmodules.php?module=webyar&a=pair_callback')).toBe(LEGACY_DIALECT);
    // The host is not looked at.
    expect(dialectFromRedirectUri('https://respok-fans.example/wp-admin/admin-post.php?action=webyar_wc_pairing_callback')).toBe(LEGACY_DIALECT);
    expect(dialectFromRedirectUri('not a url')).toBe(LEGACY_DIALECT);
  });
});

describe('inbound: what a plugin sends', () => {
  const lookup = (h: Record<string, string>) => (name: string) => Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

  it('reads the Iran packages’ headers', () => {
    const h = buildSignedHeaders(SECRET, INSTALL, 'POST', '/api/commerce/events', '{}');
    const r = readSignedRequestHeaders(lookup(h));
    expect(r.dialect).toBe(LEGACY_DIALECT);
    expect(r).toMatchObject({ installationId: INSTALL, protocolVersion: 'webyar-commerce/1' });
    expect(installationHeader(lookup(h))).toBe(INSTALL);
  });

  it('reads the International packages’ headers', () => {
    const h = buildSignedHeaders(SECRET, INSTALL, 'POST', '/api/commerce/events', '{}', NEUTRAL_DIALECT);
    const r = readSignedRequestHeaders(lookup(h));
    expect(r.dialect).toBe(NEUTRAL_DIALECT);
    expect(r).toMatchObject({ installationId: INSTALL, protocolVersion: 'platform-commerce/1', signature: h['X-Platform-Signature'] });
    expect(installationHeader(lookup(h))).toBe(INSTALL);
  });

  it('never mixes them: with any legacy header present, only legacy headers are read', () => {
    const neutral = buildSignedHeaders(SECRET, INSTALL, 'POST', '/x', '{}', NEUTRAL_DIALECT);
    const r = readSignedRequestHeaders(lookup({ ...neutral, 'X-WebYar-Protocol': 'webyar-commerce/1' }));
    expect(r.dialect).toBe(LEGACY_DIALECT);
    expect(r.signature).toBeUndefined();
  });

  it('a WHMCS identity assertion is accepted with either audience, and no other', () => {
    const now = Math.floor(Date.now() / 1000);
    const make = (aud: string) => {
      const payload = { v: 1, typ: 'whmcs.identity', iss: INSTALL, wid: '22222222-2222-4222-8222-222222222222', aud, iat: now, exp: now + 300, jti: 'aabbccddeeff00112233aabb', gid: 'a'.repeat(32), uid: '1', cid: '2', sub: 'b'.repeat(24) };
      const signed = `whmcs1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      return `${signed}.${signWhmcsAssertion('s', signed)}`;
    };
    expect(parseWhmcsAssertion(make('webyar-widget'), '22222222-2222-4222-8222-222222222222').payload.aud).toBe('webyar-widget');
    expect(parseWhmcsAssertion(make('platform-widget'), '22222222-2222-4222-8222-222222222222').payload.aud).toBe('platform-widget');
    expect(() => parseWhmcsAssertion(make('other-widget'), '22222222-2222-4222-8222-222222222222')).toThrow();
  });
});

describe('outbound: Web Yar calling a store in the store’s own dialect', () => {
  it('WooCommerce: legacy connections are called exactly as before', async () => {
    answers.push({ status: 200, json: { protocol_version: 'webyar-commerce/1', capabilities: [] } });
    await new WooCommerceConnector({ origin: 'https://shop.example', installationId: INSTALL, secret: SECRET }).negotiateCapabilities(ctx());
    expect(sent[0].url).toBe('https://shop.example/wp-json/webyar/v1/health');
    expect(verifiesAs(sent[0].headers, 'X-WebYar-', 'webyar-commerce/1', 'GET', '/wp-json/webyar/v1/health', '')).toBe(true);
    expect(sent[0].headers['X-WebYar-Correlation']).toBe('corr');
  });

  it('WooCommerce: a RESPOK plugin is called at respok/v1 with X-Platform-* only', async () => {
    answers.push({ status: 200, json: { protocol_version: 'platform-commerce/1', capabilities: [] } });
    const h = await new WooCommerceConnector({ origin: 'https://shop.example', installationId: INSTALL, secret: SECRET, protocolVersion: 'platform-commerce/1' }).negotiateCapabilities(ctx());
    expect(h.protocolVersion).toBe('platform-commerce/1');
    expect(sent[0].url).toBe('https://shop.example/wp-json/respok/v1/health');
    expect(verifiesAs(sent[0].headers, 'X-Platform-', 'platform-commerce/1', 'GET', '/wp-json/respok/v1/health', '')).toBe(true);
    expect(hasIranBrand(JSON.stringify(sent[0]))).toBe(false);
  });

  it('WooCommerce catalogue export follows the dialect', () => {
    expect(catalogExportPaths(1, null).signedPath).toBe('/wp-json/webyar/v1/catalog/export');
    expect(catalogExportPaths(1, null, NEUTRAL_DIALECT).signedPath).toBe('/wp-json/respok/v1/catalog/export');
  });

  it('WHMCS: the addon folder and signed path follow the dialect', async () => {
    const calls: Sent[] = [];
    const request = async (req: Sent) => { calls.push(req); return { status: 200, json: { ok: true, data: {} }, bytes: 10 }; };
    const base = { origin: 'https://billing.example', baseUrl: 'https://billing.example/whmcs', installationId: INSTALL, secret: SECRET };
    await new WhmcsConnector(base, request as never).call('health', {}, { deadlineAt: Date.now() + 5_000, correlationId: 'corr' });
    await new WhmcsConnector({ ...base, protocolVersion: 'platform-commerce/1' }, request as never).call('health', {}, { deadlineAt: Date.now() + 5_000, correlationId: 'corr' });
    expect(calls[0].url).toBe('https://billing.example/whmcs/modules/addons/webyar/api.php');
    expect(verifiesAs(calls[0].headers, 'X-WebYar-', 'webyar-commerce/1', 'POST', '/webyar/whmcs/v1', calls[0].body as string)).toBe(true);
    expect(calls[1].url).toBe('https://billing.example/whmcs/modules/addons/respok/api.php');
    expect(verifiesAs(calls[1].headers, 'X-Platform-', 'platform-commerce/1', 'POST', '/platform/whmcs/v1', calls[1].body as string)).toBe(true);
    expect(hasIranBrand(JSON.stringify(calls[1]))).toBe(false);
  });

  it('OpenCart: the extension code in the route follows the dialect', async () => {
    expect(openCartApiRoute('4.1.0.4', NEUTRAL_DIALECT)).toBe('extension/respok/module/respok.api');
    expect(openCartApiRoute('3.0.5.1', NEUTRAL_DIALECT)).toBe('extension/module/respok/api');
    answers.push({ status: 200, json: { products: [], page: 1, has_more: false } });
    await new OpenCartConnector({ origin: 'https://shop.example', storeUrl: 'https://shop.example/', externalStoreId: '0', installationId: INSTALL, secret: SECRET, platformVersion: '4.1.0.4', protocolVersion: 'platform-commerce/1' })
      .searchDirect(ctx(), { terms: ['mac'] }, {});
    expect(sent[0].url).toContain('route=extension/respok/module/respok.api&op=products%2Fsearch');
    expect(verifiesAs(sent[0].headers, 'X-Platform-', 'platform-commerce/1', 'POST', '/opencart/v1/products/search', sent[0].body as string)).toBe(true);
    expect(hasIranBrand(JSON.stringify(sent[0]))).toBe(false);
  });

  it('the server-side signature matches for both dialects (same HMAC, its own protocol line)', () => {
    for (const d of [LEGACY_DIALECT, NEUTRAL_DIALECT]) {
      const h = buildSignedHeaders(SECRET, INSTALL, 'POST', '/p', 'b', d);
      expect(h[`${d.headerPrefix}Signature`]).toBe(computeSignature(SECRET, {
        protocolVersion: d.protocol, method: 'POST', canonicalPath: '/p', installationId: INSTALL,
        timestamp: h[`${d.headerPrefix}Timestamp`], nonce: h[`${d.headerPrefix}Nonce`], bodySha256Hex: sha256Hex('b'),
      }));
    }
  });
});
