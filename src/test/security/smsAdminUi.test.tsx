/**
 * Admin SMS provider card — UI contract.
 * The API layer is mocked; no credential value is ever rendered or asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';

const api = {
  get: vi.fn(),
  save: vi.fn(),
  del: vi.fn(),
  test: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  adminGetSmsProvider: () => api.get(),
  adminSaveSmsProvider: (input: unknown) => api.save(input),
  adminDeleteSmsProvider: () => api.del(),
  adminTestSmsProvider: () => api.test(),
}));

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const { AdminSmsProviderCard } = await import('@/features/providers/AdminSmsProviderCard');

/** Click helper that flushes the resulting async state updates. */
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

function setValue(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

const CONFIGURED = {
  providerName: 'kavenegar', configured: true, enabled: true, hasApiKey: true,
  sender: '10008663', verifyTemplate: 'verifyLogin', updatedAt: '2026-01-01T00:00:00.000Z',
};
const EMPTY = {
  providerName: 'disabled', configured: false, enabled: false, hasApiKey: false,
  sender: null, verifyTemplate: null, updatedAt: null,
};

beforeEach(() => {
  cleanup();
  toast.mockReset();
  api.get.mockReset().mockResolvedValue(CONFIGURED);
  api.save.mockReset().mockResolvedValue(CONFIGURED);
  api.del.mockReset().mockResolvedValue(EMPTY);
  api.test.mockReset().mockResolvedValue({
    success: true, provider: 'kavenegar', latencyMs: 20, balance: 5000, currency: 'IRR', accountType: 'master',
  });
});

describe('AdminSmsProviderCard', () => {
  it('shows a saved-credential indicator and never renders a key value', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByTestId('sms-credential-saved')).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/apiKey|api_key/i);
  });

  it('lists unimplemented vendors as coming soon', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByTestId('sms-vendor-soon-twilio')).toBeInTheDocument());
    expect(screen.queryByTestId('sms-vendor-soon-kavenegar')).toBeNull();
  });

  it('keeps the stored credential when the key field is left blank', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    await click(screen.getByText('Save'));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  it('blocks a save with an invalid verification template', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    setValue(screen.getByLabelText('OTP / Verification Template'), 'verify login');
    await click(screen.getByText('Save'));
    expect(api.save).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });

  it('requires a key on first configuration', async () => {
    api.get.mockResolvedValue(EMPTY);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    setValue(screen.getByLabelText('OTP / Verification Template'), 'verifyLogin');
    await click(screen.getByText('Save'));
    expect(api.save).not.toHaveBeenCalled();
  });

  it('renders a successful connection test with balance only', async () => {
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Test Connection')).toBeInTheDocument());
    await click(screen.getByText('Test Connection'));
    await waitFor(() => expect(screen.getByTestId('sms-test-result')).toBeInTheDocument());
    expect(screen.getByTestId('sms-test-result').textContent).toContain('5000');
  });

  it('renders a normalized failure message', async () => {
    api.test.mockResolvedValue({ success: false, provider: 'kavenegar', error: 'SMS authentication failed' });
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Test Connection')).toBeInTheDocument());
    await click(screen.getByText('Test Connection'));
    await waitFor(() =>
      expect(screen.getByTestId('sms-test-result').textContent).toContain('SMS authentication failed'),
    );
  });

  it('disables the test button until a provider is configured', async () => {
    api.get.mockResolvedValue(EMPTY);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Test Connection')).toBeDisabled());
  });
});

const SMSIR_CONFIGURED = {
  providerName: 'smsir', configured: true, enabled: true, hasApiKey: true,
  sender: null, verifyTemplate: null, lineNumber: '30007732',
  verifyTemplateId: 100000, verifyParameterName: 'CODE',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AdminSmsProviderCard — SMS.ir', () => {
  it('renders the SMS.ir summary fields', async () => {
    api.get.mockResolvedValue(SMSIR_CONFIGURED);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByTestId('sms-line-number')).toHaveTextContent('30007732'));
    expect(screen.getByText('100000')).toBeInTheDocument();
  });

  it('requires a new API key when switching vendors', async () => {
    api.get.mockResolvedValue({ ...SMSIR_CONFIGURED, providerName: 'kavenegar', lineNumber: null, verifyTemplateId: null, verifyParameterName: null, verifyTemplate: 'verifyLogin' });
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    await click(screen.getByTestId('sms-vendor-select-smsir'));
    expect(screen.getByTestId('sms-switch-key-warning')).toBeInTheDocument();
    setValue(screen.getByLabelText('Line Number'), '30007732');
    setValue(screen.getByLabelText('Verification Template ID'), '100000');
    await click(screen.getByText('Save'));
    expect(api.save).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('saves an SMS.ir configuration with a fresh key', async () => {
    api.get.mockResolvedValue(EMPTY);
    api.save.mockResolvedValue(SMSIR_CONFIGURED);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    await click(screen.getByTestId('sms-vendor-select-smsir'));
    setValue(screen.getByLabelText('API Key'), 'fresh-placeholder');
    setValue(screen.getByLabelText('Line Number'), '30007732');
    setValue(screen.getByLabelText('Verification Template ID'), '100000');
    setValue(screen.getByLabelText('Code Parameter Name'), 'CODE');
    await click(screen.getByText('Save'));
    expect(api.save).toHaveBeenCalledWith({
      providerName: 'smsir', enabled: false, apiKey: 'fresh-placeholder',
      lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE',
    });
  });

  it('rejects a non-numeric line number before calling the API', async () => {
    api.get.mockResolvedValue(EMPTY);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    await click(screen.getByText('Configure'));
    await click(screen.getByTestId('sms-vendor-select-smsir'));
    setValue(screen.getByLabelText('API Key'), 'fresh-placeholder');
    setValue(screen.getByLabelText('Line Number'), 'kaveh');
    await click(screen.getByText('Save'));
    expect(api.save).not.toHaveBeenCalled();
  });

  it('no longer lists SMS.ir as coming soon', async () => {
    api.get.mockResolvedValue(EMPTY);
    render(<AdminSmsProviderCard />);
    await waitFor(() => expect(screen.getByText('Configure')).toBeInTheDocument());
    expect(screen.queryByTestId('sms-vendor-soon-smsir')).toBeNull();
  });
});
