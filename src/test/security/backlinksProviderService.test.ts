/**
 * SEO Backlinks provider service boundary — persistence, redaction,
 * resolution and vendor-call mapping. Mirrors
 * src/test/security/smsProviderService.test.ts's shape. The Supabase
 * service client is mocked; no real credential appears here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row {
  singleton: boolean;
  provider_name: string;
  config: Record<string, unknown> | null;
  is_active: boolean;
  updated_at: string | null;
  updated_by?: string;
}

let row: Row | null = null;
let selectError: unknown = null;
let upsertError: unknown = null;
const upserts: Row[] = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: selectError ? null : row, error: selectError }),
        }),
      }),
      upsert: async (values: Row) => {
        if (upsertError) return { error: upsertError };
        upserts.push(values);
        row = { ...values, updated_at: values.updated_at ?? null };
        return { error: null };
      },
    }),
  }),
}));

const svc = await import('../../../server/services/seo/backlinks/index.js');
const CONFIG = {} as never;
const ADMIN = '11111111-1111-1111-1111-111111111111';

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

/** Fake fetch returning a well-formed DataForSEO envelope for backlinks/backlinks/live. */
function fakeFetchOk(items: Array<Record<string, unknown>> = [{ url_from: 'https://a.example/x', url_to: 'https://target.example/', domain_from: 'a.example', anchor: 'click', dofollow: true, rank: 300, domain_from_rank: 400, is_new: true, is_lost: false }]) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/appendix/user_data')) {
      return jsonResponse(200, { tasks: [{ status_code: 20000, result: [{ money_balance: 12.5, currency: 'USD' }] }] });
    }
    return jsonResponse(200, {
      status_code: 20000,
      tasks: [{ status_code: 20000, result: [{ total_count: items.length, items }] }],
    });
  }) as unknown as typeof fetch;
}

function fakeFetchAuthFailed() {
  return vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch;
}

function fakeFetchProviderStatus(statusCode: number, statusMessage: string) {
  return vi.fn(async () => jsonResponse(200, {
    status_code: 20000,
    tasks: [{ status_code: statusCode, status_message: statusMessage, result: null }],
  })) as unknown as typeof fetch;
}

function fakeFetchHttpError(status: number, statusCode: number, statusMessage: string) {
  return vi.fn(async () => jsonResponse(status, {
    status_code: statusCode,
    status_message: statusMessage,
  })) as unknown as typeof fetch;
}

function runtimeOptions(fetchImpl: typeof fetch) {
  return { dataForSeoAdapterOptions: { fetchImpl, timeoutMs: 200 } };
}

function configured(overrides: Partial<Row> = {}): Row {
  return {
    singleton: true,
    provider_name: 'dataforseo',
    config: { login: 'stored-login', password: 'stored-placeholder' },
    is_active: true,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  row = null;
  selectError = null;
  upsertError = null;
  upserts.length = 0;
});

describe('getBacklinksProviderInfo', () => {
  it('reports an unconfigured platform', async () => {
    await expect(svc.getBacklinksProviderInfo(CONFIG)).resolves.toEqual({
      providerName: 'disabled', configured: false, enabled: false, hasCredentials: false, login: null, updatedAt: null,
    });
  });

  it('never returns the stored password', async () => {
    row = configured();
    const info = await svc.getBacklinksProviderInfo(CONFIG);
    expect(JSON.stringify(info)).not.toContain('stored-placeholder');
    expect(info).toMatchObject({ hasCredentials: true, configured: true, enabled: true, login: 'stored-login' });
  });

  it('reports disabled when the row is inactive', async () => {
    row = configured({ is_active: false });
    await expect(svc.getBacklinksProviderInfo(CONFIG)).resolves.toMatchObject({ enabled: false, configured: true });
  });
});

