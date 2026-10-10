// ============================================================================
// SIMPLE BILLING — the workspace's account (docs/billing/SIMPLE_BILLING.md).
//
//   GET  /api/billing/account/:ws                         balance, plan, VAT, gateways
//   PUT  /api/billing/account/:ws/profile                 billing profile on receipts
//   GET  /api/billing/account/:ws/ledger                  history
//   GET  /api/billing/account/:ws/receipts/:ledgerId      one receipt
//   POST /api/billing/account/:ws/topup                   start a top-up checkout
//   POST /api/billing/account/:ws/payments/:id/verify     the return from the gateway
//   GET  /api/billing/account/:ws/payments/:id            status, for polling
//
// Every GET is read-only. Every money-moving POST needs MANAGE permission on
// the workspace. Amounts come from the server, never from the browser alone:
// the top-up amount the customer typed is validated, its VAT computed here,
// and the gateway's own confirmation is compared with the stored payment.
// ============================================================================

import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { logBillingEvent } from '../services/billing/index.js';
import { isAllowedBillingCallbackUrl, resolvePublicApiOrigin } from '../services/billing/callbackUrl.js';
import { editionErrorResponse } from '../services/billing/edition.js';
import {
  AccountBillingError,
  accountCurrency,
  accountPaymentNeedsBinding,
  createAccountPayment,
  failAccountPayment,
  getAccountView,
  getBillingSettings,
  getReceipt,
  isAccountPaymentLapsed,
  listLedger,
  patchAccountPayment,
  readAccountPayment,
  updateBillingProfile,
  verifyAccountPayment,
} from '../services/billing/account/index.js';
import { accountGateways, isIranianGateway, resolveAccountGateway } from '../services/billing/account/gateways.js';
import { resolveNamedBillingConfig } from '../services/billing/index.js';
import { chargeFor, topupAmountProblem, vatPercentFor } from '../../shared/simpleBilling.js';

export const billingAccountRouter = Router();

type JsonResponse = { status(code: number): { json(body: unknown): unknown } };

function fail(res: JsonResponse, e: unknown) {
  const editionError = editionErrorResponse(e);
  if (editionError) return res.status(editionError.status).json(editionError.body);
  if (e instanceof AccountBillingError) {
    return res.status(e.status).json({ error: e.code, details: e.details });
  }
  console.error('[billing-account]', e instanceof Error ? e.message : e);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

function viewerOf(auth: { isAdmin: boolean }) {
  return { isPlatformAdmin: auth.isAdmin };
}

function canManage(auth: { isAdmin: boolean; role: string | null }): boolean {
  return auth.isAdmin || ['owner', 'admin'].includes(String(auth.role || ''));
}

async function customerEmailOf(cfg: ReturnType<typeof serverConfigOf>, userId: string): Promise<string | undefined> {
  const { data } = await getServiceClient(cfg).from('profiles').select('email').eq('id', userId).maybeSingle();
  const email = (data as { email?: string | null } | null)?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

/** The return URL the gateway sends the customer back to, carrying our payment id. */
function returnUrls(browserUrl: string, paymentId: string, providerName: string, apiOrigin: string) {
  const browserReturn = new URL(browserUrl);
  browserReturn.searchParams.set('payment', paymentId);
  browserReturn.searchParams.set('provider', providerName);
  let gatewayCallback = browserReturn.toString();
  // Gateways refuse plain-http callbacks outside localhost; the API's return
  // hop (billing.ts /api/billing/return) bounces to the stored return URL.
  if (browserReturn.protocol !== 'https:' && browserReturn.hostname !== 'localhost' && browserReturn.hostname !== '127.0.0.1') {
    const fallback = new URL('/api/billing/account-return', apiOrigin);
    fallback.searchParams.set('payment', paymentId);
    fallback.searchParams.set('provider', providerName);
    gatewayCallback = fallback.toString();
  }
  return { browserReturnUrl: browserReturn.toString(), gatewayCallbackUrl: gatewayCallback };
}

// ─── Read ──────────────────────────────────────────────────────────────────

billingAccountRouter.get('/account/:workspaceId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const cfg = serverConfigOf(req);
    const view = await getAccountView(cfg, req.params.workspaceId);
    const gateways = canManage(auth)
      ? await accountGateways(cfg, req.params.workspaceId, view.currency, viewerOf(auth))
      : [];
    res.json({
      ...view,
      can_manage: canManage(auth),
      gateways: gateways.map((g) => ({
        provider_name: g.provider_name,
        display_name: g.display_name,
        is_test: g.is_test,
      })),
    });
  } catch (e) {
    fail(res, e);
  }
});

