// ============================================================================
// BILLING ENGINE V2 — CUSTOMER (WORKSPACE) SURFACE, Phase D
//
// One cohesive endpoint per screen. Rules enforced here, never in the browser:
//
//   * every GET is read-only — no grant, no settlement, no activation;
//   * every financial POST requires workspace MANAGE permission (server-side:
//     hiding a button is not authorization);
//   * an invoice id from another workspace simply does not resolve (404);
//   * purchases are invoice-driven; the wallet deposit is the sole exception;
//   * a preview the customer confirmed must still be true at submit time,
//     otherwise the mutation is refused as stale instead of charged.
// ============================================================================

import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { resolveBillingConfig, logBillingEvent } from '../services/billing/index.js';
import {
  buildBillingOverview,
  listInvoices,
  getInvoiceDetail,
  buildWalletView,
  listTransactions,
  INVOICE_FILTERS,
  type InvoiceFilter,
} from '../services/billing/customer/readModels.js';
import {
  previewPlanChange,
  applyPlanChange,
  cancelPendingPlanChange,
  setWalletAutoPay,
  issueAiCreditPurchase,
  BillingActionError,
} from '../services/billing/customer/actions.js';
import {
  settleInvoiceFromWallet,
  applyInvoiceEffects,
  beginCollection,
  releaseCollection,
  getInvoice,
  InvoiceSettlementError,
} from '../services/billing/invoice/settle.js';
import { createWalletDeposit } from '../services/billing/wallet/index.js';
import {
  createInvoiceIntent,
  createWalletDepositIntent,
  setPaymentIntentProviderRef,
  markPaymentIntentFailed,
  IRAN_PROVIDERS,
} from '../services/billing/paymentIntent.js';
import { requiresReferenceBinding } from '../services/billing/providerBinding.js';
import { isV2Active } from '../services/billing/rollout.js';

export const billingV2CustomerRouter = Router();

function fail(res: any, e: unknown) {
  if (e instanceof BillingActionError) {
    return res.status(e.status).json({ error: e.code, message: e.message, details: e.details ?? null });
  }
  if (e instanceof InvoiceSettlementError) {
    return res.status((e as any).status || 409).json({ error: (e as any).code || 'SETTLEMENT_FAILED' });
  }
  const message = e instanceof Error ? e.message : 'unexpected_error';
  return res.status(500).json({ error: 'INTERNAL_ERROR', message });
}

function pageParams(req: any) {
  return {
    page: Number(req.query.page ?? 1) || 1,
    pageSize: Number(req.query.pageSize ?? 10) || 10,
  };
}

function isManage(auth: { isAdmin: boolean; role: string | null } | null): boolean {
  if (!auth) return false;
  return auth.isAdmin || ['owner', 'admin'].includes(String(auth.role || ''));
}

/** Same-deployment guard for anything handed to a bank as a return URL. */
function isAllowedCallbackUrl(req: any, raw: string): boolean {
  try {
    const target = new URL(raw);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    if (host && target.host === host) return true;
    const allowed = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || '');
    if (allowed) return target.origin === new URL(allowed).origin;
    return false;
  } catch {
    return false;
  }
}

// ─── Platform commercial configuration (read-only for the customer) ────────

