/**
 * Billing v2 is hidden while the simple billing replaces it
 * (shared/billingMode.ts): the workspace page shows the notice instead of the
 * v2 tabs, and the server does not start the v2 scheduler.
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

const { LEGACY_BILLING_ENABLED } = await import('../../../shared/billingMode');
const BillingPage = (await import('@/pages/app/BillingPage')).default;

describe('billing v2 is hidden', () => {
  it('the flag is off', () => {
    expect(LEGACY_BILLING_ENABLED).toBe(false);
  });

  it('the workspace billing page shows the notice, not the v2 tabs', () => {
    render(<BillingPage />);
    expect(screen.getByText('billing.paused.title')).toBeInTheDocument();
    expect(screen.getByText('billing.paused.body')).toBeInTheDocument();
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