describe('saveBacklinksProviderConfig', () => {
  it('rejects an unsupported vendor', async () => {
    await expect(
      svc.saveBacklinksProviderConfig(CONFIG, { providerName: 'moz', enabled: true, login: 'x', password: 'y' } as never, ADMIN),
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
  });

  it('requires a login on first save', async () => {
    await expect(
      svc.saveBacklinksProviderConfig(CONFIG, { providerName: 'dataforseo', enabled: true, password: 'y' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'login_required' });
  });

  it('requires a password on first save', async () => {
    await expect(
      svc.saveBacklinksProviderConfig(CONFIG, { providerName: 'dataforseo', enabled: true, login: 'x' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'password_required' });
  });

  it('keeps the stored password when the field is omitted', async () => {
    row = configured();
    await svc.saveBacklinksProviderConfig(CONFIG, { providerName: 'dataforseo', enabled: true, login: 'stored-login' }, ADMIN);
    expect(upserts[0].config).toEqual({ login: 'stored-login', password: 'stored-placeholder' });
  });

  it('surfaces a persistence failure', async () => {
    upsertError = { message: 'db down' };
    await expect(
      svc.saveBacklinksProviderConfig(CONFIG, { providerName: 'dataforseo', enabled: true, login: 'x', password: 'y' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'save_failed' });
  });
});

describe('deleteBacklinksProviderConfig', () => {
  it('wipes the credential and disables the provider', async () => {
    row = configured();
    const info = await svc.deleteBacklinksProviderConfig(CONFIG, ADMIN);
    expect(upserts[0]).toMatchObject({ provider_name: 'disabled', is_active: false, config: {} });
    expect(info).toMatchObject({ configured: false, enabled: false, hasCredentials: false });
  });
});

describe('resolution is fail-closed', () => {
  it('fails when nothing is configured', async () => {
    await expect(svc.testBacklinksProvider(CONFIG, runtimeOptions(fakeFetchOk()))).resolves.toMatchObject({
      success: false, errorCode: 'backlinks_provider_not_configured',
    });
  });

  it('fails when the provider is disabled', async () => {
    row = configured({ is_active: false });
    await expect(svc.testBacklinksProvider(CONFIG, runtimeOptions(fakeFetchOk()))).resolves.toMatchObject({
      success: false, errorCode: 'backlinks_provider_disabled',
    });
  });

  it('fails when the credential is incomplete', async () => {
    row = configured({ config: { login: 'stored-login' } });
    await expect(svc.testBacklinksProvider(CONFIG, runtimeOptions(fakeFetchOk()))).resolves.toMatchObject({
      success: false, errorCode: 'backlinks_provider_not_configured',
    });
  });

  it('maps a vendor auth failure to backlinks_auth_failed', async () => {
    row = configured();
    await expect(svc.testBacklinksProvider(CONFIG, runtimeOptions(fakeFetchAuthFailed()))).resolves.toMatchObject({
      success: false, errorCode: 'backlinks_auth_failed',
    });
  });
});

describe('fetchBacklinksForTarget', () => {
  it('normalizes a well-formed vendor response into BacklinksFetchResult', async () => {
    row = configured();
    const { provider, result } = await svc.fetchBacklinksForTarget(CONFIG, 'https://target.example/', 100, runtimeOptions(fakeFetchOk()));
    expect(provider).toBe('dataforseo');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceUrl: 'https://a.example/x', sourceDomain: 'a.example', targetUrl: 'https://target.example/',
      anchorText: 'click', isDofollow: true, isNew: true, isLost: false, domainRank: 400,
    });
    expect(result.referringDomains).toBe(1);
    expect(result.dofollowCount).toBe(1);
    expect(result.newCount).toBe(1);
  });

  it('drops malformed items instead of throwing', async () => {
    row = configured();
    const { result } = await svc.fetchBacklinksForTarget(
      CONFIG, 'https://target.example/', 100,
      runtimeOptions(fakeFetchOk([{ anchor: 'no urls here' }, { url_from: 'https://ok.example/', url_to: 'https://target.example/' }])),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceUrl).toBe('https://ok.example/');
  });

  it('reports a missing Backlinks API subscription instead of an authentication failure', async () => {
    row = configured();
    await expect(svc.fetchBacklinksForTarget(
      CONFIG,
      'https://target.example/',
      100,
      runtimeOptions(fakeFetchProviderStatus(40204, 'Backlinks API subscription required')),
    )).rejects.toMatchObject({
      code: 'backlinks_subscription_required',
      detail: 'Backlinks API subscription required',
    });
  });

  it('reports an IP allowlist restriction from an HTTP error response', async () => {
    row = configured();
    await expect(svc.fetchBacklinksForTarget(
      CONFIG,
      'https://target.example/',
      100,
      runtimeOptions(fakeFetchHttpError(403, 40207, 'IP address is not allowed')),
    )).rejects.toMatchObject({
      code: 'backlinks_ip_not_allowed',
      detail: 'IP address is not allowed',
    });
  });
});
