/**
 * "Call me instead": a verification code delivered by voice call, and the
 * delivery status that lets the screen offer it as soon as an SMS fails.
 *
 *   - Telnyx: a per-code channel overrides the profile's default
 *     (`/verifications/call`); the delivery status of a sent code is read
 *     from `GET /verifications/{id}` and reduced to four states.
 *   - Kavenegar: VerifyLookup `type=call`; `sms/status` codes mapped.
 *   - SMS.ir cannot call; the fallback can be turned off in Super Admin;
 *     both refuse a call before anything is sent.
 *
 * Supabase, `fetch` and the Kavenegar SDK are faked; keys are placeholders.
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
    }),
  }),
}));

const svc = await import('../../../server/services/sms/index.js');
const { mapTelnyxDeliveryStatus, createTelnyxAdapter } = await import('../../../server/services/sms/providers/telnyx.js');
const { mapKavenegarDeliveryStatus } = await import('../../../server/services/sms/providers/kavenegar.js');

const CONFIG = {} as never;
const KEY = 'KEY_placeholder_never_real_0123456789';
const PROFILE = '490001a1-442d-809f-5753-c2332bd10640';
const VERIFICATION = '289232f1-7a10-4dc6-902f-a30f972f64a9';

function row(provider: string, config: Record<string, unknown>): Row {
  return { singleton: true, provider_name: provider, config, is_active: true, updated_at: null };
}

const telnyxRow = (config: Record<string, unknown> = {}) =>
  row('telnyx', { apiKey: KEY, verifyProfileId: PROFILE, channel: 'sms', ...config });

interface Captured { url: string; init: RequestInit }

function telnyxOptions(body: unknown, calls: Captured[] = [], status = 200) {
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

function fakeKavenegar(statusEntries: unknown = [{ messageid: 9, status: 10 }]) {
  const lookups: Record<string, string>[] = [];
  const statuses: Record<string, string>[] = [];
  return {
    lookups,
    statuses,
    options: {
      adapterOptions: {
        timeoutMs: 500,
        createClient: () => ({
          Send: (_p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) => cb([{ messageid: 1 }], 200),
          VerifyLookup: (p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) => {
            lookups.push(p);
            cb([{ messageid: 9 }], 200);
          },
          AccountInfo: (_p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) => cb({ remaincredit: 1 }, 200),
          Status: (p: Record<string, string>, cb: (e: unknown, s?: unknown) => void) => {
            statuses.push(p);
            cb(statusEntries, 200);
          },
        }),
      },
    },
  };
}

beforeEach(() => {
  state.edition = 'international';
  state.row = null;
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('Telnyx — a code by voice call', () => {
  it('a per-code channel overrides the profile default (SMS profile, call asked)', async () => {
    state.row = telnyxRow();
    const calls: Captured[] = [];
    const result = await svc.sendSmsVerification(
      CONFIG,
      { to: '+905301234583', code: '482913', ttlSeconds: 300, channel: 'call' },
      telnyxOptions({ data: { id: VERIFICATION } }, calls),
    );
    expect(result).toEqual({ success: true, provider: 'telnyx', messageId: VERIFICATION, channel: 'call' });
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/verifications/call');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ custom_code: '482913', verify_profile_id: PROFILE });
  });

  it('a call profile still sends an SMS when SMS is asked ("Send SMS instead")', async () => {
    state.row = telnyxRow({ channel: 'call' });
    const calls: Captured[] = [];
    const result = await svc.sendSmsVerification(
      CONFIG,
      { to: '+905301234583', code: '482913', channel: 'sms' },
      telnyxOptions({ data: { id: VERIFICATION } }, calls),
    );
    expect(result).toMatchObject({ success: true, channel: 'sms' });
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/verifications/sms');
  });

  it('no channel: the profile default', async () => {
    state.row = telnyxRow({ channel: 'call' });
    const calls: Captured[] = [];
    const result = await svc.sendSmsVerification(
      CONFIG,
      { to: '+905301234583', code: '482913' },
      telnyxOptions({ data: { id: VERIFICATION } }, calls),
    );
    expect(result).toMatchObject({ success: true, channel: 'call' });
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/verifications/call');
  });

  it('a call is refused, and nothing sent, when the Super Admin turned the fallback off', async () => {
    state.row = telnyxRow({ voiceFallback: false });
    const calls: Captured[] = [];
    const result = await svc.sendSmsVerification(
      CONFIG,
      { to: '+905301234583', code: '482913', channel: 'call' },
      telnyxOptions({ data: { id: VERIFICATION } }, calls),
    );
    expect(result).toMatchObject({ success: false, errorCode: 'sms_provider_feature_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('what the screens may offer: a call by default, none when turned off, call-first profiles always', async () => {
    state.row = telnyxRow();
    await expect(svc.getSmsVerificationDelivery(CONFIG)).resolves.toEqual({ voiceCall: true, defaultChannel: 'sms' });
    state.row = telnyxRow({ voiceFallback: false });
    await expect(svc.getSmsVerificationDelivery(CONFIG)).resolves.toEqual({ voiceCall: false, defaultChannel: 'sms' });
    state.row = telnyxRow({ channel: 'call', voiceFallback: false });
    await expect(svc.getSmsVerificationDelivery(CONFIG)).resolves.toEqual({ voiceCall: true, defaultChannel: 'call' });
    state.row = null;
    await expect(svc.getSmsVerificationDelivery(CONFIG)).resolves.toEqual({ voiceCall: false, defaultChannel: 'sms' });
  });
});

describe('Telnyx — delivery status of a sent code', () => {
  it('maps delivery_status to four states', () => {
    expect(mapTelnyxDeliveryStatus('delivery_failed')).toBe('failed');
    expect(mapTelnyxDeliveryStatus('undelivered')).toBe('failed');
    expect(mapTelnyxDeliveryStatus('delivered')).toBe('delivered');
    expect(mapTelnyxDeliveryStatus('sent')).toBe('pending');
    expect(mapTelnyxDeliveryStatus('queued')).toBe('pending');
    expect(mapTelnyxDeliveryStatus(null)).toBe('unknown');
    expect(mapTelnyxDeliveryStatus('')).toBe('unknown');
  });

  it('reads GET /verifications/{id} — the failed Turkcell case', async () => {
    state.row = telnyxRow();
    const calls: Captured[] = [];
    const result = await svc.getSmsVerificationDeliveryState(
      CONFIG,
      { providerName: 'telnyx', messageId: VERIFICATION },
      telnyxOptions({ data: { id: VERIFICATION, status: 'pending', delivery_status: 'delivery_failed', mccmnc: '28601' } }, calls),
    );
    expect(result).toBe('failed');
    expect(calls[0].url).toBe(`https://api.telnyx.com/v2/verifications/${VERIFICATION}`);
    expect(calls[0].init.method).toBe('GET');
  });

  it('unknown for another vendor\'s message, a bad id, or a Telnyx error — never throws', async () => {
    state.row = telnyxRow();
    const calls: Captured[] = [];
    await expect(svc.getSmsVerificationDeliveryState(CONFIG, { providerName: 'kavenegar', messageId: '9' }, telnyxOptions({}, calls)))
      .resolves.toBe('unknown');
    await expect(svc.getSmsVerificationDeliveryState(CONFIG, { providerName: 'telnyx', messageId: 'not-an-id' }, telnyxOptions({}, calls)))
      .resolves.toBe('unknown');
    await expect(svc.getSmsVerificationDeliveryState(CONFIG, { providerName: 'telnyx', messageId: null }, telnyxOptions({}, calls)))
      .resolves.toBe('unknown');
    expect(calls).toHaveLength(0);
    await expect(
      svc.getSmsVerificationDeliveryState(CONFIG, { providerName: 'telnyx', messageId: VERIFICATION }, telnyxOptions({ errors: [] }, calls, 500)),
    ).resolves.toBe('unknown');
  });

  it('the adapter rejects an unknown channel', async () => {
    const adapter = createTelnyxAdapter(
      { provider: 'telnyx', apiKey: KEY, verifyProfileId: PROFILE, channel: 'sms' },
      telnyxOptions({ data: { id: VERIFICATION } }).telnyxAdapterOptions,
    );
    await expect(adapter.sendVerificationCode({ phoneNumber: '+905301234583', code: '482913', channel: 'fax' as never }))
      .rejects.toMatchObject({ code: 'sms_provider_feature_unavailable' });
  });
});

describe('Kavenegar (Iranian edition) — a code by voice call', () => {
  beforeEach(() => { state.edition = 'iran'; });

  it('VerifyLookup type=call when a call is asked; type=sms otherwise', async () => {
    state.row = row('kavenegar', { apiKey: 'k-placeholder', verifyTemplate: 'verifyLogin' });
    const fake = fakeKavenegar();
    await expect(svc.sendSmsVerification(CONFIG, { to: '09121234567', code: '123456', channel: 'call' }, fake.options))
      .resolves.toMatchObject({ success: true, channel: 'call' });
    await expect(svc.sendSmsVerification(CONFIG, { to: '09121234567', code: '123456' }, fake.options))
      .resolves.toMatchObject({ success: true, channel: 'sms' });
    expect(fake.lookups.map((l) => l.type)).toEqual(['call', 'sms']);
  });

  it('maps sms/status codes and reads them by message id', async () => {
    expect(mapKavenegarDeliveryStatus(10)).toBe('delivered');
    for (const failed of [6, 11, 13, 14]) expect(mapKavenegarDeliveryStatus(failed)).toBe('failed');
    for (const pending of [1, 2, 4, 5]) expect(mapKavenegarDeliveryStatus(pending)).toBe('pending');
    expect(mapKavenegarDeliveryStatus(100)).toBe('unknown');
    expect(mapKavenegarDeliveryStatus('x')).toBe('unknown');

    state.row = row('kavenegar', { apiKey: 'k-placeholder', verifyTemplate: 'verifyLogin' });
    const fake = fakeKavenegar([{ messageid: 9, status: 11 }]);
    await expect(svc.getSmsVerificationDeliveryState(CONFIG, { providerName: 'kavenegar', messageId: '9' }, fake.options))
      .resolves.toBe('failed');
    expect(fake.statuses).toEqual([{ messageid: '9' }]);
  });

  it('SMS.ir cannot call: refused before anything is sent, and not offered', async () => {
    state.row = row('smsir', {
      apiKey: 's-placeholder', lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE',
    });
    const result = await svc.sendSmsVerification(CONFIG, { to: '09121234567', code: '123456', channel: 'call' });
    expect(result).toMatchObject({ success: false, errorCode: 'sms_provider_feature_unavailable' });
    await expect(svc.getSmsVerificationDelivery(CONFIG)).resolves.toEqual({ voiceCall: false, defaultChannel: 'sms' });
    await expect(svc.getSmsVerificationDeliveryState(CONFIG, { providerName: 'smsir', messageId: '77' })).resolves.toBe('unknown');
  });
});
