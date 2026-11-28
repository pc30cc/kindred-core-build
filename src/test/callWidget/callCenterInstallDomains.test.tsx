/**
 * Call Center → Install → Allowed domains (owner, 2026-11-28): the
 * registered website is shown as one of the sites, fixed; Add is offered only
 * while the plan's max_call_widget_domains has a slot free (-1 = always,
 * unknown = never); a refusal past the number says so. The page is the embed
 * code and the domains only (owner, 2026-11-28): no bootstrap test (run from
 * the panel's address, which is none of the workspace's sites, it could only
 * ever answer origin_denied), no install health list and no line naming the
 * asset and API hosts under the embed code.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import fa from '@/i18n/locales/fa';

const state = vi.hoisted(() => ({
  max: 1 as number | null,
  registered: ['mywebsite.com'] as string[] | undefined,
  allowed: [] as string[],
  saveError: null as null | { code: string },
  patches: [] as Array<Record<string, unknown>>,
  toasts: [] as Array<{ title?: string }>,
}));

vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }) }));
vi.mock('@/hooks/useCallCenter', () => ({
  useCallCenterSettings: () => ({
    data: {
      settings: { enabled: true, public_key: 'cck_x', allowed_domains: state.allowed },
      platform: { call_center_enabled: true },
      ...(state.registered ? { registered_domains: state.registered } : {}),
    },
  }),
  useUpdateCallCenterSettings: () => ({
    isPending: false,
    mutateAsync: async (patch: Record<string, unknown>) => {
      state.patches.push(patch);
      if (state.saveError) throw Object.assign(new Error('refused'), state.saveError);
      return {};
    },
  }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => ({
    status: state.max === null ? 'loading' : 'ready',
    module: () => true, feature: () => true, channel: () => true,
    limit: (k: string) => (k === 'max_call_widget_domains' ? state.max : null),
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (t: { title?: string }) => { state.toasts.push(t); } }));

const { default: InstallPage } = await import('@/pages/app/call-center/InstallPage');
const { I18nProvider } = await import('@/i18n');

function mount() {
  return render(
    <I18nProvider initialLocale="fa" initialTranslations={fa}>
      <MemoryRouter><InstallPage /></MemoryRouter>
    </I18nProvider>,
  );
}
const addButton = () => document.querySelector('[data-add-domain]');
const I = fa.callCenter.install;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.max = 1; state.registered = ['mywebsite.com']; state.allowed = [];
  state.saveError = null; state.patches = []; state.toasts = [];
});

describe('the allowed domains of the call widget', () => {
  it('shows the registered website as one of the sites, and no Add on a plan of 1', () => {
    mount();
    const row = document.querySelector('[data-registered-domain]');
    expect(row?.textContent).toContain('mywebsite.com');
    expect(row?.textContent).toContain(I.registeredDomain);
    expect(addButton()).toBeNull();
    expect(document.querySelector('[data-domain-slots]')).not.toBeNull();
    expect(screen.queryByText(I.noDomainsYet)).toBeNull();
  });

  it('offers Add while a slot is free, and stops at the number', () => {
    state.max = 3;
    mount();
    fireEvent.click(addButton()!);
    fireEvent.change(screen.getAllByPlaceholderText('example.com')[0], { target: { value: 'shop.com' } });
    expect(addButton()).not.toBeNull();
    fireEvent.click(addButton()!);
    fireEvent.change(screen.getAllByPlaceholderText('example.com')[1], { target: { value: 'blog.com' } });
    expect(addButton()).toBeNull();
  });

  it('a row not filled in yet holds a slot: Add never opens more rows than the plan allows', () => {
    state.max = 2;
    mount();
    fireEvent.click(addButton()!);
    expect(addButton()).toBeNull();
  });

  it('a spelling of the registered website takes no slot', () => {
    state.max = 2;
    state.allowed = ['www.mywebsite.com'];
    mount();
    expect(addButton()).not.toBeNull();
  });

  it('a workspace without a registered website has every slot for its list', () => {
    state.registered = [];
    mount();
    expect(screen.getByText(I.noDomainsYet)).toBeTruthy();
    expect(addButton()).not.toBeNull();
  });

  it('always offers Add when unlimited (no counter), never while the plan is not known', () => {
    state.max = -1;
    state.allowed = ['a.com', 'b.com'];
    mount();
    expect(addButton()).not.toBeNull();
    expect(document.querySelector('[data-domain-slots]')).toBeNull();
    cleanup();
    state.max = null;
    mount();
    expect(addButton()).toBeNull();
  });

  it('a refusal past the number says what the plan allows', async () => {
    state.max = 2;
    state.saveError = { code: 'plan_limit' };
    state.allowed = ['shop.com'];
    mount();
    fireEvent.click(screen.getByRole('button', { name: fa.callCenter.common.save }));
    await waitFor(() => expect(state.toasts.length).toBe(1));
    expect(state.toasts[0].title).toBe(I.domainLimitReached.replace('{{max}}', '2'));
  });

  it('carries no bootstrap test: the page never calls the bootstrap', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mount();
    expect(screen.queryByText('تست بوت‌استرپ')).toBeNull();
    expect(screen.queryByRole('button', { name: 'اجرای تست' })).toBeNull();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/call-widget/bootstrap'))).toBe(false);
    expect('testBootstrap' in I).toBe(false);
  });

  it('carries no install health list and no hosts line under the embed code', () => {
    mount();
    expect(screen.queryByText('سلامت نصب')).toBeNull();
    expect(screen.queryByText('پلتفرم فعال است')).toBeNull();
    expect(screen.queryByText('کلید عمومی تولید شده')).toBeNull();
    expect('installHealth' in I).toBe(false);
    // Nor the line under the embed code naming the asset and API hosts.
    expect(screen.queryByText(/اسکریپت ویجت از/)).toBeNull();
    expect('embedCodeHint' in I).toBe(false);
    // What stays: the embed code and the domains.
    expect(screen.getByText(I.embedCode)).toBeTruthy();
    expect(screen.getByText(I.allowedDomains)).toBeTruthy();
  });
});
