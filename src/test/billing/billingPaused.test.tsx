/**
 * Billing v2 is hidden (shared/billingMode.ts): the workspace page is the
 * simple billing's account page instead of the v2 tabs, and the server does
 * not start the v2 scheduler.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' }, isLoading: false }),
}));
vi.mock('@/pages/app/billing/WorkspaceBillingPage', () => ({
  default: () => <div>v2 billing tabs</div>,
}));
vi.mock('@/pages/app/billing/account/AccountBillingPage', () => ({
  default: ({ workspaceId, slug }: { workspaceId: string; slug: string }) => <div>account billing {workspaceId} {slug}</div>,
}));

const { LEGACY_BILLING_ENABLED } = await import('../../../shared/billingMode');
const BillingPage = (await import('@/pages/app/BillingPage')).default;

describe('billing v2 is hidden', () => {
  it('the flag is off', () => {
    expect(LEGACY_BILLING_ENABLED).toBe(false);
  });

  it('the workspace billing page is the account page, not the v2 tabs', () => {
    render(<BillingPage />);
    expect(screen.getByText('account billing ws-1 acme')).toBeInTheDocument();
    expect(screen.queryByText('v2 billing tabs')).not.toBeInTheDocument();
  });

  it('the server starts the v2 scheduler only behind the flag', () => {
    const src = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(src).toMatch(/if \(LEGACY_BILLING_ENABLED\) startBillingV2Schedulers\(config\);/);
    expect(src.match(/startBillingV2Schedulers\(config\)/g)).toHaveLength(1);
  });

  it('Super Admin finance keeps only gateways, AI cost and audit', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'admin', 'FinancePage.tsx'), 'utf8');
    expect(src).toContain("['gateways', 'ai', 'audit']");
  });
});
