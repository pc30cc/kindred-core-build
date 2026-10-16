/**
 * The code step of the phone verification screen: "Didn't get the code?".
 *
 *   - After the resend countdown, "Resend SMS" and "Call me instead" are
 *     offered where the platform can call; only "Resend code" where not.
 *   - An SMS the provider reports as undeliverable turns into a warning with
 *     a "Call me" button at once (counting down until a new code is allowed).
 *   - "Call me instead" asks the server for a call and the screen says so.
 *
 * The API layer is mocked; nothing provider-specific is rendered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = {
  status: vi.fn(),
  start: vi.fn(),
  resend: vi.fn(),
  delivery: vi.fn(),
  check: vi.fn(),
  cancel: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  getPhoneVerificationStatus: () => api.status(),
  startPhoneVerification: (input: unknown) => api.start(input),
  resendPhoneVerification: (_ctx: unknown, channel?: string) => api.resend(channel),
  getPhoneVerificationDelivery: () => api.delivery(),
  checkPhoneVerification: (input: unknown) => api.check(input),
  cancelPhoneVerification: (input: unknown) => api.cancel(input),
}));
vi.mock('@/i18n', () => {
  const t = (k: string) => k;
  return { useI18n: () => ({ locale: 'en', dir: 'ltr', t }), useTranslation: () => ({ locale: 'en', dir: 'ltr', t }) };
});
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (arg: unknown) => toast(arg), useToast: () => ({ toast }) }));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ isInternational: true }) }));

const { PhoneVerificationFlow } = await import('@/features/phone-verification/PhoneVerificationFlow');

const CTX = { purpose: 'widget_access' as const, workspaceId: '11111111-1111-1111-1111-111111111111' };
const CHALLENGE = '22222222-2222-2222-2222-222222222222';

function status(voiceCall: boolean) {
  return {
    required: true, satisfied: false, canVerify: true, phoneSet: true, phoneMasked: '+90530*****83',
    delivery: { voiceCall, defaultChannel: 'sms' },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderFlow(cooldown = 0) {
  return render(
    <PhoneVerificationFlow
      context={CTX}
      initialPhoneMasked="+90530*****83"
      initialChallengeId={CHALLENGE}
      initialChallengeExpiresInSeconds={300}
      initialResendAfterSeconds={cooldown}
    />,
    { wrapper },
  );
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  cleanup();
  toast.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.status.mockResolvedValue(status(true));
  api.delivery.mockResolvedValue({ state: 'pending' });
  api.resend.mockImplementation(async (channel?: string) => ({
    success: true, challengeId: '33333333-3333-3333-3333-333333333333', phoneMasked: '+90530*****83',
    expiresInSeconds: 300, resendAfterSeconds: 60, channel: channel ?? 'sms',
  }));
});

describe('"Didn\'t get the code?"', () => {
  it('counts down first, then offers SMS and a voice call', async () => {
    renderFlow(45);
    expect(screen.getByTestId('phone-new-code-in')).toHaveTextContent('phoneVerification.newCodeIn');
    expect(screen.queryByTestId('phone-call-me')).toBeNull();

    cleanup();
    renderFlow(0);
    await waitFor(() => expect(screen.getByTestId('phone-call-me')).toBeInTheDocument());
    expect(screen.getByTestId('phone-resend-sms')).toHaveTextContent('phoneVerification.resendSms');
  });

  it('"Call me instead" asks for a call and the screen switches to the call wording', async () => {
    renderFlow(0);
    await waitFor(() => expect(screen.getByTestId('phone-call-me')).toBeInTheDocument());
    await click(screen.getByTestId('phone-call-me'));
    await waitFor(() => expect(api.resend).toHaveBeenCalledWith('call'));
    await waitFor(() => expect(screen.getByTestId('phone-code-sent-to')).toHaveTextContent('phoneVerification.sentByCall'));
    expect(toast).toHaveBeenCalledWith({ title: 'phoneVerification.callStarted' });
    // The next round offers "Send SMS instead" / "Call me again" once the countdown ends.
    expect(screen.getByTestId('phone-new-code-in')).toBeInTheDocument();
  });

  it('only "Resend code" where the platform cannot call', async () => {
    api.status.mockResolvedValue(status(false));
    renderFlow(0);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(screen.queryByTestId('phone-call-me')).toBeNull();
    expect(screen.getByText('phoneVerification.resend')).toBeInTheDocument();
  });
});

describe('an SMS the provider could not deliver', () => {
  it('shows the warning with "Call me" at once, counting down to the next allowed code', async () => {
    api.delivery.mockResolvedValue({ state: 'failed' });
    api.start.mockResolvedValue({
      success: true, challengeId: CHALLENGE, phoneMasked: '+90530*****83',
      expiresInSeconds: 300, resendAfterSeconds: 60, channel: 'sms',
    });
    render(<PhoneVerificationFlow context={CTX} />, { wrapper });
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('+447700900123'), { target: { value: '+905301234583' } });
    await click(screen.getByText('phoneVerification.sendCode'));

    await waitFor(() => expect(screen.getByTestId('phone-sms-failed')).toBeInTheDocument());
    expect(screen.getByTestId('phone-sms-failed')).toHaveTextContent('phoneVerification.smsFailedBody');
    const callMe = screen.getByTestId('phone-call-me-failed');
    expect(callMe).toHaveTextContent('phoneVerification.callMeIn');
    expect(callMe).toBeDisabled();
  });

  it('says "delivered" when the provider confirms it', async () => {
    api.delivery.mockResolvedValue({ state: 'delivered' });
    api.start.mockResolvedValue({
      success: true, challengeId: CHALLENGE, phoneMasked: '+90530*****83',
      expiresInSeconds: 300, resendAfterSeconds: 60, channel: 'sms',
    });
    render(<PhoneVerificationFlow context={CTX} />, { wrapper });
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('+447700900123'), { target: { value: '+905301234583' } });
    await click(screen.getByText('phoneVerification.sendCode'));
    await waitFor(() => expect(screen.getByTestId('phone-sms-delivered')).toBeInTheDocument());
    expect(screen.queryByTestId('phone-sms-failed')).toBeNull();
  });
});
