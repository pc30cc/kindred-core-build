// ============================================================
// UNIFIED BILLING — PLATFORM CONFIGURATION
//
// One place for the app-wide commercial configuration: currencies, exchange
// rates, payment gateways, tax rates, coupons and metered usage items.
// Everything is server-authoritative and edited from the super-admin finance
// panel. Nothing here is region-specific and nothing is per-workspace.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getAllProviders } from '../index.js';

export class BillingConfigError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message?: string,
  ) {
    super(message || code);
    this.name = 'BillingConfigError';
  }
}

function db(config: ServerConfig) {
  return getServiceClient(config);
}

function ok<T>(res: { data: T | null; error: { message: string } | null }, code: string): T {
  if (res.error) throw new BillingConfigError(code, 500, res.error.message);
  return res.data as T;
}

// ─── Currencies ────────────────────────────────────────────────────────────

export interface Currency {
  code: string;
  display_name: Record<string, string>;
  symbol: string;
  minor_units: number;
  is_base: boolean;
  is_active: boolean;
  sort_order: number;
}

export async function listCurrencies(config: ServerConfig, activeOnly = false): Promise<Currency[]> {
  let q = db(config).from('billing_currencies').select('*').order('sort_order');
  if (activeOnly) q = q.eq('is_active', true);
  return ok(await q, 'currencies_read_failed') as Currency[];
}

export async function getBaseCurrency(config: ServerConfig): Promise<Currency> {
  const rows = await listCurrencies(config, true);
  return rows.find((c) => c.is_base) || rows[0] || ({ code: 'IRR', minor_units: 0, symbol: '' } as Currency);
}

export async function upsertCurrency(
  config: ServerConfig,
  input: Partial<Currency> & { code: string },
): Promise<Currency> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new BillingConfigError('invalid_currency_code');
  const client = db(config);
  if (input.is_base) {
    // exactly one base currency, enforced in the database too
    await client.from('billing_currencies').update({ is_base: false }).neq('code', code);
  }
  const payload: Record<string, unknown> = { code };
  for (const k of ['display_name', 'symbol', 'minor_units', 'is_base', 'is_active', 'sort_order'] as const) {
    if (input[k] !== undefined) payload[k] = input[k];
  }
  const res = await client.from('billing_currencies').upsert(payload, { onConflict: 'code' }).select().single();
  return ok(res, 'currency_write_failed') as Currency;
}

export async function deleteCurrency(config: ServerConfig, code: string): Promise<void> {
  const currency = (await listCurrencies(config)).find((c) => c.code === code);
  if (!currency) throw new BillingConfigError('currency_not_found', 404);
  if (currency.is_base) throw new BillingConfigError('cannot_delete_base_currency', 409);
  const res = await db(config).from('billing_currencies').delete().eq('code', code);
  if (res.error) throw new BillingConfigError('currency_delete_failed', 500, res.error.message);
}

// ─── Exchange rates ────────────────────────────────────────────────────────

export async function listExchangeRates(config: ServerConfig, limit = 100) {
  return ok(
    await db(config)
      .from('billing_exchange_rates')
      .select('*')
      .order('effective_at', { ascending: false })
      .limit(limit),
    'rates_read_failed',
  );
}

export async function publishExchangeRate(
  config: ServerConfig,
  input: { base_code: string; quote_code: string; rate: number },
) {
  if (!(input.rate > 0)) throw new BillingConfigError('invalid_rate');
  if (input.base_code === input.quote_code) throw new BillingConfigError('invalid_pair');
  return ok(
    await db(config)
      .from('billing_exchange_rates')
      .insert({ base_code: input.base_code, quote_code: input.quote_code, rate: input.rate })
      .select()
      .single(),
    'rate_write_failed',
  );
}

/** Latest published rate, or null when the pair was never published. */
export async function getRate(
  config: ServerConfig,
  base: string,
  quote: string,
): Promise<number | null> {
  if (base === quote) return 1;
  const { data } = await db(config)
    .from('billing_exchange_rates')
    .select('rate')
    .eq('base_code', base)
    .eq('quote_code', quote)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const rate = (data as { rate?: number } | null)?.rate;
  return typeof rate === 'number' ? rate : rate ? Number(rate) : null;
}

// ─── Gateways ──────────────────────────────────────────────────────────────

export interface Gateway {
  id: string;
  provider_name: string;
  display_name: Record<string, string>;
  is_active: boolean;
  is_test: boolean;
  currencies: string[];
  countries: string[];
  sort_order: number;
  config: Record<string, unknown>;
}

/** Registered gateways joined with the capabilities of the shipped handler. */
export async function listGateways(config: ServerConfig): Promise<
  (Gateway & { implemented: boolean; capabilities?: unknown })[]