/** Payment methods the customer may actually use for a given currency. */
billingV2CustomerRouter.get('/workspaces/:workspaceId/gateways', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const currency = String(req.query.currency || 'IRR').toUpperCase();
    const gateways = await listPayableGateways(serverConfigOf(req), currency);
    res.json({
      currency,
      gateways: gateways.map((g) => ({
        provider_name: g.provider_name,
        display_name: g.display_name,
        is_test: g.is_test,
        currencies: g.currencies,
      })),
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Validates a coupon against a concrete amount. Never applies it by itself. */
billingV2CustomerRouter.post('/workspaces/:workspaceId/coupons/validate', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  if (!isManage(auth)) return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    const body = z
      .object({
        code: z.string().min(2).max(40),
        currency: z.string().length(3).default('IRR'),
        subtotalMinor: z.number().int().nonnegative(),
        planId: z.string().uuid().nullish(),
      })
      .parse(req.body);
    const result = await evaluateCoupon(serverConfigOf(req), {
      code: body.code,
      workspaceId: req.params.workspaceId,
      currency: body.currency.toUpperCase(),
      subtotalMinor: body.subtotalMinor,
      planId: body.planId ?? null,
    });
    res.json({
      valid: true,
      code: result.coupon.code,
      discountMinor: result.discountMinor,
      discountType: result.coupon.discount_type,
    });
  } catch (e) {
    if (e instanceof BillingConfigError) {
      return res.status(e.status).json({ valid: false, error: e.code });
    }
    fail(res, e);
  }
});

// ─── Overview ──────────────────────────────────────────────────────────────


billingV2CustomerRouter.get('/workspaces/:workspaceId/overview', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const overview = await buildBillingOverview(serverConfigOf(req), req.params.workspaceId, {
      manage: isManage(auth),
    });
    res.json(overview);
  } catch (e) {
    fail(res, e);
  }
});

// ─── Invoices ──────────────────────────────────────────────────────────────

billingV2CustomerRouter.get('/workspaces/:workspaceId/invoices', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const filterRaw = String(req.query.filter || 'all');
  const filter = (INVOICE_FILTERS as readonly string[]).includes(filterRaw)
    ? (filterRaw as InvoiceFilter)
    : 'all';
  try {
    res.json(await listInvoices(serverConfigOf(req), req.params.workspaceId, { filter, ...pageParams(req) }));
  } catch (e) {
    fail(res, e);
  }
});

billingV2CustomerRouter.get('/workspaces/:workspaceId/invoices/:invoiceId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const detail = await getInvoiceDetail(
      serverConfigOf(req),
      req.params.workspaceId,
      req.params.invoiceId,
      { manage: isManage(auth) },
    );
    // Fail closed: another workspace's invoice is indistinguishable from a
    // non-existent one.
    if (!detail) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(detail);
  } catch (e) {
    fail(res, e);
  }
});

/** Pay an open invoice from the wallet: debit + settle + apply, atomically. */
billingV2CustomerRouter.post('/workspaces/:workspaceId/invoices/:invoiceId/pay-wallet', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const invoiceId = req.params.invoiceId;

  try {
    const invoice = await getInvoice(cfg, invoiceId);
    if (!invoice || invoice.workspace_id !== workspaceId) return res.status(404).json({ error: 'NOT_FOUND' });

    const settlement = await settleInvoiceFromWallet(cfg, { invoiceId, actorId: auth.userId });
    let application: unknown = null;
    if ((settlement as any).status === 'paid') {
      application = await applyInvoiceEffects(cfg, invoiceId);
    }
    res.json({ success: true, settlement, application });
  } catch (e) {
    fail(res, e);
  }
});

const checkoutSchema = z.object({ callbackUrl: z.string().url() });

