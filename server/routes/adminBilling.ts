// ============================================================
// UNIFIED BILLING — SUPER-ADMIN FINANCE API (/api/admin/billing)
//
// The app-wide commercial control panel: currencies, exchange rates,
// gateways, tax, coupons, metered items, plus the global invoice / payment /
// customer views. Every route re-verifies platform admin identity from the
// first-party session before touching service-role data.
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import {
  BillingConfigError,
  listCurrencies, upsertCurrency, deleteCurrency,
  listExchangeRates, publishExchangeRate,
  listGateways, upsertGateway,
  listTaxRates, upsertTaxRate, deleteTaxRate,
  listCoupons, upsertCoupon, deleteCoupon,
  listUsageItems, upsertUsageItem,
} from '../services/billing/config/index.js';

export const adminBillingRouter = Router();

function cfg(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

function fail(res: any, e: unknown) {
  if (e instanceof BillingConfigError) {
    return res.status(e.status).json({ error: e.code, message: e.message });
  }
  if (e instanceof z.ZodError) {
    return res.status(400).json({ error: 'invalid_input', details: e.flatten().fieldErrors });
  }
  return res.status(500).json({ error: 'internal_error', message: e instanceof Error ? e.message : String(e) });
}

// ─── Currencies ────────────────────────────────────────────────────────────

adminBillingRouter.get('/currencies', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ currencies: await listCurrencies(cfg(req)) });
  } catch (e) { fail(res, e); }
});