> {
  const rows = (ok(
    await db(config).from('billing_gateways').select('*').order('sort_order'),
    'gateways_read_failed',
  ) || []) as Gateway[];
  const handlers = getAllProviders();
  return rows.map((g) => ({
    ...g,
    implemented: g.provider_name === 'manual' || Boolean(handlers[g.provider_name]),
    capabilities: handlers[g.provider_name]?.capabilities,
  }));
}

/** Gateways a customer may actually pay this currency with. */
export async function listPayableGateways(
  config: ServerConfig,
  currency: string,
): Promise<Gateway[]> {
  const rows = await listGateways(config);
  return rows.filter(
    (g) => g.is_active && g.implemented && (g.currencies.length === 0 || g.currencies.includes(currency)),
  );
}

export async function upsertGateway(
  config: ServerConfig,
  input: Partial<Gateway> & { provider_name: string },
): Promise<Gateway> {
  const payload: Record<string, unknown> = { provider_name: input.provider_name };
  for (const k of ['display_name', 'is_active', 'is_test', 'currencies', 'countries', 'sort_order', 'config'] as const) {
    if (input[k] !== undefined) payload[k] = input[k];
  }
  return ok(
    await db(config).from('billing_gateways').upsert(payload, { onConflict: 'provider_name' }).select().single(),
    'gateway_write_failed',
  ) as Gateway;
}

// ─── Tax rates ─────────────────────────────────────────────────────────────

export interface TaxRate {
  id: string;
  name: string;
  rate_percent: number;
  country_code: string | null;
  currency: string | null;
  is_inclusive: boolean;
  is_active: boolean;
}

export async function listTaxRates(config: ServerConfig): Promise<TaxRate[]> {
  return (ok(
    await db(config).from('billing_tax_rates').select('*').order('created_at'),
    'tax_read_failed',
  ) || []) as TaxRate[];
}

export async function upsertTaxRate(config: ServerConfig, input: Partial<TaxRate>): Promise<TaxRate> {
  if (input.rate_percent !== undefined && (input.rate_percent < 0 || input.rate_percent > 100)) {
    throw new BillingConfigError('invalid_tax_rate');
  }
  const payload: Record<string, unknown> = {};
  for (const k of ['id', 'name', 'rate_percent', 'country_code', 'currency', 'is_inclusive', 'is_active'] as const) {
    if (input[k] !== undefined) payload[k] = input[k];
  }
  if (!payload.name) throw new BillingConfigError('tax_name_required');
  return ok(
    await db(config).from('billing_tax_rates').upsert(payload).select().single(),
    'tax_write_failed',
  ) as TaxRate;
}

export async function deleteTaxRate(config: ServerConfig, id: string): Promise<void> {
  const res = await db(config).from('billing_tax_rates').delete().eq('id', id);
  if (res.error) throw new BillingConfigError('tax_delete_failed', 500, res.error.message);
}

/**
 * The rate that applies to a document. Country match wins over the global
 * rate; currency-scoped rates only apply to their currency.
 */
export async function resolveTaxPercent(
  config: ServerConfig,
  input: { currency: string; countryCode?: string | null },
): Promise<{ percent: number; rate: TaxRate | null }> {
  const rates = (await listTaxRates(config)).filter(
    (r) => r.is_active && (!r.currency || r.currency === input.currency),
  );
  const country = (input.countryCode || '').toUpperCase() || null;
  const match =
    (country && rates.find((r) => (r.country_code || '').toUpperCase() === country)) ||
    rates.find((r) => !r.country_code) ||
    null;
  return { percent: match ? Number(match.rate_percent) : 0, rate: match };
}

// ─── Coupons ───────────────────────────────────────────────────────────────

export interface Coupon {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percent' | 'fixed';
  percent_off: number | null;
  amount_off_minor: number | null;
  currency: string | null;
  applies_to_plans: string[];
  max_redemptions: number | null;
  redeemed_count: number;
  once_per_workspace: boolean;
  starts_at: string | null;
  expires_at: string | null;
  is_active: boolean;
}

export async function listCoupons(config: ServerConfig): Promise<Coupon[]> {
  return (ok(
    await db(config).from('billing_coupons').select('*').order('created_at', { ascending: false }),
    'coupons_read_failed',
  ) || []) as Coupon[];
}

export async function upsertCoupon(config: ServerConfig, input: Partial<Coupon>): Promise<Coupon> {
  const payload: Record<string, unknown> = {};
  for (const k of [
    'id', 'code', 'description', 'discount_type', 'percent_off', 'amount_off_minor',
    'currency', 'applies_to_plans', 'max_redemptions', 'once_per_workspace',
    'starts_at', 'expires_at', 'is_active',
  ] as const) {
    if (input[k] !== undefined) payload[k] = input[k];
  }
  if (typeof payload.code === 'string') payload.code = payload.code.trim().toUpperCase();
  if (!payload.id && !payload.code) throw new BillingConfigError('coupon_code_required');
  return ok(
    await db(config).from('billing_coupons').upsert(payload).select().single(),
    'coupon_write_failed',
  ) as Coupon;
}

