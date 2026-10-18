// @vitest-environment node
/**
 * isEmailProviderConfigured (server/services/email/index.ts): whether a
 * feature that mails a visitor on request (the transcript by email) is
 * offered. It reads the platform's `default_email_provider` exactly as
 * sendEmail does, so it answers false for every value sendEmail would not
 * send with: none, `disabled`, and `stub` (sendEmail's "Email provider is not
 * configured"), and when the setting cannot be read.
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
  it('true for a real provider', async () => {
    state.value = { provider_name: 'resend', config: { from_email: 'no-reply@example.test' } };
    expect(await isEmailProviderConfigured(config)).toBe(true);
    state.value = { provider: 'SMTP' };
    expect(await isEmailProviderConfigured(config)).toBe(true);
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
