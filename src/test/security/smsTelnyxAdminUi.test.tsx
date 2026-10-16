/**
 * Super Admin → Providers → SMS in the International edition: the Telnyx card.
 * The API layer is mocked; no credential value is ever rendered or asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';

const api = { get: vi.fn(), save: vi.fn(), del: vi.fn(), test: vi.fn() };
const state = vi.hoisted(() => ({ regionMode: 'multi' }));

vi.mock('@/lib/api', () => ({
  adminGetSmsProvider: () => api.get(),
  adminSaveSmsProvider: (input: unknown) => api.save(input),
  adminDeleteSmsProvider: () => api.del(),
  adminTestSmsProvider: () => api.test(),
}));
vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({
    data: { branding: null, localized: [], region: { region_mode: state.regionMode }, realtime: null },
  }),
}));
vi.mock('@/i18n', () => {
  const t = (k: string, vars?: Record<string, unknown>) =>
    vars ? `${k}:${Object.values(vars).join(',')}` : k;
  return { useI18n: () => ({ locale: 'en', dir: 'ltr', t }), useTranslation: () => ({ locale: 'en', dir: 'ltr', t }) };
});
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const { AdminSmsProviderCard } = await import('@/features/providers/AdminSmsProviderCard');
const { __resetEditionForTests } = await import('@/lib/edition');

const PROFILE = '490001a1-442d-809f-5753-c2332bd10640';
const TELNYX = {
  providerName: 'telnyx', configured: true, enabled: true, hasApiKey: true,
  sender: null, verifyTemplate: null, lineNumber: null, verifyTemplateId: null, verifyParameterName: null,
  verifyProfileId: PROFILE, channel: 'sms', updatedAt: '2026-10-16T00:00:00.000Z',
};
const EMPTY = {
  providerName: 'disabled', configured: false, enabled: false, hasApiKey: false,
  sender: null, verifyTemplate: null, lineNumber: null, verifyTemplateId: null, verifyParameterName: null,
  verifyProfileId: null, channel: null, updatedAt: null,
};

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  cleanup();
  __resetEditionForTests();
  state.regionMode = 'multi';
  toast.mockReset();
  api.get.mockReset().mockResolvedValue(TELNYX);
  api.save.mockReset().mockResolvedValue(TELNYX);
  api.del.mockReset().mockResolvedValue(EMPTY);
  api.test.mockReset().mockResolvedValue({ success: true, provider: 'telnyx', latencyMs: 40, balance: null, currency: 'USD', profileName: 'RESPOK' });
});

describe('AdminSmsProviderCard — International (Telnyx)', () => {
  it('shows the Telnyx summary and says the message text is the Verify Profile template', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByTestId('sms-telnyx-profile-id')).toHaveTextContent(PROFILE));
    expect(screen.getByText('adminProviders.smsTelnyx.vendorLabel')).toBeInTheDocument();
    expect(screen.getByText('adminProviders.smsTelnyx.messageTextValue')).toBeInTheDocument();
    expect(screen.getByTestId('sms-credential-saved')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Kavenegar|SMS\.ir|کاوه/);
  });

  it('offers Telnyx only, with a write-only password key field, and no template field', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    expect(screen.getByTestId('sms-vendor-select-telnyx')).toBeInTheDocument();
    expect(screen.queryByTestId('sms-vendor-select-kavenegar')).toBeNull();
    expect(screen.queryByTestId('sms-vendor-select-smsir')).toBeNull();
    const key = document.getElementById('sms-api-key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect((document.getElementById('sms-telnyx-profile') as HTMLInputElement).value).toBe(PROFILE);
    expect(document.getElementById('sms-template')).toBeNull();
    expect(screen.getByTestId('sms-telnyx-template-note')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Kavenegar|SMS\.ir/);
  });

  it('saves Telnyx (channel call), keeping the stored key when the field is blank', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    await click(screen.getByTestId('sms-telnyx-channel-call'));
    await click(screen.getByText('Save'));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).toEqual({ providerName: 'telnyx', enabled: true, verifyProfileId: PROFILE, channel: 'call', voiceFallback: true });
  });

  it('first configuration: needs a key and a UUID profile id', async () => {
    api.get.mockResolvedValue(EMPTY);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    fireEvent.change(document.getElementById('sms-telnyx-profile')!, { target: { value: 'RESPOK' } });
    await click(screen.getByText('Save'));
    expect(api.save).not.toHaveBeenCalled();
    expect(toast.mock.calls[0][0]).toMatchObject({ title: 'adminProviders.smsTelnyx.profileIdInvalid' });

    fireEvent.change(document.getElementById('sms-telnyx-profile')!, { target: { value: PROFILE } });
    await click(screen.getByText('Save'));
    expect(api.save).not.toHaveBeenCalled(); // no key yet

    fireEvent.change(document.getElementById('sms-api-key')!, { target: { value: 'KEY_placeholder' } });
    await click(screen.getByText('Save'));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).toEqual({
      providerName: 'telnyx', enabled: false, apiKey: 'KEY_placeholder', verifyProfileId: PROFILE, channel: 'sms', voiceFallback: true,
    });
  });

  it('the connection test shows the Verify Profile name, not a balance', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Test Connection')).not.toBeDisabled());
    await click(screen.getByText('Test Connection'));
    await waitFor(() => expect(screen.getByTestId('sms-test-profile')).toHaveTextContent('adminProviders.smsTelnyx.testProfile:RESPOK'));
    expect(screen.getByTestId('sms-test-result').textContent).not.toMatch(/Balance/);
  });
});

describe('AdminSmsProviderCard — Iranian edition never offers Telnyx', () => {
  it('Kavenegar and SMS.ir only', async () => {
    state.regionMode = 'iran';
    api.get.mockResolvedValue(EMPTY);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    expect(screen.getByTestId('sms-vendor-select-kavenegar')).toBeInTheDocument();
    expect(screen.getByTestId('sms-vendor-select-smsir')).toBeInTheDocument();
    expect(screen.queryByTestId('sms-vendor-select-telnyx')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Telnyx|smsTelnyx/);
  });
});