export async function deleteCoupon(config: ServerConfig, id: string): Promise<void> {
  const res = await db(config).from('billing_coupons').delete().eq('id', id);
  if (res.error) throw new BillingConfigError('coupon_delete_failed', 500, res.error.message);
}

export interface CouponEvaluation {
  coupon: Coupon;
  discountMinor: number;
}

/**
 * Validates a coupon for a concrete purchase and returns the discount in minor
 * units. Throws with a stable code the UI can translate; never silently
 * returns zero for an invalid coupon.
 */
export async function evaluateCoupon(
  config: ServerConfig,
  input: {
    code: string;
    workspaceId: string;
    currency: string;
    subtotalMinor: number;
    planId?: string | null;
  },
): Promise<CouponEvaluation> {
  const code = input.code.trim().toUpperCase();
  const { data } = await db(config).from('billing_coupons').select('*').eq('code', code).maybeSingle();
  const coupon = data as Coupon | null;
  if (!coupon || !coupon.is_active) throw new BillingConfigError('coupon_not_found', 404);

  const now = Date.now();
  if (coupon.starts_at && Date.parse(coupon.starts_at) > now) throw new BillingConfigError('coupon_not_started', 409);
  if (coupon.expires_at && Date.parse(coupon.expires_at) < now) throw new BillingConfigError('coupon_expired', 409);
  if (coupon.max_redemptions !== null && coupon.redeemed_count >= coupon.max_redemptions) {
    throw new BillingConfigError('coupon_exhausted', 409);
  }
  if (coupon.applies_to_plans.length > 0 && (!input.planId || !coupon.applies_to_plans.includes(input.planId))) {
    throw new BillingConfigError('coupon_not_applicable', 409);
  }
  if (coupon.discount_type === 'fixed' && coupon.currency && coupon.currency !== input.currency) {
    throw new BillingConfigError('coupon_currency_mismatch', 409);
  }
  if (coupon.once_per_workspace) {
    const { count } = await db(config)
      .from('billing_coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('workspace_id', input.workspaceId);
    if ((count || 0) > 0) throw new BillingConfigError('coupon_already_used', 409);
  }

  const raw =
    coupon.discount_type === 'percent'
      ? Math.floor((input.subtotalMinor * Number(coupon.percent_off || 0)) / 100)
      : Number(coupon.amount_off_minor || 0);
  const discountMinor = Math.max(0, Math.min(raw, input.subtotalMinor));
  return { coupon, discountMinor };
}

/** Records a redemption once the invoice carrying the discount exists. */
export async function recordCouponRedemption(
  config: ServerConfig,
  input: { couponId: string; workspaceId: string; invoiceId: string; amountMinor: number; currency: string },
): Promise<void> {
  const client = db(config);
  const { error } = await client.from('billing_coupon_redemptions').insert({
    coupon_id: input.couponId,
    workspace_id: input.workspaceId,
    invoice_id: input.invoiceId,
    amount_minor: input.amountMinor,
    currency: input.currency,
  });
  if (error) {
    if (error.code === '23505') return; // same invoice, already recorded
    throw new BillingConfigError('coupon_redemption_failed', 500, error.message);
  }
  const { data } = await client.from('billing_coupons').select('redeemed_count').eq('id', input.couponId).maybeSingle();
  const next = Number((data as { redeemed_count?: number } | null)?.redeemed_count || 0) + 1;
  await client.from('billing_coupons').update({ redeemed_count: next }).eq('id', input.couponId);
}

// ─── Metered usage items ───────────────────────────────────────────────────

export interface UsageItem {
  key: string;
  display_name: Record<string, string>;
  unit: string;
  prices: Record<string, number>;
  is_active: boolean;
  sort_order: number;
}

export async function listUsageItems(config: ServerConfig): Promise<UsageItem[]> {
  return (ok(
    await db(config).from('billing_usage_items').select('*').order('sort_order'),
    'usage_items_read_failed',
  ) || []) as UsageItem[];
}

export async function upsertUsageItem(
  config: ServerConfig,
  input: Partial<UsageItem> & { key: string },
): Promise<UsageItem> {
  const payload: Record<string, unknown> = { key: input.key };
  for (const k of ['display_name', 'unit', 'prices', 'is_active', 'sort_order'] as const) {
    if (input[k] !== undefined) payload[k] = input[k];
  }
  return ok(
    await db(config).from('billing_usage_items').upsert(payload, { onConflict: 'key' }).select().single(),
    'usage_item_write_failed',
  ) as UsageItem;
}