billingAccountRouter.get('/account/:workspaceId/ledger', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const result = await listLedger(serverConfigOf(req), req.params.workspaceId, {
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 20),
    });
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

billingAccountRouter.get('/account/:workspaceId/receipts/:ledgerId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const receipt = await getReceipt(serverConfigOf(req), req.params.workspaceId, req.params.ledgerId);
    if (!receipt) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ receipt });
  } catch (e) {
    fail(res, e);
  }
});

billingAccountRouter.get('/account/:workspaceId/payments/:paymentId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const payment = await readAccountPayment(serverConfigOf(req), req.params.paymentId);
    if (!payment || payment.workspace_id !== req.params.workspaceId) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({
      id: payment.id,
      status: payment.status,
      purpose: payment.purpose,
      currency: payment.currency,
      amount_minor: payment.amount_minor,
      net_minor: payment.net_minor,
      tax_minor: payment.tax_minor,
      ledger_id: payment.ledger_id,
      failure_reason: payment.failure_reason,
    });
  } catch (e) {
    fail(res, e);
  }
});

// ─── Billing profile ──────────────────────────────────────────────────────

const profileSchema = z.object({ profile: z.record(z.string(), z.string().max(300)) });

billingAccountRouter.put('/account/:workspaceId/profile', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const account = await updateBillingProfile(serverConfigOf(req), req.params.workspaceId, parsed.data.profile);
    res.json({ billing_profile: account.billing_profile });
  } catch (e) {
    fail(res, e);
  }
});

// ─── Top-up ────────────────────────────────────────────────────────────────

const topupSchema = z.object({
  /** Credit the customer wants, in minor units of the account currency (VAT is added on top). */
  amountMinor: z.number().int().positive(),
  providerName: z.string().min(2).max(60).optional(),
  callbackUrl: z.string().url(),
});

billingAccountRouter.post('/account/:workspaceId/topup', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = topupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  if (!isAllowedBillingCallbackUrl(req, cfg, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }

  let paymentId: string | null = null;
  try {
    const currency = await accountCurrency(cfg, workspaceId);
    const problem = topupAmountProblem(parsed.data.amountMinor, currency);
    if (problem) return res.status(400).json({ error: problem });

    const resolved = await resolveAccountGateway(cfg, workspaceId, currency, parsed.data.providerName, viewerOf(auth));
    if (!resolved) return res.status(400).json({ error: 'NO_PROVIDER_CONFIGURED' });

    const settings = await getBillingSettings(cfg);
    const vat = vatPercentFor(settings.vat_percent, currency);
    const charge = chargeFor(parsed.data.amountMinor, vat);

    const payment = await createAccountPayment(cfg, {
      workspaceId,
      provider: resolved.provider.name,
      currency,
      netMinor: charge.net,
      taxMinor: charge.tax,
      taxPercent: vat,
      purpose: 'topup',
      createdBy: auth.userId,
    });
    paymentId = payment.id;

    const apiOrigin = await resolvePublicApiOrigin(cfg.supabaseUrl, cfg.supabaseServiceRoleKey);
    const { browserReturnUrl, gatewayCallbackUrl } = returnUrls(
      parsed.data.callbackUrl,
      payment.id,
      resolved.provider.name,
      apiOrigin,
    );
    await patchAccountPayment(cfg, payment.id, { return_url: browserReturnUrl });

    const card = !isIranianGateway(resolved.provider.name);
    let result;
    try {
      result = await resolved.provider.createCheckoutSession(resolved.config, {
        workspaceId,
        planId: 'account',
        interval: 'monthly',
        currency,
        callbackUrl: gatewayCallbackUrl,
        // Card gateways carry it in their signed custom metadata; the webhook
        // settles exactly this payment (billing.ts webhook route).
        intentId: payment.id,
        ...(card
          ? { description: 'Account credit', customerEmail: await customerEmailOf(cfg, auth.userId) }
          : {}),
        metadata: { amount: String(charge.total) },
      });
    } catch (providerError) {
      const message = (providerError instanceof Error ? providerError.message : String(providerError || '')).trim().slice(0, 300) || 'checkout failed';
      console.warn(`[billing-account] provider=${resolved.provider.name} refused: ${message}`);
      await failAccountPayment(cfg, payment.id, 'failed', `checkout_failed: ${message}`).catch(() => undefined);
      return res.status(502).json({
        error: 'CHECKOUT_PROVIDER_ERROR',
        message,
        details: { provider: resolved.provider.name, providerMessage: message },
      });
    }

    // Fail-closed binding: a return can only be verified against the stored reference.
    const ref = result.providerRef || result.authority || result.sessionId || '';
    if (ref) {
      await patchAccountPayment(cfg, payment.id, { provider_ref: ref });
    } else if (accountPaymentNeedsBinding(resolved.provider.name)) {
      await failAccountPayment(cfg, payment.id, 'failed', 'binding_failed');
      return res.status(502).json({ error: 'CHECKOUT_REFERENCE_BINDING_FAILED' });
    }

    await logBillingEvent(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
      workspace_id: workspaceId,
      event_type: 'account_checkout_initiated',
      provider_name: resolved.provider.name,
      amount: charge.total,
      currency,
      status: 'pending',
      metadata: { paymentId: payment.id, purpose: 'topup' },
    }).catch(() => undefined);

    res.json({
      success: true,
      paymentId: payment.id,
      provider: resolved.provider.name,
      currency,
      net_minor: charge.net,
      tax_minor: charge.tax,
      amount_minor: charge.total,
      paymentUrl: result.paymentUrl,
      clientCheckout: result.clientCheckout,
    });
  } catch (e) {
    if (paymentId) await failAccountPayment(cfg, paymentId, 'failed', 'checkout_failed').catch(() => undefined);
    fail(res, e);
  }
});

