/**
 * Editions phase 3, server side (International = region_mode != 'iran').
 *
 *   - Calendar & time zone: invitation e-mails, the
 *     help-center article date and the operator's default availability zone
 *     are Jalali / Tehran in the Iranian edition only.
 *   - Phone: SMS phone verification (its only vendors are Iranian) is never
 *     required in International, and no code is sent; Iranian SMS vendors are
 *     neither saved nor used there.
 *   - Bale: not listed (plugins, plan capabilities) nor installable outside Iran.
 *
 * Every Iranian-edition output is pinned unchanged (guards below), including
 * while the edition is unknown (it then behaves as before).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international' | null,
  smsRow: null as Record<string, unknown> | null,
  workspace: { id: 'ws-1', owner_id: 'owner-1' } as Record<string, unknown> | null,
  phoneVerified: false,
  rpcCalls: [] as string[],
  rpcArgs: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return { ...actual, getPlatformEditionOrNull: async () => state.edition };
});

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit', 'order']) b[m] = () => b;
      b.maybeSingle = async () => ({
        data: table === 'platform_sms_provider_config' ? state.smsRow : table === 'workspaces' ? state.workspace : null,
        error: null,
      });
      b.upsert = async () => ({ error: null });
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      state.rpcCalls.push(name);
      state.rpcArgs.push({ name, args });
      if (name === 'is_workspace_member') return { data: true, error: null };
      if (name === 'workspace_owner_phone_verified') return { data: state.phoneVerified, error: null };
      if (name === 'phone_verification_state') {
        return { data: { phone: null, verified: false, hasActiveChallenge: false }, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const { formatExpiry, renderInviteEmail } = await import('../../../server/services/invitations/notificationTemplates.js');
const { defaultTimezone } = await import('../../../server/routes/availability.js');
const phone = await import('../../../server/services/phoneVerification/index.js');
const sms = await import('../../../server/services/sms/index.js');
const { isChannelAllowedInEdition, isIranianChannel, smsVerificationAvailable, editionDefaultTimeZone } = await import(
  '../../../shared/edition.js'
);

const CONFIG = {} as never;
const DUE = '2026-10-09T22:30:00Z'; // 02:00 on 10 Oct in Tehran, 9 Oct in UTC

beforeEach(() => {
  state.edition = 'iran';
  state.smsRow = null;
  state.workspace = { id: 'ws-1', owner_id: 'owner-1' };
  state.phoneVerified = false;
  state.rpcCalls = [];
  state.rpcArgs = [];
});

describe('shared/edition.ts — phase 3 switches', () => {
  it('Bale, SMS verification and the Tehran zone belong to the Iranian edition only', () => {
    expect(isIranianChannel('bale')).toBe(true);
    expect(isIranianChannel('telegram')).toBe(false);
    expect(isChannelAllowedInEdition('bale', 'iran')).toBe(true);
    expect(isChannelAllowedInEdition('bale', 'international')).toBe(false);
    expect(isChannelAllowedInEdition('telegram', 'international')).toBe(true);
    expect(smsVerificationAvailable('iran')).toBe(true);
    expect(smsVerificationAvailable('international')).toBe(false);
    expect(editionDefaultTimeZone('iran')).toBe('Asia/Tehran');
    expect(editionDefaultTimeZone('international')).toBe('UTC');
  });
});

describe('invitation e-mail — expiry date', () => {
  it('Iran (default): Jalali for Persian, as before', () => {
    const jalali = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    }).format(new Date(DUE));
    expect(formatExpiry('fa', DUE, 'UTC')).toBe(jalali);
    expect(formatExpiry('fa', DUE, 'UTC', 'jalali')).toBe(jalali);
    expect(renderInviteEmail('fa', { firstName: 'a', workspaceName: 'w', link: 'https://x', expiresAt: DUE, timeZone: 'UTC' }).text).toContain(jalali);
  });

  it('International: Gregorian for Persian; other languages unchanged', () => {
    const greg = formatExpiry('fa', DUE, 'UTC', 'gregorian')!;
    expect(greg).toContain('۲۰۲۶');
    expect(greg).not.toContain('۱۴۰۵');
    expect(formatExpiry('en', DUE, 'UTC', 'gregorian')).toBe(formatExpiry('en', DUE, 'UTC'));
    expect(
      renderInviteEmail('fa', { firstName: 'a', workspaceName: 'w', link: 'https://x', expiresAt: DUE, timeZone: 'UTC', calendar: 'gregorian' }).text,
    ).toContain(greg);
  });
});

describe('operator availability — default time zone', () => {
  it('Iran (and unknown): by UI locale, Persian → Tehran, as before', () => {
    expect(defaultTimezone('fa')).toBe('Asia/Tehran');
    expect(defaultTimezone('fa', 'iran', 'Europe/Berlin')).toBe('Asia/Tehran');
    expect(defaultTimezone('fa', null)).toBe('Asia/Tehran');
    expect(defaultTimezone('tr', 'iran')).toBe('Europe/Istanbul');
    expect(defaultTimezone('en', 'iran')).toBe('UTC');
  });

  it('International: the browser zone, else UTC — Persian never means Tehran', () => {
    expect(defaultTimezone('fa', 'international')).toBe('UTC');
    expect(defaultTimezone('fa', 'international', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(defaultTimezone('fa', 'international', 'Not/AZone')).toBe('UTC');
    expect(defaultTimezone('en', 'international', 'America/New_York')).toBe('America/New_York');
  });
});

describe('phone verification', () => {
  const input = { purpose: 'widget_access' as const, actorUserId: 'owner-1', workspaceId: 'ws-1' };

  it('Iran: required, the owner may verify, allowed countries IR — as before', async () => {
    const status = await phone.getStatusForActor(CONFIG, input);
    expect(status).toMatchObject({ required: true, satisfied: false, canVerify: true, allowedCountries: ['IR'] });
    expect(await phone.isPhoneVerificationSatisfied(CONFIG, input)).toBe(false);
    await expect(phone.assertPhoneVerificationSatisfied(CONFIG, input)).rejects.toMatchObject({
      code: 'phone_verification_required',
    });
  });

  it('unknown edition: behaves as Iran (required)', async () => {
    state.edition = null;
    expect(await phone.phoneVerificationEnabled(CONFIG)).toBe(true);
    expect((await phone.getStatusForActor(CONFIG, input)).required).toBe(true);
  });

  it('International: never required, never blocks, and no code is ever sent', async () => {
    state.edition = 'international';
    expect(await phone.phoneVerificationEnabled(CONFIG)).toBe(false);
    expect(await phone.getStatusForActor(CONFIG, input)).toEqual({
      workspaceId: 'ws-1', required: false, satisfied: true, canVerify: false,
    });
    expect(await phone.isPhoneVerificationSatisfied(CONFIG, input)).toBe(true);
    await expect(phone.assertPhoneVerificationSatisfied(CONFIG, input)).resolves.toBeUndefined();
    expect(state.rpcCalls).not.toContain('workspace_owner_phone_verified');
    const prevPepper = process.env.PHONE_VERIFICATION_PEPPER;
    process.env.PHONE_VERIFICATION_PEPPER = 'a-test-pepper-of-enough-length';
    try {
      await expect(
        phone.issueChallenge(CONFIG, {
          purpose: 'widget_access', subjectUserId: 'owner-1', phoneE164: '+447700900123', createdBy: 'user', actorUserId: 'owner-1',
        }),
      ).rejects.toMatchObject({ code: 'phone_verification_unavailable', status: 503 });
    } finally {
      if (prevPepper === undefined) delete process.env.PHONE_VERIFICATION_PEPPER;
      else process.env.PHONE_VERIFICATION_PEPPER = prevPepper;
    }
  });

  it('International: a non-member is still refused', async () => {
    state.edition = 'international';
    state.workspace = null;
    await expect(phone.getStatusForActor(CONFIG, input)).rejects.toMatchObject({ code: 'phone_verification_not_allowed' });
  });
});

describe('SMS providers', () => {
  const kavenegar = {
    provider_name: 'kavenegar', config: { apiKey: 'k', verifyTemplate: 'verify' }, is_active: true, updated_at: null,
  };

  it('Iran: a stored Kavenegar config is reported and may be saved — as before', async () => {
    state.smsRow = kavenegar;
    expect(await sms.getSmsProviderInfo(CONFIG)).toMatchObject({ providerName: 'kavenegar', configured: true, enabled: true });
    await expect(
      sms.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: 'k', verifyTemplate: 'verify' }, 'admin'),
    ).resolves.toMatchObject({ providerName: 'kavenegar' });
  });

  it('International: an Iranian vendor reads as not configured, cannot be saved and never sends', async () => {
    state.edition = 'international';
    state.smsRow = kavenegar;
    expect(await sms.getSmsProviderInfo(CONFIG)).toMatchObject({ providerName: 'disabled', configured: false, enabled: false });
    await expect(
      sms.saveSmsProviderConfig(CONFIG, { providerName: 'kavenegar', enabled: true, apiKey: 'k', verifyTemplate: 'verify' }, 'admin'),
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
    expect(await sms.sendSms(CONFIG, { to: '09121234567', body: 'x' })).toMatchObject({
      success: false, errorCode: 'sms_provider_not_configured',
    });
  });
});