const currencySchema = z.object({
  code: z.string().min(3).max(3),
  display_name: z.record(z.string()).optional(),
  symbol: z.string().max(8).optional(),
  minor_units: z.number().int().min(0).max(4).optional(),
  is_base: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

adminBillingRouter.put('/currencies', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ currency: await upsertCurrency(cfg(req), currencySchema.parse(req.body) as any) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.delete('/currencies/:code', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    await deleteCurrency(cfg(req), String(req.params.code).toUpperCase());
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ─── Exchange rates ────────────────────────────────────────────────────────

adminBillingRouter.get('/exchange-rates', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ rates: await listExchangeRates(cfg(req)) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.post('/exchange-rates', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z
      .object({ base_code: z.string().length(3), quote_code: z.string().length(3), rate: z.number().positive() })
      .parse(req.body);
    res.json({ rate: await publishExchangeRate(cfg(req), body as any) });
  } catch (e) { fail(res, e); }
});

// ─── Gateways ──────────────────────────────────────────────────────────────

adminBillingRouter.get('/gateways', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ gateways: await listGateways(cfg(req)) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.put('/gateways', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z
      .object({
        provider_name: z.string().min(2),
        display_name: z.record(z.string()).optional(),
        is_active: z.boolean().optional(),
        is_test: z.boolean().optional(),
        currencies: z.array(z.string().length(3)).optional(),
        countries: z.array(z.string().length(2)).optional(),
        sort_order: z.number().int().optional(),
        config: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    res.json({ gateway: await upsertGateway(cfg(req), body as any) });
  } catch (e) { fail(res, e); }
});

// ─── Tax ───────────────────────────────────────────────────────────────────

adminBillingRouter.get('/tax-rates', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ taxRates: await listTaxRates(cfg(req)) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.put('/tax-rates', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1),
        rate_percent: z.number().min(0).max(100),
        country_code: z.string().length(2).nullable().optional(),
        currency: z.string().length(3).nullable().optional(),
        is_inclusive: z.boolean().optional(),
        is_active: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({ taxRate: await upsertTaxRate(cfg(req), body as any) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.delete('/tax-rates/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    await deleteTaxRate(cfg(req), String(req.params.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ─── Coupons ───────────────────────────────────────────────────────────────

adminBillingRouter.get('/coupons', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ coupons: await listCoupons(cfg(req)) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.put('/coupons', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        code: z.string().min(2).max(40).optional(),
        description: z.string().max(300).nullable().optional(),
        discount_type: z.enum(['percent', 'fixed']).optional(),
        percent_off: z.number().positive().max(100).nullable().optional(),
        amount_off_minor: z.number().int().positive().nullable().optional(),
        currency: z.string().length(3).nullable().optional(),
        applies_to_plans: z.array(z.string().uuid()).optional(),
        max_redemptions: z.number().int().positive().nullable().optional(),
        once_per_workspace: z.boolean().optional(),
        starts_at: z.string().datetime().nullable().optional(),
        expires_at: z.string().datetime().nullable().optional(),
        is_active: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({ coupon: await upsertCoupon(cfg(req), body as any) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.delete('/coupons/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    await deleteCoupon(cfg(req), String(req.params.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ─── Metered usage items ───────────────────────────────────────────────────

adminBillingRouter.get('/usage-items', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ usageItems: await listUsageItems(cfg(req)) });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.put('/usage-items', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z
      .object({
        key: z.string().min(2).max(40),
        display_name: z.record(z.string()).optional(),
        unit: z.string().max(30).optional(),
        prices: z.record(z.number().nonnegative()).optional(),
        is_active: z.boolean().optional(),
        sort_order: z.number().int().optional(),
      })
      .parse(req.body);
    res.json({ usageItem: await upsertUsageItem(cfg(req), body as any) });
  } catch (e) { fail(res, e); }
});

// ─── Global financial views ────────────────────────────────────────────────

adminBillingRouter.get('/overview', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const client = getServiceClient(cfg(req));
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [paid, open, payments, wallets, subs] = await Promise.all([
      client.from('billing_invoices').select('total_irr, currency, paid_at').eq('status', 'paid').gte('paid_at', since),
      client.from('billing_invoices').select('amount_due_irr, currency').in('status', ['open', 'past_due']),
      client.from('billing_payments').select('id', { count: 'exact', head: true }).eq('status', 'succeeded'),
      client.from('billing_wallet_accounts').select('available_balance_irr, currency'),
      client.from('workspace_subscriptions').select('status', { count: 'exact', head: true }).eq('status', 'active'),
    ]);

    const sumBy = (rows: any[] | null, field: string) => {
      const out: Record<string, number> = {};
      for (const r of rows || []) {
        const c = r.currency || 'IRR';
        out[c] = (out[c] || 0) + Number(r[field] || 0);
      }
      return out;
    };

    res.json({
      revenue30d: sumBy(paid.data as any[], 'total_irr'),
      outstanding: sumBy(open.data as any[], 'amount_due_irr'),
      walletBalances: sumBy(wallets.data as any[], 'available_balance_irr'),
      successfulPayments: payments.count || 0,
      activeSubscriptions: subs.count || 0,
    });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.get('/invoices', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    let q = getServiceClient(cfg(req))
      .from('billing_invoices')
      .select('*, workspaces(name, slug)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (status) q = q.eq('status', status);
    if (search) q = q.ilike('invoice_number', `%${search}%`);

    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ invoices: data || [], total: count || 0, page, pageSize });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.get('/payments', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
    const { data, count, error } = await getServiceClient(cfg(req))
      .from('billing_payments')
      .select('*, workspaces(name, slug)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw new Error(error.message);
    res.json({ payments: data || [], total: count || 0, page, pageSize });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.get('/customers', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const client = getServiceClient(cfg(req));
    let q = client
      .from('workspaces')
      .select('id, name, slug, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (search) q = q.ilike('name', `%${search}%`);
    const { data: workspaces, error } = await q;
    if (error) throw new Error(error.message);

    const ids = (workspaces || []).map((w: any) => w.id);
    const [subs, wallets] = await Promise.all([
      client
        .from('workspace_subscriptions')
        .select('workspace_id, status, plan_id, billing_interval, current_period_end, billing_plans(name, slug)')
        .in('workspace_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
      client
        .from('billing_wallet_accounts')
        .select('workspace_id, available_balance_irr, currency')
        .in('workspace_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    ]);

    const subByWs = new Map((subs.data || []).map((s: any) => [s.workspace_id, s]));
    const walletByWs = new Map((wallets.data || []).map((w: any) => [w.workspace_id, w]));

    res.json({
      customers: (workspaces || []).map((w: any) => ({
        ...w,
        subscription: subByWs.get(w.id) || null,
        wallet: walletByWs.get(w.id) || null,
      })),
    });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.get('/audit', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const { data, error } = await getServiceClient(cfg(req))
      .from('billing_v2_audit')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    res.json({ events: data || [] });
  } catch (e) { fail(res, e); }
});
