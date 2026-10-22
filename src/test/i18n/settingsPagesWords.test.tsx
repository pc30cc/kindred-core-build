/**
 * W-15: Settings → Domains speaks the panel's language, its delete button
 * has a name, and a refused request says why in a sentence (never
 * "DOMAIN_TAKEN", "file_too_large" or "HTTP 403"); Settings → General's
 * toasts likewise (src/lib/settingsErrors.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import { SettingsRequestError, settingsErrorMessage } from '@/lib/settingsErrors';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastSpy }));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'ws-1', name: 'Acme', slug: 'acme' }) }));
vi.mock('@/hooks/useWorkspaceDomains', () => ({
  useWorkspaceDomains: () => ({
    data: [
      { id: 'd1', domain: 'shop.com', verified: true, is_primary: true },
      { id: 'd2', domain: 'pending.com', verified: false, is_primary: false },
    ],
    isLoading: false,
  }),
}));

const { default: DomainsPage } = await import('@/pages/app/settings/DomainsPage');

afterEach(() => { cleanup(); toastSpy.mockReset(); vi.unstubAllGlobals(); });

function mount(locale: 'en' | 'fa') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
        <DomainsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Settings → Domains', () => {
  it('in Persian: no English word on the page; each state and action named', () => {
    const view = mount('fa');
    const text = view.container.textContent || '';
    for (const english of ['Add Domain', 'Configured Domains', 'Set Primary', 'Unverified', 'Primary', 'No domains configured']) {
      expect(text, english).not.toContain(english);
    }
    const P = fa.settings.domainsPage;
    expect(text).toContain(P.addTitle);
    expect(text).toContain(P.verified);
    expect(text).toContain(P.unverified);
    expect(text).toContain(P.unverifiedHint);
    expect(screen.getByRole('button', { name: P.remove.replace('{{domain}}', 'pending.com') })).toBeTruthy();
  });

  it('a refused add says why, in a sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'This domain is already registered.', code: 'DOMAIN_TAKEN' }) })));
    mount('en');
    fireEvent.change(screen.getByRole('textbox', { name: en.settings.domainsPage.domainLabel }), { target: { value: 'shop.com' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(en.settings.domainsPage.add) })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: en.settings.domainsPage.failed,
      description: en.settings.errors.domainTaken,
      variant: 'destructive',
    }));
  });
});

describe('settingsErrorMessage', () => {
  const t = (key: string) => {
    const value = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);
    return typeof value === 'string' ? value : key;
  };
  const E = en.settings.errors;

  it('the codes the settings pages get back, as sentences', () => {
    expect(settingsErrorMessage(new Error('file_too_large'), t as never)).toBe(E.fileTooLarge);
    expect(settingsErrorMessage(new Error('Icon must be smaller than 5 MB'), t as never)).toBe(E.fileTooLarge);
    expect(settingsErrorMessage(new Error('unsupported_image_type'), t as never)).toBe(E.fileType);
    expect(settingsErrorMessage(new Error('plan_upgrade_required'), t as never)).toBe(E.plan);
    expect(settingsErrorMessage(new SettingsRequestError('MALFORMED', 400), t as never)).toBe(E.domainInvalid);
    expect(settingsErrorMessage(new SettingsRequestError('phone_verification_required', 403), t as never)).toBe(E.phoneVerification);
    expect(settingsErrorMessage(new SettingsRequestError('', 403), t as never)).toBe(E.forbidden);
    expect(settingsErrorMessage(new SettingsRequestError('', 401), t as never)).toBe(E.session);
    expect(settingsErrorMessage(new TypeError('Failed to fetch'), t as never)).toBe(E.network);
  });

  it('anything else is the general sentence, never the raw text', () => {
    for (const raw of ['Request failed: 500', 'HTTP 403', 'duplicate key value violates unique constraint', undefined]) {
      expect(settingsErrorMessage(raw === undefined ? raw : new Error(raw), t as never), String(raw)).toBe(E.generic);
    }
  });
});
