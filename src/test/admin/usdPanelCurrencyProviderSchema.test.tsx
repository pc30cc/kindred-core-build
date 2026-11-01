/**
 * Super Admin → Providers → Billing: Apirone (USDT on TRON), the gateway of
 * WebYar's dollar accounts (a panel not in Persian; owner, 2026-11-01). Its
 * form asks for the account id and the fee the customer pays on top; it is
 * listed in the Iranian edition, with the Iranian gateways, and never in the
 * International one (shared/edition.ts).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getVendorSchema, getVendorsForEdition } from '@/features/providers/schemas';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
}));

const { ProviderConfigForm } = await import('@/features/providers/ProviderConfigForm');

describe('the Apirone provider form', () => {
  it('asks for the account id (required) and the fee percent (optional, 1 by default)', () => {
    const vendor = getVendorSchema('billing', 'apirone')!;
    expect(vendor).toBeDefined();
    expect(vendor.label).toBe('Apirone (USDT · TRON)');
    expect(vendor.docsUrl).toBe('https://apirone.com/docs');
    expect(vendor.currency).toBe('USD');
    expect(vendor.description).toMatch(/[؀-ۿ]/);
    const fields = Object.fromEntries(vendor.fields.map((f) => [f.key, f]));
    expect(Object.keys(fields)).toEqual(['account', 'fee_percent']);
    expect(fields.account).toMatchObject({ type: 'text', required: true });
    expect(fields.account.hint).toContain('apr-');
    // The transfer key moves funds: never asked for.
    expect(vendor.fields.some((f) => /transfer/i.test(f.key))).toBe(false);
    expect(fields.fee_percent).toMatchObject({ type: 'number', required: false, defaultValue: '1' });
    expect(fields.fee_percent.hint).toBeTruthy();
  });

  it('is listed in the Iranian edition, in the Iranian group, and not in the International one', () => {
    expect(getVendorsForEdition('billing', 'iran').map((v) => v.name)).toContain('apirone');
    expect(getVendorSchema('billing', 'apirone')!.locales).toEqual(['fa']);
    expect(getVendorsForEdition('billing', 'international').map((v) => v.name)).not.toContain('apirone');
  });
});

describe('the form takes a fractional fee', () => {
  it('a number field accepts any decimal (step any), so 1.5 % is saved, not refused by the browser', () => {
    const vendor = getVendorSchema('billing', 'apirone')!;
    const onSubmit = vi.fn();
    render(<ProviderConfigForm vendor={vendor} onSubmit={onSubmit} />);
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="number"]');
    expect(inputs).toHaveLength(1);
    const fee = inputs[0];
    expect(fee.step).toBe('any');
    fireEvent.change(fee, { target: { value: '1.5' } });
    expect(fee.validity.stepMismatch).toBe(false);
    expect(fee.checkValidity()).toBe(true);
    const account = document.querySelector<HTMLInputElement>('input[placeholder="apr-…"]')!;
    fireEvent.change(account, { target: { value: 'apr-0123456789abcdef0123456789abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'adminProviders.form.save' }));
    expect(onSubmit).toHaveBeenCalledWith({ account: 'apr-0123456789abcdef0123456789abcdef', fee_percent: '1.5' });
  });
});
