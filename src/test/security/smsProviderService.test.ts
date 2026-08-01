/**
 * SMS service boundary — persistence, redaction, resolution and logging.
 * The Supabase service client is mocked; no real credential appears here.
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

const svc = await import('../../../server/services/sms/index.js');
const CONFIG = {} as never;
const ADMIN = '11111111-1111-1111-1111-111111111111';

function fakeAdapter(behaviour: 'ok' | 'auth' = 'ok') {
  return {
    adapterOptions: {
      timeoutMs: 200,
      createClient: () => ({
        Send: (_p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) =>
          behaviour === 'ok' ? cb([{ messageid: 1 }], 200) : cb([], 401),
        VerifyLookup: (_p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) =>
          behaviour === 'ok' ? cb([{ messageid: 2 }], 200) : cb([], 401),
        AccountInfo: (_p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) =>
          behaviour === 'ok' ? cb([{ remaincredit: 12345, type: 'master' }], 200) : cb([], 401),
      }),
    },
  };
}

function configured(overrides: Partial<Row> = {}): Row {
  return {
    singleton: true,
    provider_name: 'kavenegar',
    config: { apiKey: 'stored-placeholder', verifyTemplate: 'verifyLogin' },
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

describe('getSmsProviderInfo', () => {
  it('reports an unconfigured platform', async () => {
    await expect(svc.getSmsProviderInfo(CONFIG)).resolves.toEqual({
      providerName: 'disabled', configured: false, enabled: false,
      hasApiKey: false, sender: null, verifyTemplate: null,
      lineNumber: null, verifyTemplateId: null, verifyParameterName: null,
      updatedAt: null,
    });
  });

  it('never returns the stored credential', async () => {
    row = configured({ config: { apiKey: 'stored-placeholder', verifyTemplate: 'verifyLogin', sender: '10008663' } });
    const info = await svc.getSmsProviderInfo(CONFIG);
    expect(JSON.stringify(info)).not.toContain('stored-placeholder');
    expect(info).toMatchObject({ hasApiKey: true, configured: true, enabled: true, sender: '10008663' });
  });

  it('reports disabled when the row is inactive', async () => {
    row = configured({ is_active: false });
    await expect(svc.getSmsProviderInfo(CONFIG)).resolves.toMatchObject({ enabled: false, configured: true });
  });
});

describe('saveSmsProviderConfig', () => {
  it('rejects an unsupported vendor', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'twilio', enabled: true, apiKey: 'x', verifyTemplate: 'verifyLogin' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
  });

  it('rejects an invalid verification template', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: 'x', verifyTemplate: 'verify login' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'invalid_verify_template' });
  });

  it('requires an API key on first save', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, verifyTemplate: 'verifyLogin' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'api_key_required' });
  });

  it('keeps the stored credential when the key field is omitted', async () => {
    row = configured();
    await svc.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, verifyTemplate: 'newTemplate' }, ADMIN);
    expect(upserts[0].config).toEqual({ apiKey: 'stored-placeholder', verifyTemplate: 'newTemplate' });
  });

  it('keeps the stored credential when the key field is blank', async () => {
    row = configured();
    await svc.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: '   ', verifyTemplate: 'verifyLogin' }, ADMIN);
    expect(upserts[0].config).toMatchObject({ apiKey: 'stored-placeholder' });
  });

  it('drops non-whitelisted keys', async () => {
    await svc.saveSmsProviderConfig(
      CONFIG,
      { providerName: 'kavenegar', enabled: true, apiKey: 'new-placeholder', sender: '10008663', verifyTemplate: 'verifyLogin', evil: 'x' } as never,
      ADMIN,
    );
    expect(Object.keys(upserts[0].config ?? {}).sort()).toEqual(['apiKey', 'sender', 'verifyTemplate']);
  });

  it('surfaces a persistence failure', async () => {
    upsertError = { message: 'db down' };
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: 'k', verifyTemplate: 'verifyLogin' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'save_failed' });
  });
});

describe('deleteSmsProviderConfig', () => {
  it('wipes the credential and disables the provider', async () => {
    row = configured();
    const info = await svc.deleteSmsProviderConfig(CONFIG, ADMIN);
    expect(upserts[0]).toMatchObject({ provider_name: 'disabled', is_active: false, config: {} });
    expect(info).toMatchObject({ configured: false, enabled: false, hasApiKey: false });
  });
});

describe('resolution is fail-closed', () => {
  it('fails when nothing is configured', async () => {
    await expect(svc.testSmsProvider(CONFIG, fakeAdapter())).resolves.toMatchObject({
      success: false, errorCode: 'sms_provider_not_configured',
    });
  });

  it('fails when the provider is disabled', async () => {
    row = configured({ is_active: false });
    await expect(svc.testSmsProvider(CONFIG, fakeAdapter())).resolves.toMatchObject({
      success: false, errorCode: 'sms_provider_disabled',
    });
  });

  it('fails when the vendor is unsupported', async () => {
    row = configured({ provider_name: 'twilio' });
    await expect(svc.testSmsProvider(CONFIG, fakeAdapter())).resolves.toMatchObject({
      success: false, errorCode: 'sms_provider_not_configured',
    });
  });

  it('fails when the credential is missing', async () => {
    row = configured({ config: { verifyTemplate: 'verifyLogin' } });
    await expect(svc.testSmsProvider(CONFIG, fakeAdapter())).resolves.toMatchObject({
      success: false, errorCode: 'sms_provider_not_configured',
    });
  });

  it('fails when the verification template is missing', async () => {
    row = configured({ config: { apiKey: 'stored-placeholder' } });
    await expect(svc.sendSmsVerification(CONFIG, { to: '09120000000', code: '123456' }, fakeAdapter()))
      .resolves.toMatchObject({ success: false, errorCode: 'sms_template_not_found' });
  });
});

describe('send paths', () => {
  it('sends a verification code through the active provider', async () => {
    row = configured();
    await expect(svc.sendSmsVerification(CONFIG, { to: '09120000000', code: '123456' }, fakeAdapter()))
      .resolves.toEqual({ success: true, provider: 'kavenegar', messageId: '2' });
  });

  it('normalizes a provider auth failure instead of throwing', async () => {
    row = configured();
    await expect(svc.sendSms(CONFIG, { to: '09120000000', body: 'hi' }, fakeAdapter('auth')))
      .resolves.toMatchObject({ success: false, errorCode: 'sms_auth_failed' });
  });

  it('logs a masked recipient and never the code or credential', async () => {
    row = configured();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await svc.sendSmsVerification(CONFIG, { to: '+989120000067', code: '654321' }, fakeAdapter());
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('654321');
    expect(logged).not.toContain('stored-placeholder');
    expect(logged).not.toContain('+989120000067');
    expect(logged).toContain('recipient_masked');
    spy.mockRestore();
  });
});

describe('testSmsProvider', () => {
  it('returns sanitized account info on success', async () => {
    row = configured();
    const result = await svc.testSmsProvider(CONFIG, fakeAdapter());
    expect(result).toMatchObject({ success: true, provider: 'kavenegar', balance: 12345, currency: 'IRR', accountType: 'master' });
    expect(JSON.stringify(result)).not.toContain('stored-placeholder');
  });
});

// ─── SMS.ir vendor ──────────────────────────────────────────────

function smsIrRow(config: Record<string, unknown> = {}): Row {
  return {
    singleton: true,
    provider_name: 'smsir',
    config: {
      apiKey: 'stored-placeholder',
      lineNumber: '30007732',
      verifyTemplateId: 100000,
      verifyParameterName: 'CODE',
      ...config,
    },
    is_active: true,
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function fakeSmsIr(behaviour: 'ok' | 'auth' = 'ok') {
  const calls: Record<string, unknown[]> = { bulk: [], verify: [], credit: [] };
  const fail = () => Promise.reject(new Error('HTTP error! status: 401 - Unauthorized'));
  return {
    calls,
    options: {
      smsIrAdapterOptions: {
        timeoutMs: 200,
        createClient: (_k: string, line: number) => ({
          sendBulk: (message: string, mobiles: string[], _d?: number, custom?: number) => {
            calls.bulk.push({ message, mobiles, line, custom });
            return behaviour === 'ok'
              ? Promise.resolve({ status: 1, message: 'ok', data: { packId: 'p1', messageIds: [55], cost: 1 } })
              : fail();
          },
          sendVerifyCode: (mobile: string, templateId: number, params: unknown) => {
            calls.verify.push({ mobile, templateId, params });
            return behaviour === 'ok'
              ? Promise.resolve({ status: 1, message: 'ok', data: { messageId: 77, cost: 1 } })
              : fail();
          },
          getCredit: () => {
            calls.credit.push({});
            return behaviour === 'ok'
              ? Promise.resolve({ status: 1, message: 'ok', data: 4200 })
              : fail();
          },
        }),
      },
    },
  };
}

describe('SMS.ir configuration', () => {
  it('stores only the SMS.ir whitelisted keys', async () => {
    await svc.saveSmsProviderConfig(
      CONFIG,
      {
        providerName: 'smsir', enabled: true, apiKey: 'new-placeholder',
        lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE',
        sender: '10008663', verifyTemplate: 'verifyLogin',
      } as never,
      ADMIN,
    );
    expect(Object.keys(upserts[0].config ?? {}).sort()).toEqual([
      'apiKey', 'lineNumber', 'verifyParameterName', 'verifyTemplateId',
    ]);
  });

  it('rejects a non-numeric line number', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'smsir', enabled: true, apiKey: 'k', lineNumber: '3000-77', verifyTemplateId: 1, verifyParameterName: 'CODE' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'invalid_line_number' });
  });

  it('rejects a non-positive template id', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'smsir', enabled: true, apiKey: 'k', lineNumber: '30007732', verifyTemplateId: 0, verifyParameterName: 'CODE' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'invalid_verify_template_id' });
  });

  it('rejects an invalid parameter name', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'smsir', enabled: true, apiKey: 'k', lineNumber: '30007732', verifyTemplateId: 1, verifyParameterName: 'my code' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'invalid_verify_parameter_name' });
  });

  it('requires a fresh API key when switching vendors', async () => {
    row = configured();
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'smsir', enabled: true, lineNumber: '30007732', verifyTemplateId: 1, verifyParameterName: 'CODE' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'api_key_required' });
  });

  it('wipes the previous vendor fields when switching', async () => {
    row = configured({ config: { apiKey: 'stored-placeholder', verifyTemplate: 'verifyLogin', sender: '10008663' } });
    await svc.saveSmsProviderConfig(
      CONFIG,
      { providerName: 'smsir', enabled: true, apiKey: 'new-placeholder', lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE' },
      ADMIN,
    );
    expect(upserts[0].config).toEqual({
      apiKey: 'new-placeholder', lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE',
    });
    expect(JSON.stringify(upserts[0].config)).not.toContain('stored-placeholder');
  });

  it('keeps the credential when re-saving the same vendor', async () => {
    row = smsIrRow();
    await svc.saveSmsProviderConfig(
      CONFIG,
      { providerName: 'smsir', enabled: true, lineNumber: '30007732', verifyTemplateId: 100001, verifyParameterName: 'CODE' },
      ADMIN,
    );
    expect(upserts[0].config).toMatchObject({ apiKey: 'stored-placeholder', verifyTemplateId: 100001 });
  });

  it('exposes the redacted SMS.ir fields without the credential', async () => {
    row = smsIrRow();
    const info = await svc.getSmsProviderInfo(CONFIG);
    expect(info).toMatchObject({
      providerName: 'smsir', configured: true, enabled: true, hasApiKey: true,
      lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE',
    });
    expect(JSON.stringify(info)).not.toContain('stored-placeholder');
  });
});

describe('SMS.ir runtime', () => {
  it('sends a verification code with the configured template and parameter', async () => {
    row = smsIrRow();
    const fake = fakeSmsIr();
    await expect(svc.sendSmsVerification(CONFIG, { to: '09120000000', code: '123456' }, fake.options))
      .resolves.toEqual({ success: true, provider: 'smsir', messageId: '77' });
    expect(fake.calls.verify[0]).toMatchObject({
      mobile: '09120000000', templateId: 100000, params: [{ name: 'CODE', value: '123456' }],
    });
  });

  it('sends a plain SMS on the configured line', async () => {
    row = smsIrRow();
    const fake = fakeSmsIr();
    await expect(svc.sendSms(CONFIG, { to: '09120000000', body: 'hi' }, fake.options))
      .resolves.toEqual({ success: true, provider: 'smsir', messageId: '55' });
    expect(fake.calls.bulk[0]).toMatchObject({ line: 30007732 });
  });

  it('returns sanitized credit info from the connection test', async () => {
    row = smsIrRow();
    const result = await svc.testSmsProvider(CONFIG, fakeSmsIr().options);
    expect(result).toMatchObject({ success: true, provider: 'smsir', balance: 4200, currency: 'IRR' });
    expect(JSON.stringify(result)).not.toContain('stored-placeholder');
  });

  it('normalizes an auth failure instead of throwing', async () => {
    row = smsIrRow();
    await expect(svc.testSmsProvider(CONFIG, fakeSmsIr('auth').options))
      .resolves.toMatchObject({ success: false, errorCode: 'sms_auth_failed' });
  });

  it('fails closed when the line number is missing', async () => {
    row = smsIrRow({ lineNumber: undefined });
    await expect(svc.testSmsProvider(CONFIG, fakeSmsIr().options))
      .resolves.toMatchObject({ success: false, errorCode: 'sms_provider_not_configured' });
  });

  it('fails closed when the template id is missing', async () => {
    row = smsIrRow({ verifyTemplateId: undefined });
    await expect(svc.sendSmsVerification(CONFIG, { to: '09120000000', code: '1' }, fakeSmsIr().options))
      .resolves.toMatchObject({ success: false, errorCode: 'sms_template_not_found' });
  });

  it('never logs the code or the credential', async () => {
    row = smsIrRow();
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await svc.sendSmsVerification(CONFIG, { to: '+989120000067', code: '654321' }, fakeSmsIr().options);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('654321');
    expect(logged).not.toContain('stored-placeholder');
    expect(logged).toContain('recipient_masked');
    spy.mockRestore();
  });
});
