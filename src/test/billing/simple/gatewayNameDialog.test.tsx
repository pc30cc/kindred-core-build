/**
 * Finance → Gateways: the Super Admin names each gateway as customers see
 * it (one field per panel language). The row shows the name; Save sends the
 * normalized names; an empty set is refused on the screen, before any call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminGateway } from '@/lib/adminBillingApi';

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, locale: 'en', dir: 'ltr' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/pages/admin/finance/GatewaysReadinessCard', () => ({ default: () => null }));

const api = vi.hoisted(() => ({
  rows: [] as AdminGateway[],
  saveGateway: vi.fn(),
}));
vi.mock('@/lib/adminBillingApi', () => ({
  adminBillingApi: {
    gateways: async () => ({ gateways: api.rows }),
    saveGateway: api.saveGateway,
  },
}));

const { GatewaysTab } = await import('@/pages/admin/finance/FinanceConfigTabs');

const zibal = (display_name: Record<string, string>): AdminGateway => ({
  id: 'g-zibal', provider_name: 'zibal', display_name, is_active: true, is_test: false,
  currencies: ['IRR'], countries: [], sort_order: 3, implemented: true,
});

beforeEach(() => {
  api.rows = [zibal({ fa: 'زیبال', en: 'Zibal', tr: 'Zibal' })];
  api.saveGateway.mockReset().mockResolvedValue({ gateway: api.rows[0] });
});

async function openDialog() {
  render(<GatewaysTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit display name' }));
  return screen.findByRole('dialog');
}

describe('GatewaysTab: the gateway\'s display name', () => {
  it('saves the names the customer will see, trimmed, empty ones dropped', async () => {
    await openDialog();
    expect((screen.getByLabelText('Persian') as HTMLInputElement).value).toBe('زیبال');
    expect(screen.getByLabelText('Persian').getAttribute('dir')).toBe('rtl');
    fireEvent.change(screen.getByLabelText('Persian'), { target: { value: '  پرداخت آنلاین ' } });
    fireEvent.change(screen.getByLabelText('English'), { target: { value: 'Online payment' } });
    fireEvent.change(screen.getByLabelText('Turkish'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveGateway).toHaveBeenCalledTimes(1));
    expect(api.saveGateway).toHaveBeenCalledWith({ provider_name: 'zibal', display_name: { fa: 'پرداخت آنلاین', en: 'Online payment' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses to save no name at all, without calling the server', async () => {
    await openDialog();
    for (const label of ['Persian', 'English', 'Turkish']) fireEvent.change(screen.getByLabelText(label), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('At least one name is required.');
    expect(api.saveGateway).not.toHaveBeenCalled();
  });

  it('shows the server\'s refusal in the dialog', async () => {
    api.saveGateway.mockRejectedValue(Object.assign(new Error('GATEWAY_NAME_TOO_LONG'), { code: 'GATEWAY_NAME_TOO_LONG' }));
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at most 60 characters/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a pasted name with spaces around it is not cut before it is trimmed', async () => {
    const name = 'N'.repeat(60);
    await openDialog();
    fireEvent.change(screen.getByLabelText('English'), { target: { value: `  ${name}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveGateway).toHaveBeenCalledTimes(1));
    expect(api.saveGateway.mock.calls[0][0].display_name.en).toBe(name);
  });

  it('a name over 60 characters is refused on Save, before any call', async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText('English'), { target: { value: 'N'.repeat(61) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at most 60 characters/);
    expect(api.saveGateway).not.toHaveBeenCalled();
  });

  it('the row shows the stored name (English, else Persian), never a blank', async () => {
    api.rows = [zibal({ fa: 'پرداخت آنلاین' })];
    render(<GatewaysTab />);
    expect(await screen.findByText('پرداخت آنلاین')).toBeTruthy();
  });
});
