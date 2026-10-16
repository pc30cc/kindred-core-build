/**
 * SMS service boundary — Telnyx (Telnyx Verify) and edition gating.
 *
 *   - International edition: Telnyx is saved, read (redacted) and used; the
 *     code goes out as `custom_code` with our TTL as `timeout_secs`, to an
 *     E.164 number; Kavenegar and SMS.ir stay blocked.
 *   - Iranian edition: Telnyx is neither saved nor used, and a
 *     stored Telnyx row reads as not configured; Kavenegar works as before.
 *   - Phone verification is on in International only while Telnyx is the
 *     active, complete provider.
 *
 * Supabase and `fetch` are faked; the key is a placeholder.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row {
  singleton: boolean;
  provider_name: string;
  config: Record<string, unknown> | null;
  is_active: boolean;
  updated_at: string | null;
}

const state = vi.hoisted(() => ({
  edition: 'international' as 'iran' | 'international' | null,
  row: null as Row | null,
  upserts: [] as Row[],
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return { ...actual, getPlatformEditionOrNull: async () => state.edition };
});

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }),
      }),
      upsert: async (values: Row) => {
        state.upserts.push(values);
        state.row = { ...values, updated_at: values.updated_at ?? null };
        return { error: null };
      },
    }),
  }),
}));

const svc = await import('../../../server/services/sms/index.js');
const { phoneVerificationEnabled } = await import('../../../server/services/phoneVerification/index.js');
const { toProviderFormat } = await import('../../../server/services/phoneVerification/phone.js');

const CONFIG = {} as never;
const ADMIN = '11111111-1111-1111-1111-111111111111';
const KEY = 'KEY_placeholder_never_real_0123456789';
const PROFILE = '490001a1-442d-809f-5753-c2332bd10640';

function telnyxRow(overrides: Partial<Row> = {}, config: Record<string, unknown> = {}): Row {
  return {
    singleton: true,
    provider_name: 'telnyx',
    config: { apiKey: KEY, verifyProfileId: PROFILE, channel: 'sms', ...config },
    is_active: true,
    updated_at: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function telnyxOptions(status = 200, body: unknown = { data: { id: 'ver-1', status: 'pending' } }, calls: Captured[] = []) {
  return {
    telnyxAdapterOptions: {
      timeoutMs: 500,
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      },
    },
  };
}

beforeEach(() => {
  state.edition = 'international';
  state.row = null;
  state.upserts = [];
  vi.restoreAllMocks();
});

describe('International edition — saving Telnyx', () => {
  it('stores only the whitelisted Telnyx fields and returns a redacted view', async () => {
    const info = await svc.saveSmsProviderConfig(
      CONFIG,
      { providerName: 'telnyx', enabled: true, apiKey: `  ${KEY}  `, verifyProfileId: PROFILE.toUpperCase(), channel: 'call' },
      ADMIN,
    );
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      provider_name: 'telnyx',
      is_active: true,
      config: { apiKey: KEY, verifyProfileId: PROFILE, channel: 'call' },
    });
    expect(Object.keys(state.upserts[0].config ?? {}).sort()).toEqual(['apiKey', 'channel', 'verifyProfileId', 'voiceFallback']);
    expect(info).toMatchObject({
      providerName: 'telnyx', configured: true, enabled: true, hasApiKey: true,
      verifyProfileId: PROFILE, channel: 'call',
      verifyTemplate: null, lineNumber: null, verifyTemplateId: null, verifyParameterName: null,
    });
    expect(JSON.stringify(info)).not.toContain(KEY);
  });

  it('defaults the channel to sms and keeps the stored key on a re-save without one', async () => {
    state.row = telnyxRow();
    await svc.saveSmsProviderConfig(CONFIG, { providerName: 'telnyx', enabled: false, verifyProfileId: PROFILE }, ADMIN);
    expect(state.upserts[0].config).toEqual({ apiKey: KEY, verifyProfileId: PROFILE, channel: 'sms', voiceFallback: true });
    expect(state.upserts[0].is_active).toBe(false);
  });

  it('switching to Telnyx from another vendor requires a fresh key', async () => {
    state.row = { ...telnyxRow(), provider_name: 'kavenegar', config: { apiKey: 'old', verifyTemplate: 'x' } };
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'telnyx', enabled: true, verifyProfileId: PROFILE }, ADMIN),
    ).rejects.toMatchObject({ reason: 'api_key_required' });
  });

  it('rejects a Verify Profile id that is not a UUID and an unknown channel', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'telnyx', enabled: true, apiKey: KEY, verifyProfileId: 'RESPOK' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'invalid_verify_profile_id' });
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'telnyx', enabled: true, apiKey: KEY, verifyProfileId: PROFILE, channel: 'whatsapp' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'invalid_channel' });
    expect(state.upserts).toHaveLength(0);
  });

  it('Kavenegar and SMS.ir stay blocked', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: 'k', verifyTemplate: 'verify' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'smsir', enabled: true, apiKey: 'k', lineNumber: '3000', verifyTemplateId: 1, verifyParameterName: 'CODE' }, ADMIN),
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
    state.row = { ...telnyxRow(), provider_name: 'kavenegar', config: { apiKey: 'k', verifyTemplate: 'verify' } };
    expect(await svc.getSmsProviderInfo(CONFIG)).toMatchObject({ providerName: 'disabled', configured: false });
    expect(await svc.sendSmsVerification(CONFIG, { to: '09121234567', code: '123456' })).toMatchObject({
      success: false, errorCode: 'sms_provider_not_configured',
    });
  });
});

describe('International edition — sending through Telnyx', () => {
  it('delivers our code with custom_code, our TTL and the E.164 number', async () => {
    state.row = telnyxRow();
    const calls: Captured[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await svc.sendSmsVerification(
      CONFIG,
      { to: '+447700900123', code: '482913', ttlSeconds: 300 },
      telnyxOptions(200, { data: { id: 'ver-1' } }, calls),
    );
    expect(result).toEqual({ success: true, provider: 'telnyx', messageId: 'ver-1', channel: 'sms' });
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/verifications/sms');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      phone_number: '+447700900123', verify_profile_id: PROFILE, custom_code: '482913', timeout_secs: 300,
    });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('482913');
    expect(logged).not.toContain('+447700900123');
  });

  it('an Iranian number in the vendors\' local form goes out as E.164 again', async () => {
    state.row = telnyxRow({}, { channel: 'call' });
    const calls: Captured[] = [];
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const to = toProviderFormat('+989121234567');
    expect(to).toBe('09121234567');
    await svc.sendSmsVerification(CONFIG, { to, code: '123456', ttlSeconds: 300 }, telnyxOptions(200, undefined, calls));
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/verifications/call');
    expect(JSON.parse(String(calls[0].init.body)).phone_number).toBe('+989121234567');
  });

  it('anything that is not E.164 is sms_invalid_receptor, without a request', async () => {
    state.row = telnyxRow();
    const calls: Captured[] = [];
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const to of ['447700900123', '07700900123', 'abc']) {
      expect(await svc.sendSmsVerification(CONFIG, { to, code: '123456' }, telnyxOptions(200, undefined, calls))).toMatchObject({
        success: false, provider: 'telnyx', errorCode: 'sms_invalid_receptor',
      });
    }
    expect(calls).toHaveLength(0);
    expect(svc.toTelnyxRecipient('+12025550123')).toBe('+12025550123');
  });

  it('maps a Telnyx refusal to a closed code and returns no payload', async () => {
    state.row = telnyxRow();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await svc.sendSmsVerification(
      CONFIG,
      { to: '+447700900123', code: '123456' },
      telnyxOptions(402, { errors: [{ code: '10038', title: 'Insufficient balance', detail: `key ${KEY}` }] }),
    );
    expect(result).toEqual({ success: false, provider: 'telnyx', errorCode: 'sms_insufficient_credit' });
  });

  it('free-text SMS is not something Telnyx Verify does', async () => {
    state.row = telnyxRow();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const calls: Captured[] = [];
    expect(await svc.sendSms(CONFIG, { to: '+447700900123', body: 'hello' }, telnyxOptions(200, undefined, calls))).toMatchObject({
      success: false, provider: 'telnyx', errorCode: 'sms_provider_feature_unavailable',
    });
    expect(calls).toHaveLength(0);
  });

  it('a disabled or incomplete Telnyx row never sends', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const calls: Captured[] = [];
    state.row = telnyxRow({ is_active: false });
    expect((await svc.sendSmsVerification(CONFIG, { to: '+447700900123', code: '1234' }, telnyxOptions(200, undefined, calls))).errorCode)
      .toBe('sms_provider_disabled');
    state.row = telnyxRow({}, { verifyProfileId: 'not-a-uuid' });
    expect((await svc.sendSmsVerification(CONFIG, { to: '+447700900123', code: '1234' }, telnyxOptions(200, undefined, calls))).errorCode)
      .toBe('sms_provider_not_configured');
    expect(calls).toHaveLength(0);
  });

  it('the connection test reads the Verify Profile and sends nothing', async () => {
    state.row = telnyxRow();
    const calls: Captured[] = [];
    const result = await svc.testSmsProvider(CONFIG, telnyxOptions(200, { data: { id: PROFILE, name: 'RESPOK' } }, calls));
    expect(result).toMatchObject({ success: true, provider: 'telnyx', profileName: 'RESPOK', balance: null, currency: 'USD' });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([`GET https://api.telnyx.com/v2/verify_profiles/${PROFILE}`]);
    const failed = await svc.testSmsProvider(CONFIG, telnyxOptions(401, { errors: [{ detail: KEY }] }));
    expect(failed).toMatchObject({ success: false, errorCode: 'sms_auth_failed' });
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });
});

describe('Phone verification on/off in International follows Telnyx', () => {
  it('off without Telnyx, on with an active complete Telnyx row', async () => {
    state.row = null;
    expect(await svc.isInternationalSmsVerificationActive(CONFIG)).toBe(false);
    expect(await phoneVerificationEnabled(CONFIG)).toBe(false);

    state.row = telnyxRow();
    expect(await svc.isInternationalSmsVerificationActive(CONFIG)).toBe(true);
    expect(await phoneVerificationEnabled(CONFIG)).toBe(true);

    state.row = telnyxRow({ is_active: false });
    expect(await phoneVerificationEnabled(CONFIG)).toBe(false);
    state.row = telnyxRow({}, { apiKey: '' });
    expect(await phoneVerificationEnabled(CONFIG)).toBe(false);
    state.row = telnyxRow({}, { verifyProfileId: 'RESPOK' });
    expect(await phoneVerificationEnabled(CONFIG)).toBe(false);
    // A stored Iranian vendor never switches it on in International.
    state.row = { ...telnyxRow(), provider_name: 'kavenegar', config: { apiKey: 'k', verifyTemplate: 'v' } };
    expect(await phoneVerificationEnabled(CONFIG)).toBe(false);
  });
});

describe('Iranian edition — unchanged, Telnyx hidden', () => {
  beforeEach(() => {
    state.edition = 'iran';
  });

  it('Telnyx is neither saved nor used, and a stored Telnyx row reads as not configured', async () => {
    await expect(
      svc.saveSmsProviderConfig(CONFIG, { providerName: 'telnyx', enabled: true, apiKey: KEY, verifyProfileId: PROFILE }, ADMIN),
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
    expect(state.upserts).toHaveLength(0);

    state.row = telnyxRow();
    expect(await svc.getSmsProviderInfo(CONFIG)).toMatchObject({ providerName: 'disabled', configured: false, enabled: false });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const calls: Captured[] = [];
    expect(await svc.sendSmsVerification(CONFIG, { to: '+447700900123', code: '1234' }, telnyxOptions(200, undefined, calls))).toMatchObject({
      success: false, errorCode: 'sms_provider_not_configured',
    });
    expect(calls).toHaveLength(0);
    expect(await svc.isInternationalSmsVerificationActive(CONFIG)).toBe(false);
  });

  it('phone verification stays always on, with or without a provider', async () => {
    state.row = null;
    expect(await phoneVerificationEnabled(CONFIG)).toBe(true);
    state.edition = null;
    expect(await phoneVerificationEnabled(CONFIG)).toBe(true);
  });

  it('Kavenegar saves and reads exactly as before (Telnyx fields null)', async () => {
    const info = await svc.saveSmsProviderConfig(
      CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: 'k-placeholder', verifyTemplate: 'verifyLogin' }, ADMIN,
    );
    expect(state.upserts[0].config).toEqual({ apiKey: 'k-placeholder', verifyTemplate: 'verifyLogin', voiceFallback: true });
    expect(info).toMatchObject({ providerName: 'kavenegar', configured: true, verifyProfileId: null, channel: null });
  });
});

describe('International phone numbers (pseudo-country ZZ)', () => {
  it('normalizes any E.164 mobile; known countries keep their own rule', async () => {
    const { normalizeInternationalPhone } = await import('../../../server/services/phoneVerification/phone.js');
    expect(normalizeInternationalPhone('+1 (202) 555-0143')).toEqual({ ok: true, e164: '+12025550143', country: 'ZZ' });
    expect(normalizeInternationalPhone('0033612345678')).toEqual({ ok: true, e164: '+33612345678', country: 'ZZ' });
    expect(normalizeInternationalPhone('+۴۴۷۷۰۰۹۰۰۱۲۳')).toEqual({ ok: true, e164: '+447700900123', country: 'GB' });
    expect(normalizeInternationalPhone('+989121234567')).toEqual({ ok: true, e164: '+989121234567', country: 'IR' });
    // A UK landline is refused by the UK rule; no `+` / too short / leading zero are refused.
    expect(normalizeInternationalPhone('+442071234567')).toMatchObject({ ok: false, reason: 'phone_invalid' });
    for (const bad of ['2025550143', '+12345', '+0123456789', '', 'abc']) {
      expect(normalizeInternationalPhone(bad)).toMatchObject({ ok: false, reason: 'phone_invalid' });
    }
    expect(normalizeInternationalPhone(null)).toMatchObject({ ok: false });
  });
});
