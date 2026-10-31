/**
 * The top bar's language switch is the operator's language choice, so it is
 * saved on the account (`preferred_locale`), as Settings → Interface saves
 * it. What the server writes for the operator (push, mail, the operator API
 * bodies the native apps print; server/services/operatorLocale.ts) then
 * follows the language they read. It used to be kept in this browser only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  setLocale: vi.fn(),
  updateAccount: vi.fn(async () => ({})),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'en', setLocale: h.setLocale }),
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePanelLanguages: () => ({ locales: ['en', 'fa', 'tr'], defaultLocale: 'en', switcher: true, ready: true }),
}));
vi.mock('@/lib/account-api', () => ({ updateAccount: h.updateAccount }));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLocation: () => ({ pathname: '/acme/overview' }),
}));
vi.mock('@/hooks/useWorkspace', () => ({ useWorkspacePath: () => (p: string) => `/acme${p}` }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/layout/UserMenu', () => ({ UserMenu: () => null }));
vi.mock('@/components/layout/AlertsMenu', () => ({ AlertsMenu: () => null }));
// A native <select> in place of Radix's, which jsdom cannot open.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="top-bar-language" value={value} onChange={(e) => onValueChange(e.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

import { AppTopBar } from '@/components/layout/AppTopBar';

beforeEach(() => {
  h.setLocale.mockReset();
  h.updateAccount.mockReset();
  h.updateAccount.mockImplementation(async () => ({}));
});

describe('the top bar language switch', () => {
  it('switches the dashboard and saves the choice on the account', () => {
    const { getByTestId } = render(<AppTopBar />);
    fireEvent.change(getByTestId('top-bar-language'), { target: { value: 'fa' } });
    expect(h.setLocale).toHaveBeenCalledWith('fa');
    expect(h.updateAccount).toHaveBeenCalledWith({ preferred_locale: 'fa' });
  });

  it('a failed save keeps the switch (the language is still changed here)', async () => {
    h.updateAccount.mockImplementation(async () => { throw new Error('offline'); });
    const { getByTestId } = render(<AppTopBar />);
    fireEvent.change(getByTestId('top-bar-language'), { target: { value: 'tr' } });
    expect(h.setLocale).toHaveBeenCalledWith('tr');
    await Promise.resolve();
    expect(h.updateAccount).toHaveBeenCalledTimes(1);
  });
});
