/**
 * The owner's rule (2026-10-28) on the signup form: the website is required
 * and nothing new is said about it (no hint, note or tooltip beyond the
 * labels the form had), and a website the server refuses (taken, a platform
 * host, not a domain) reads as the existing sentence, never as the code
 * (server/services/ownerWebsite.ts, src/lib/settingsErrors.ts).
 */
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import SignupStepCompany from '@/components/auth/SignupStepCompany';

const auth = vi.hoisted(() => ({ signUp: vi.fn(), signIn: vi.fn() }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/toast', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@/hooks/usePublicBranding', () => ({ usePlatformBrandingForLocale: () => ({ platform_name: 'Platform' }) }));
vi.mock('@/hooks/useSignupEnabled', () => ({ useSignupEnabled: () => true }));
vi.mock('@/lib/emailOtp', () => ({ fetchSignupPolicy: async () => ({ method: 'otp', gate: 'before' }) }));
vi.mock('@/lib/googleAds', () => ({ trackSuccessfulSignup: () => undefined }));
vi.mock('@/components/AdsMeasurementConsent', () => ({ AdsMeasurementConsent: () => null }));
vi.mock('@/components/auth/AuthHeroPanel', () => ({ AuthHeroPanel: () => null }));
vi.mock('@/components/auth/AuthLegalLinks', () => ({ AuthLegalLinks: () => null }));
vi.mock('@/components/auth/LanguageSelector', () => ({ LanguageSelector: () => null }));
vi.mock('@/components/brand/BrandLoader', () => ({ BrandWordmark: () => null }));
vi.mock('@/components/brand/BrandLogo', () => ({ BrandLockup: () => null }));
// Step 1 fills its fields and moves on; step 2 is the real form.
vi.mock('@/components/auth/SignupStepAccount', () => ({
  default: function StepOne({ setEmail, setPassword, onSubmit }: {
    setEmail: (v: string) => void; setPassword: (v: string) => void; onSubmit: (e: React.FormEvent) => void;
  }) {
    useEffect(() => { setEmail('owner@example.test'); setPassword('correct horse 9'); }, [setEmail, setPassword]);
    return <form onSubmit={onSubmit}><button type="submit">step-1</button></form>;
  },
}));

const { default: SignupPage } = await import('@/pages/auth/SignupPage');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function withI18n(node: React.ReactNode, locale: 'en' | 'fa' = 'en') {
  return (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>{node}</I18nProvider>
    </MemoryRouter>
  );
}

describe('signup step 2 (SignupStepCompany)', () => {
  function step(website: string, locale: 'en' | 'fa' = 'en') {
    return render(withI18n(
      <SignupStepCompany
        companyName="Acme" setCompanyName={() => undefined}
        websiteDomain={website} setWebsiteDomain={() => undefined}
        loading={false} onSubmit={(e) => e.preventDefault()} brandName="Platform"
      />, locale,
    ));
  }

  it('the website field is required, and the form cannot be sent while it is blank', () => {
    step('   ');
    const input = screen.getByLabelText(en.auth.websiteDomainLabel) as HTMLInputElement;
    expect(input.required).toBe(true);
    expect((screen.getByRole('button', { name: en.auth.completeSignup }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    step('shop.example');
    expect((screen.getByRole('button', { name: en.auth.completeSignup }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['en', 'fa'] as const)('says nothing new about it (%s): only the labels the form already had', (locale) => {
    const A = (locale === 'fa' ? fa : en).auth;
    const view = step('', locale);
    expect(view.container.textContent).toBe(A.companyNameLabel + A.websiteDomainLabel + A.websiteDomainHint + A.completeSignup);
  });
});

describe('signup page: a refused website', () => {
  async function signUpWith(code: string) {
    auth.signUp.mockResolvedValue({ user: null, error: new Error(code) });
    render(withI18n(<SignupPage />));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'step-1' })); });
    fireEvent.change(screen.getByLabelText(en.auth.companyNameLabel), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(en.auth.websiteDomainLabel), { target: { value: ' shop.example ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.auth.completeSignup })); });
  }

  it.each([
    ['DOMAIN_TAKEN', en.settings.errors.domainTaken],
    ['PLATFORM_DOMAIN', en.settings.errors.domainTaken],
    ['MALFORMED', en.settings.errors.domainInvalid],
    ['EMPTY', en.settings.errors.domainInvalid],
  ])('%s reads as the existing sentence', async (code, sentence) => {
    await signUpWith(code);
    expect(auth.signUp).toHaveBeenCalledWith(expect.objectContaining({
      website: 'shop.example',
      metadata: expect.objectContaining({ websiteDomain: 'shop.example' }),
    }));
    expect(toastError).toHaveBeenCalledWith(en.auth.signupFailed, { description: sentence });
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('any other failure keeps its message', async () => {
    await signUpWith('Failed to create account');
    expect(toastError).toHaveBeenCalledWith(en.auth.signupFailed, { description: 'Failed to create account' });
  });
});