/** Start a gateway collection for an open invoice. */
billingV2CustomerRouter.post('/workspaces/:workspaceId/invoices/:invoiceId/checkout', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });

  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const invoiceId = req.params.invoiceId;
  if (!isAllowedCallbackUrl(req, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }

  let hold: { collection_id: string } | null = null;
  try {
    const invoice = await getInvoice(cfg, invoiceId);
    if (!invoice || invoice.workspace_id !== workspaceId) return res.status(404).json({ error: 'NOT_FOUND' });
    const due = Number((invoice as any).amount_due_irr ?? 0);
    if (!['open', 'partially_paid', 'past_due'].includes((invoice as any).status) || due <= 0) {
      return res.status(409).json({ error: 'INVOICE_NOT_PAYABLE' });
    }

    const resolved = await resolveBillingConfig(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, workspaceId);
    if (!resolved) return res.status(400).json({ error: 'NO_PROVIDER_CONFIGURED' });
    if (!IRAN_PROVIDERS.has(resolved.provider.name)) {
      return res.status(400).json({ error: 'PROVIDER_NOT_SUPPORTED' });
    }

    // Exclusive collection: the wallet auto-pay worker and a second tab can
    // never collect the same invoice at the same time.
    hold = await beginCollection(cfg, {
      invoiceId,
      channel: 'gateway',
      amountIrr: due,
      commandKey: `customer_checkout:${invoiceId}:${Date.now()}`,
      ttlSeconds: 900,
    });

    const intent = await createInvoiceIntent(cfg, {
      workspaceId,
      invoiceId,
      amountIrr: due,
      providerName: resolved.provider.name,
      planId: (invoice as any).plan_id ?? null,
      interval: (invoice as any).billing_interval ?? null,
      actionType: ((invoice as any).effect_snapshot?.action_type as any) ?? null,
      planNameSnapshot: (invoice as any).plan_name_snapshot ?? null,
      invoiceNumber: (invoice as any).invoice_number,
      metadata: { origin: 'customer_invoice_checkout', collectionId: hold.collection_id },
    });

    const sep = parsed.data.callbackUrl.includes('?') ? '&' : '?';
    const callbackUrl = `${parsed.data.callbackUrl}${sep}intent=${intent.id}&provider=${encodeURIComponent(resolved.provider.name)}`;

    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId,
      planId: (invoice as any).plan_id || 'invoice',
      interval: ((invoice as any).billing_interval || 'monthly') as any,
      currency: 'IRR',
      callbackUrl,
      metadata: { amount: String(due), invoiceId },
    });

    // Fail-closed reference binding: an unbound intent must never be reported
    // as a live checkout — the callback could otherwise accept any payment.
    const ref = result.providerRef || result.authority || result.sessionId || '';
    const bindingRequired = requiresReferenceBinding(resolved.provider.name);
    if (bindingRequired || ref) {
      try {
        await setPaymentIntentProviderRef(cfg, intent.id, ref);
      } catch (bindError: any) {
        await markPaymentIntentFailed(cfg, intent.id, String(bindError?.message || 'binding_failed'));
        if (bindingRequired) {
          await releaseCollection(cfg, hold.collection_id, 'binding_failed').catch(() => undefined);
          return res.status(502).json({ error: 'CHECKOUT_REFERENCE_BINDING_FAILED' });
        }
      }
    }

    await logBillingEvent(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
      workspace_id: workspaceId,
      event_type: 'checkout_initiated',
      provider_name: resolved.provider.name,
      amount: due,
      currency: 'IRR',
      status: 'pending',
      metadata: { invoiceId, intentId: intent.id },
    });

    res.json({ success: true, ...result, intentId: intent.id, invoiceNumber: (invoice as any).invoice_number });
  } catch (e) {
    if (hold) {
      await releaseCollection(serverConfigOf(req), hold.collection_id, 'checkout_failed').catch(
        () => undefined,
      );
    }
    fail(res, e);
  }
});

// ─── Plans / plan change ───────────────────────────────────────────────────

billingV2CustomerRouter.get('/workspaces/:workspaceId/plans', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const cfg = serverConfigOf(req);
  const sb = getServiceClient(cfg);
  try {
    const [{ data: plans }, { data: sub }] = await Promise.all([
      sb.from('billing_plans').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
      sb
        .from('workspace_subscriptions')
        .select('plan_id, billing_interval, pending_change_type, next_plan_id')
        .eq('workspace_id', req.params.workspaceId)
        .maybeSingle(),
    ]);

    res.json({
      currentPlanId: (sub as any)?.plan_id ?? null,
      currentInterval: (sub as any)?.billing_interval ?? null,
      pendingPlanId: (sub as any)?.next_plan_id ?? null,
      plans: (plans || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        monthlyPriceIrr: Math.round(Number(p.prices?.IRR?.monthly ?? p.price_monthly ?? 0)) || 0,
        yearlyPriceIrr: Math.round(Number(p.prices?.IRR?.yearly ?? p.price_yearly ?? 0)) || 0,
        aiMonthlyAllowanceIrr: Math.round(Number(p.limits?.ai_credits_per_month ?? 0)) || 0,
        limits: p.limits ?? {},
        features: p.features ?? [],
        isFree:
          Number(p.prices?.IRR?.monthly ?? p.price_monthly ?? 0) <= 0 &&
          Number(p.prices?.IRR?.yearly ?? p.price_yearly ?? 0) <= 0,
      })),
    });
  } catch (e) {
    fail(res, e);
  }
});

