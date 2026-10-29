// @vitest-environment node
/**
 * isEmailProviderConfigured (server/services/email/index.ts): whether a
 * feature that mails a visitor on request (the transcript by email) is
 * offered. It reads the platform's `default_email_provider` exactly as
 * sendEmail does, so it answers false for every value sendEmail would not
 * send with: none, `disabled`, `stub` (sendEmail's "not configured"), a
 * provider with no adapter on this server or without its required fields
 * and sender, and when the setting cannot be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ value: null as unknown, fails: false }));

vi.mock('../../../server/lib/serviceClient.js', () => ({
  serviceClientFor: () => ({
    from: () => {
      if (state.fails) throw new Error('database unavailable');
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: state.value === null ? null : { value: state.value }, error: null }),
      };
      return chain;
    },
  }),
}));

const { isEmailProviderConfigured } = await import('../../../server/services/email/index.js');
const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;

beforeEach(() => {
  state.value = null;
  state.fails = false;
});

describe('isEmailProviderConfigured', () => {
  it('true for a provider that can send', async () => {
    state.value = { provider_name: 'resend', config: { from_email: 'no-reply@example.test', api_key: 're_1' } };
    expect(await isEmailProviderConfigured(config)).toBe(true);
    state.value = { provider: 'SMTP', config: { smtp_host: 'mail-relay', from_email: 'no-reply@example.test' } };
    expect(await isEmailProviderConfigured(config)).toBe(true);
  });

  it('false for a provider sendEmail could not send with (no adapter, no key, no sender)', async () => {
    delete process.env.RESEND_API_KEY;
    for (const value of [
      { provider_name: 'resend', config: { from_email: 'no-reply@example.test' } },
      { provider_name: 'smtp', config: { smtp_host: 'mail-relay' } },
      { provider_name: 'smtp', config: { smtp_host: 'mail-relay', from_email: 'no-reply@example.test', smtp_user: 'u' } },
      { provider_name: 'mailgun', config: { api_key: 'k', from_email: 'no-reply@example.test' } },
    ]) {
      state.value = value;
      expect(await isEmailProviderConfigured(config), JSON.stringify(value)).toBe(false);
    }
  });

  it('false for none, disabled and the stub sendEmail refuses to send with', async () => {
    expect(await isEmailProviderConfigured(config)).toBe(false);
    for (const value of [{}, { provider_name: '' }, { provider_name: 'disabled' }, { provider_name: 'stub' }, { provider: ' Stub ' }]) {
      state.value = value;
      expect(await isEmailProviderConfigured(config), JSON.stringify(value)).toBe(false);
    }
  });

  it('false when the setting cannot be read', async () => {
    state.fails = true;
    expect(await isEmailProviderConfigured(config)).toBe(false);
  });
});