// ─── Return from the gateway ──────────────────────────────────────────────

const verifySchema = z.object({
  provider: z.string().min(2).max(60),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

billingAccountRouter.post('/account/:workspaceId/payments/:paymentId/verify', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    const payment = await readAccountPayment(cfg, req.params.paymentId);
    if (!payment || payment.workspace_id !== req.params.workspaceId || payment.provider !== parsed.data.provider) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    const resolved = await resolveNamedBillingConfig(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, payment.workspace_id, payment.provider);
    if (!resolved || resolved.provider.name !== payment.provider) {
      return res.status(400).json({ error: 'PROVIDER_NOT_CONFIGURED' });
    }
    const outcome = await verifyAccountPayment(cfg, {
      payment,
      providerConfig: resolved.config,
      params: parsed.data.params,
    });
    // An unpaid attempt past its window is ended, so it stops showing as pending.
    if (outcome.status === 'pending' && payment.status === 'pending' && isAccountPaymentLapsed(payment)) {
      await failAccountPayment(cfg, payment.id, 'expired', 'expired');
      return res.json({ status: 'failed', reason: 'expired' });
    }
    res.json(outcome);
  } catch (e) {
    fail(res, e);
  }
});

// ─── Gateway callback hop for a non-https app origin ─────────────────────
// Forwards the gateway's result to the exact return URL stored on the
// payment at checkout. Never answers with data; only an allow-listed page.
billingAccountRouter.get('/account-return', async (req, res) => {
  try {
    const paymentId = typeof req.query.payment === 'string' ? req.query.payment : '';
    const providerName = typeof req.query.provider === 'string' ? req.query.provider : '';
    const payment = paymentId ? await readAccountPayment(serverConfigOf(req), paymentId) : null;
    if (!payment || payment.provider !== providerName || !payment.return_url) {
      return res.status(400).type('text/plain').send('Invalid payment return.');
    }
    const destination = new URL(payment.return_url);
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'payment' || key === 'provider') continue;
      if (typeof value === 'string') destination.searchParams.set(key, value);
    }
    destination.searchParams.set('payment', payment.id);
    destination.searchParams.set('provider', payment.provider);
    const target = destination.toString();
    const safe = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return res
      .status(303)
      .location(target)
      .type('html')
      .send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><p><a href="${safe}">&#8594;</a></p>`);
  } catch {
    return res.status(502).type('text/plain').send('Payment return is temporarily unavailable.');
  }
});