const planChangeSchema = z.object({
  planId: z.string().uuid(),
  interval: z.enum(['monthly', 'yearly']),
  mode: z.enum(['immediate', 'next_cycle']),
});

billingV2CustomerRouter.post('/workspaces/:workspaceId/plan-change/preview', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = planChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const { planId, interval, mode } = parsed.data;
    res.json(await previewPlanChange(serverConfigOf(req), req.params.workspaceId, { planId, interval, mode }));
  } catch (e) {
    fail(res, e);
  }
});

billingV2CustomerRouter.post('/workspaces/:workspaceId/plan-change', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = planChangeSchema.extend({ expectedAmountIrr: z.number().int().min(0) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const { planId, interval, mode, expectedAmountIrr } = parsed.data;
    res.json(
      await applyPlanChange(serverConfigOf(req), req.params.workspaceId, {
        planId,
        interval,
        mode,
        expectedAmountIrr,
      }),
    );
  } catch (e) {
    fail(res, e);
  }
});

billingV2CustomerRouter.post('/workspaces/:workspaceId/plan-change/cancel', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  try {
    res.json(await cancelPendingPlanChange(serverConfigOf(req), req.params.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});

// ─── Wallet ────────────────────────────────────────────────────────────────

billingV2CustomerRouter.get('/workspaces/:workspaceId/wallet', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    res.json(await buildWalletView(serverConfigOf(req), req.params.workspaceId, pageParams(req)));
  } catch (e) {
    fail(res, e);
  }
});

billingV2CustomerRouter.put('/workspaces/:workspaceId/wallet/auto-pay', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    res.json(await setWalletAutoPay(serverConfigOf(req), req.params.workspaceId, parsed.data.enabled));
  } catch (e) {
    fail(res, e);
  }
});

const depositSchema = z.object({ amountIrr: z.number().int().positive() });

/**
 * Deposit receipt shown BEFORE the bank. Amount bounds come from server policy,
 * so a hand-crafted request cannot deposit an out-of-policy amount.
 */
billingV2CustomerRouter.post('/workspaces/:workspaceId/wallet/deposit/preview', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    const view = await buildWalletView(cfg, req.params.workspaceId, { page: 1, pageSize: 5 });
    const { minIrr, maxIrr, allowCustom, presetsIrr } = view.deposit;
    const amount = parsed.data.amountIrr;
    if (amount < minIrr || amount > maxIrr) return res.status(400).json({ error: 'AMOUNT_OUT_OF_RANGE' });
    if (!allowCustom && !presetsIrr.includes(amount)) {
      return res.status(400).json({ error: 'AMOUNT_NOT_ALLOWED' });
    }

    const deposit = await createWalletDeposit(cfg, {
      workspaceId: req.params.workspaceId,
      amountIrr: amount,
      metadata: { origin: 'customer_wallet_deposit' },
    });
    res.json({
      deposit: {
        id: deposit.id,
        documentNumber: deposit.document_number,
        documentType: 'wallet_deposit',
        amountIrr: Number(deposit.amount_irr),
        createdAt: deposit.created_at,
      },
    });
  } catch (e) {
    fail(res, e);
  }
});

billingV2CustomerRouter.post('/workspaces/:workspaceId/wallet/deposit/checkout', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = z
    .object({ depositId: z.string().uuid(), callbackUrl: z.string().url() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  if (!isAllowedCallbackUrl(req, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }

  try {
    const sb = getServiceClient(cfg);
    const { data: deposit } = await sb
      .from('billing_wallet_deposits')
      .select('*')
      .eq('id', parsed.data.depositId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!deposit) return res.status(404).json({ error: 'NOT_FOUND' });
    if ((deposit as any).status !== 'pending') return res.status(409).json({ error: 'DEPOSIT_NOT_PENDING' });

    const resolved = await resolveBillingConfig(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, workspaceId);
    if (!resolved) return res.status(400).json({ error: 'NO_PROVIDER_CONFIGURED' });
    if (!IRAN_PROVIDERS.has(resolved.provider.name)) return res.status(400).json({ error: 'PROVIDER_NOT_SUPPORTED' });

    const amount = Number((deposit as any).amount_irr);
    const intent = await createWalletDepositIntent(cfg, {
      workspaceId,
      depositId: (deposit as any).id,
      documentNumber: (deposit as any).document_number,
      amountIrr: amount,
      providerName: resolved.provider.name,
      metadata: { origin: 'customer_wallet_deposit' },
    });
    await sb
      .from('billing_wallet_deposits')
      .update({ payment_intent_id: intent.id })
      .eq('id', (deposit as any).id);

    const sep = parsed.data.callbackUrl.includes('?') ? '&' : '?';
    const callbackUrl = `${parsed.data.callbackUrl}${sep}intent=${intent.id}&provider=${encodeURIComponent(resolved.provider.name)}`;
    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId,
      planId: 'wallet_deposit',
      interval: 'monthly',
      currency: 'IRR',
      callbackUrl,
      metadata: { amount: String(amount), depositId: (deposit as any).id },
    });

    const ref = result.providerRef || result.authority || result.sessionId || '';
    const bindingRequired = requiresReferenceBinding(resolved.provider.name);
    if (bindingRequired || ref) {
      try {
        await setPaymentIntentProviderRef(cfg, intent.id, ref);
      } catch (bindError: any) {
        await markPaymentIntentFailed(cfg, intent.id, String(bindError?.message || 'binding_failed'));
        if (bindingRequired) return res.status(502).json({ error: 'CHECKOUT_REFERENCE_BINDING_FAILED' });
      }
    }

    res.json({ success: true, ...result, intentId: intent.id, documentNumber: (deposit as any).document_number });
  } catch (e) {
    fail(res, e);
  }
});

// ─── AI credit purchase (invoice-driven) ───────────────────────────────────

billingV2CustomerRouter.post('/workspaces/:workspaceId/ai-credit/invoice', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = z.object({ amountIrr: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    if (!(await isV2Active(cfg, req.params.workspaceId))) {
      return res.status(409).json({ error: 'BILLING_V2_REQUIRED' });
    }
    const sb = getServiceClient(cfg);
    const { data: policy } = await sb
      .from('platform_settings')
      .select('ai_topup_min_toman, ai_topup_max_toman')
      .maybeSingle();
    const minIrr = Math.round(Number((policy as any)?.ai_topup_min_toman ?? 50_000)) * 10;
    const maxIrr = Math.round(Number((policy as any)?.ai_topup_max_toman ?? 100_000_000)) * 10;

    const invoice = await issueAiCreditPurchase(cfg, req.params.workspaceId, parsed.data.amountIrr, {
      minIrr,
      maxIrr,
    });
    res.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amountIrr: Number((invoice as any).amount_due_irr),
    });
  } catch (e) {
    fail(res, e);
  }
});

// ─── Transactions (money movement) ─────────────────────────────────────────

billingV2CustomerRouter.get('/workspaces/:workspaceId/transactions', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    res.json(await listTransactions(serverConfigOf(req), req.params.workspaceId, pageParams(req)));
  } catch (e) {
    fail(res, e);
  }
});
