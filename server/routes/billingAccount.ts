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
//   GET  /api/billing/account/:ws/plans                   plans to choose, in the account currency
//   GET  /api/billing/account/:ws/quote                   what choosing a plan does and costs
//   POST /api/billing/account/:ws/plan                    buy a plan from the balance
//   POST /api/billing/account/:ws/renew                   pay the next period from the balance
//   POST /api/billing/account/:ws/upgrade                 upgrade now from the balance
//   POST /api/billing/account/:ws/change                  change at the period end (or cancel it)
//   PUT  /api/billing/account/:ws/auto-renew              auto-renew on/off
//   POST /api/billing/account/:ws/checkout                pay online for a plan, renewal or upgrade
//                                                         (autoRenew: and save the card, phase 3b)
//   POST /api/billing/account/:ws/card/charge             upgrade now, charged to the saved card
//   POST /api/billing/account/:ws/card/update             change the card (or pay a failed renewal)
//   DELETE /api/billing/account/:ws/card                  remove the saved card
//
// Every GET is read-only. Every money-moving POST needs MANAGE permission on
// the workspace. Amounts come from the server, never from the browser alone:
// the top-up amount the customer typed is validated, its VAT computed here,
// and the gateway's own confirmation is compared with the stored payment.
//
// The saved card (Multi Region only, services/billing/account/card.ts): a
// Paddle subscription that renews the plan. While it is live it pays every
// renewal (paying one online is refused), plan changes wait while it is
// past_due or Paddle is about to charge it, and after a change the Paddle
// subscription is synced at once.
// ============================================================================

import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { logBillingEvent } from '../services/billing/index.js';
import { isAllowedBillingCallbackUrl, resolvePublicApiOrigin } from '../services/billing/callbackUrl.js';
import { allowedOrigins } from '../services/platformOrigins.js';
import { resolveAppBaseUrl } from '../services/auth-email.js';
import { editionErrorResponse } from '../services/billing/edition.js';
import {
  AccountBillingError,
  accountCurrency,
  accountPaymentNeedsBinding,
  createAccountPayment,
  expireAccountPayment,
  failAccountPayment,
  getAccountView,
  getBillingSettings,
  getReceipt,
  isAccountPaymentLapsed,
  isCheckoutPayment,
  listLedger,
  patchAccountPayment,
  readAccountPayment,
  updateBillingProfile,
  verifyAccountPayment,
} from '../services/billing/account/index.js';
import { accountGateways, isIranianGateway, resolveAccountGateway, type GatewayViewer } from '../services/billing/account/gateways.js';
import {
  accountPlanState,
  amountNeededFor,
  buyPlan,
  listPlanOptions,
  processDueNow,
  quotePlanChange,
  scheduleChange,
  setAutoRenew,
  upgradePlan,
} from '../services/billing/account/plans.js';
import {
  assertCardAllowsPlanChange,
  cardAvailability,
  cardUpdateCheckout,
  cardView,
  chargeCardForUpgrade,
  prepareCardSetup,
  removeCard,
  renewWithCard,
  syncWorkspaceCard,
  type CardView,
} from '../services/billing/account/card.js';
import { planNamesFor } from '../services/billing/account/notify.js';
import { getBillingRegion } from '../services/billing/edition.js';
import { resolveNamedBillingConfig } from '../services/billing/index.js';
import {
  PADDLE_MIN_CHARGE_MINOR,
  TOPUP_LIMITS,
  chargeFor,
  topupAmountProblem,
  vatPercentFor,
} from '../../shared/simpleBilling.js';

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

/** The card part of the account view: what a member who cannot manage billing (and Iran) sees. */
const NO_CARD = { card: null as CardView | null, card_available: false, card_providers: [] as string[] };

/**
 * The saved card and whether one can be saved, for the billing page (the
 * International edition only: Iran never has a card, and is not asked).
 * A failed read shows no card rather than failing the page; every card
 * action re-reads it.
 */
async function cardSection(
  cfg: ReturnType<typeof serverConfigOf>,
  workspaceId: string,
  currency: string,
  viewer: GatewayViewer,
): Promise<typeof NO_CARD> {
  const [card, availability] = await Promise.all([
    cardView(cfg, workspaceId).catch((e) => {
      console.warn('[billing-account] card view:', e instanceof Error ? e.message : e);
      return null;
    }),
    cardAvailability(cfg, workspaceId, currency, viewer).catch(() => ({ available: false, providers: [] as string[] })),
  ]);
  return { card, card_available: availability.available, card_providers: availability.providers };
}

/** Card routes exist in the International edition only (Iran never has a card). */
async function cardsOffered(cfg: ReturnType<typeof serverConfigOf>): Promise<boolean> {
  return (await getBillingRegion(cfg)).edition === 'international';
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
    // A period that ended before the hourly job ran is processed first, so
    // the page shows (and acts on) what is true now.
    await processDueNow(cfg, req.params.workspaceId);
    const [view, planState] = await Promise.all([
      getAccountView(cfg, req.params.workspaceId),
      accountPlanState(cfg, req.params.workspaceId),
    ]);
    const gateways = canManage(auth)
      ? await accountGateways(cfg, req.params.workspaceId, view.currency, viewerOf(auth))
      : [];
    const card = canManage(auth) && view.edition === 'international'
      ? await cardSection(cfg, req.params.workspaceId, view.currency, viewerOf(auth))
      : NO_CARD;
    res.json({
      ...view,
      ...planState,
      can_manage: canManage(auth),
      gateways: gateways.map((g) => ({
        provider_name: g.provider_name,
        display_name: g.display_name,
        is_test: g.is_test,
      })),
      ...card,
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
      purpose_result: payment.purpose_result,
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
  /** The currency the page showed; a different account currency is refused, never charged. */
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  providerName: z.string().min(2).max(60).optional(),
  callbackUrl: z.string().url(),
});

type CheckoutAuth = NonNullable<Awaited<ReturnType<typeof authorizeWorkspaceAccess>>>;

const CHECKOUTS_PER_HOUR = 10;

async function recentCheckoutCount(cfg: ReturnType<typeof serverConfigOf>, workspaceId: string): Promise<number> {
  const { count, error } = await getServiceClient(cfg)
    .from('billing_account_payments')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if (error) throw new Error(error.message || 'payment count failed');
  return count ?? 0;
}

/**
 * Starts a gateway checkout for `netMinor` (VAT added on top) and binds it to
 * a payment row created first. A purpose other than a top-up is spent on in
 * the same transaction that credits it (billing_account_settle_payment).
 *
 * `cardSetup`: the checkout also saves the card (Paddle, phase 3b). Its price
 * recurs every period (the full price of the plan, VAT on top, never below
 * Paddle's minimum); older card checkouts are closed BEFORE this payment row
 * exists (prepareCardSetup), and the row is a 'card_setup' one. Paying it
 * makes Paddle create the subscription that later renewals are charged to.
 */
async function startAccountCheckout(
  req: Parameters<Parameters<typeof billingAccountRouter.post>[1]>[0],
  res: Parameters<Parameters<typeof billingAccountRouter.post>[1]>[1],
  auth: CheckoutAuth,
  input: {
    currency: string;
    netMinor: number;
    providerName?: string;
    callbackUrl: string;
    purpose: 'topup' | 'plan' | 'renewal' | 'upgrade';
    purposeDetail?: Record<string, unknown>;
    description: string;
    cardSetup?: { purpose: 'plan' | 'renewal'; planId: string; interval: 'monthly' | 'yearly' };
  },
) {
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  let paymentId: string | null = null;
  try {
    // Each attempt is a payment row and a live gateway transaction: a few an
    // hour are plenty for a person; a loop is refused.
    if ((await recentCheckoutCount(cfg, workspaceId)) >= CHECKOUTS_PER_HOUR) {
      return res.status(429).json({ error: 'TOO_MANY_CHECKOUTS' });
    }
    const resolved = await resolveAccountGateway(cfg, workspaceId, input.currency, input.providerName, viewerOf(auth));
    if (!resolved) return res.status(400).json({ error: 'NO_PROVIDER_CONFIGURED' });

    const settings = await getBillingSettings(cfg);
    const vat = vatPercentFor(settings.vat_percent, input.currency);
    const charge = chargeFor(input.netMinor, vat);

    let card: Awaited<ReturnType<typeof prepareCardSetup>> | null = null;
    if (input.cardSetup) {
      // Paddle charges a card no less than its minimum (a currency without
      // one is refused by prepareCardSetup: no card in it).
      const minimum = PADDLE_MIN_CHARGE_MINOR[input.currency];
      if (minimum !== undefined && charge.total < minimum) {
        return res.status(400).json({ error: 'CARD_CHARGE_BELOW_MINIMUM', details: { minimum_minor: minimum, amount_minor: charge.total } });
      }
      card = await prepareCardSetup(cfg, workspaceId, {
        providerName: resolved.provider.name,
        purpose: input.cardSetup.purpose,
        planId: input.cardSetup.planId,
        interval: input.cardSetup.interval,
        viewer: viewerOf(auth),
      });
    }

    const payment = await createAccountPayment(cfg, {
      workspaceId,
      provider: resolved.provider.name,
      currency: input.currency,
      netMinor: charge.net,
      taxMinor: charge.tax,
      taxPercent: vat,
      purpose: input.purpose,
      purposeDetail: input.purposeDetail,
      createdBy: auth.userId,
      ...(card ? { source: 'card_setup' as const } : {}),
    });
    paymentId = payment.id;

    const apiOrigin = await resolvePublicApiOrigin(cfg.supabaseUrl, cfg.supabaseServiceRoleKey);
    const { browserReturnUrl, gatewayCallbackUrl } = returnUrls(
      input.callbackUrl,
      payment.id,
      resolved.provider.name,
      apiOrigin,
    );
    await patchAccountPayment(cfg, payment.id, { return_url: browserReturnUrl });

    const cardGateway = !isIranianGateway(resolved.provider.name);
    let result;
    try {
      result = await resolved.provider.createCheckoutSession(resolved.config, {
        workspaceId,
        planId: 'account',
        interval: 'monthly',
        currency: input.currency,
        callbackUrl: gatewayCallbackUrl,
        // Card gateways carry it in their signed custom metadata; the webhook
        // settles exactly this payment (billing.ts webhook route).
        intentId: payment.id,
        ...(cardGateway
          ? { description: input.description, customerEmail: await customerEmailOf(cfg, auth.userId) }
          : {}),
        // A card setup: the price recurs (Paddle then creates the subscription),
        // carrying what each renewal is for; an earlier card's Paddle customer
        // is reused.
        ...(card
          ? {
              recurring: card.recurring,
              priceCustomData: card.priceCustomData,
              cardSetup: true,
              ...(card.customerId ? { customerId: card.customerId } : {}),
            }
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
      currency: input.currency,
      status: 'pending',
      metadata: { paymentId: payment.id, purpose: input.purpose, ...(card ? { card_setup: true } : {}) },
    }).catch(() => undefined);

    return res.json({
      success: true,
      paymentId: payment.id,
      provider: resolved.provider.name,
      purpose: input.purpose,
      currency: input.currency,
      net_minor: charge.net,
      tax_minor: charge.tax,
      amount_minor: charge.total,
      paymentUrl: result.paymentUrl,
      clientCheckout: result.clientCheckout,
    });
  } catch (e) {
    if (paymentId) await failAccountPayment(cfg, paymentId, 'failed', 'checkout_failed').catch(() => undefined);
    return fail(res, e);
  }
}

billingAccountRouter.post('/account/:workspaceId/topup', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = topupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  if (!isAllowedBillingCallbackUrl(req, cfg, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }
  try {
    const currency = await accountCurrency(cfg, req.params.workspaceId);
    if (parsed.data.currency && parsed.data.currency.toUpperCase() !== currency) {
      return res.status(409).json({ error: 'CURRENCY_CHANGED', details: { currency } });
    }
    const problem = topupAmountProblem(parsed.data.amountMinor, currency);
    if (problem) return res.status(400).json({ error: problem });
    return startAccountCheckout(req, res, auth, {
      currency,
      netMinor: parsed.data.amountMinor,
      providerName: parsed.data.providerName,
      callbackUrl: parsed.data.callbackUrl,
      purpose: 'topup',
      description: 'Account credit',
    });
  } catch (e) {
    fail(res, e);
  }
});

// ─── Plans ─────────────────────────────────────────────────────────────────

const intervalSchema = z.enum(['monthly', 'yearly']);

billingAccountRouter.get('/account/:workspaceId/plans', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const cfg = serverConfigOf(req);
    const currency = await accountCurrency(cfg, req.params.workspaceId);
    res.json({ currency, plans: await listPlanOptions(cfg, currency) });
  } catch (e) {
    fail(res, e);
  }
});

const quoteSchema = z.object({ planId: z.string().uuid(), interval: intervalSchema.default('monthly') });

billingAccountRouter.get('/account/:workspaceId/quote', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const parsed = quoteSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    res.json(await quotePlanChange(serverConfigOf(req), req.params.workspaceId, parsed.data.planId, parsed.data.interval));
  } catch (e) {
    fail(res, e);
  }
});

/** What the page showed it would take from the balance now; a different amount now answers QUOTE_CHANGED. */
const expectedNetSchema = z.number().int().optional();

const buySchema = z.object({
  planId: z.string().uuid(),
  interval: intervalSchema,
  /** The browser's key for this click: a retried request buys once. */
  key: z.string().min(8).max(100).optional(),
  expectedNetMinor: expectedNetSchema,
});

billingAccountRouter.post('/account/:workspaceId/plan', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = buySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    await assertCardAllowsPlanChange(cfg, req.params.workspaceId);
    const result = await buyPlan(cfg, req.params.workspaceId, {
      planId: parsed.data.planId,
      interval: parsed.data.interval,
      key: `${req.params.workspaceId}:${parsed.data.key ?? crypto.randomUUID()}`,
      actorId: auth.userId,
      expectedNetMinor: parsed.data.expectedNetMinor,
    });
    await syncWorkspaceCard(cfg, req.params.workspaceId);
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

/**
 * The period the customer renews (its end, as the page showed it): a second
 * click renews nothing more. With a saved card (renewWithCard) Paddle's next
 * charge moves one period on first (or a past_due card is cancelled first),
 * so the card does not pay the period the balance pays.
 */
const renewSchema = z.object({
  expectedPeriodEnd: z.string().datetime({ offset: true }).optional(),
  /** The renewal price the page showed; another price now answers QUOTE_CHANGED. */
  expectedPriceMinor: z.number().int().positive().optional(),
});

billingAccountRouter.post('/account/:workspaceId/renew', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = renewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    // Without a card it is renewPlan itself.
    res.json(await renewWithCard(serverConfigOf(req), req.params.workspaceId, {
      actorId: auth.userId,
      expectedPeriodEnd: parsed.data.expectedPeriodEnd ?? null,
      expectedPriceMinor: parsed.data.expectedPriceMinor ?? null,
    }));
  } catch (e) {
    fail(res, e);
  }
});

const upgradeSchema = z.object({ planId: z.string().uuid(), expectedNetMinor: expectedNetSchema });

billingAccountRouter.post('/account/:workspaceId/upgrade', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = upgradeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    await assertCardAllowsPlanChange(cfg, req.params.workspaceId);
    const result = await upgradePlan(cfg, req.params.workspaceId, {
      planId: parsed.data.planId,
      actorId: auth.userId,
      expectedNetMinor: parsed.data.expectedNetMinor,
    });
    await syncWorkspaceCard(cfg, req.params.workspaceId);
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

const changeSchema = z.object({
  planId: z.string().uuid(),
  interval: intervalSchema.nullable().optional(),
  expectedNetMinor: expectedNetSchema,
});

billingAccountRouter.post('/account/:workspaceId/change', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    await assertCardAllowsPlanChange(cfg, req.params.workspaceId);
    const result = await scheduleChange(cfg, req.params.workspaceId, {
      planId: parsed.data.planId,
      interval: parsed.data.interval ?? null,
      actorId: auth.userId,
      expectedNetMinor: parsed.data.expectedNetMinor,
    });
    await syncWorkspaceCard(cfg, req.params.workspaceId);
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

const autoRenewSchema = z.object({ enabled: z.boolean() });

billingAccountRouter.put('/account/:workspaceId/auto-renew', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = autoRenewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    // With a saved card Paddle confirms first (setCardAutoRenew); the card
    // comes back as it is now (its scheduled removal, or none). Iran's
    // answer is unchanged.
    const autoRenew = await setAutoRenew(cfg, req.params.workspaceId, parsed.data.enabled);
    if (!(await cardsOffered(cfg))) return res.json({ auto_renew: autoRenew });
    res.json({ auto_renew: autoRenew, card: await cardView(cfg, req.params.workspaceId).catch(() => null) });
  } catch (e) {
    fail(res, e);
  }
});

const checkoutSchema = z.object({
  purpose: z.enum(['plan', 'renewal', 'upgrade']),
  planId: z.string().uuid().optional(),
  interval: intervalSchema.optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  providerName: z.string().min(2).max(60).optional(),
  callbackUrl: z.string().url(),
  expectedNetMinor: expectedNetSchema,
  /** Save the card and renew with it (a plan or a renewal): the full price is charged. */
  autoRenew: z.boolean().optional(),
});

/**
 * Pay online for a plan, a renewal or an upgrade: the gateway charges what
 * the balance is missing (at least the top-up minimum), the payment is
 * credited, then spent on the purpose in the same transaction.
 *
 * With autoRenew (Multi Region, a Paddle gateway): the checkout also saves
 * the card. It charges the full price of the period (a plan bought now, or
 * the next period paid early), whatever the balance, as every renewal after
 * it will; the page sends that price (expectedNetMinor). While a card is
 * saved, a renewal is the card's (CARD_PAYS_RENEWAL).
 */
billingAccountRouter.post('/account/:workspaceId/checkout', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  if (!isAllowedBillingCallbackUrl(req, cfg, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }
  const withCard = parsed.data.autoRenew === true;
  if (withCard && parsed.data.purpose !== 'plan' && parsed.data.purpose !== 'renewal') {
    return res.status(400).json({ error: 'CARD_SETUP_PURPOSE' });
  }
  if (withCard && parsed.data.expectedNetMinor === undefined) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    if (withCard && !(await cardsOffered(cfg))) return res.status(400).json({ error: 'CARD_NOT_AVAILABLE' });
    // An upgrade paid online changes what the card renews: not while it is
    // past_due or Paddle is about to charge it.
    if (parsed.data.purpose === 'upgrade') await assertCardAllowsPlanChange(cfg, req.params.workspaceId);
    const need = await amountNeededFor(cfg, req.params.workspaceId, {
      purpose: parsed.data.purpose,
      planId: parsed.data.planId,
      interval: parsed.data.interval,
      // A card checkout is priced below: the full price, not the net.
      expectedNetMinor: withCard ? undefined : parsed.data.expectedNetMinor,
      forCardSetup: withCard,
    });
    if (parsed.data.currency && parsed.data.currency.toUpperCase() !== need.currency) {
      return res.status(409).json({ error: 'CURRENCY_CHANGED', details: { currency: need.currency } });
    }
    if (withCard) {
      const full = need.periodPriceMinor;
      if (full === null || full <= 0) return res.status(400).json({ error: 'PLAN_PRICE_UNAVAILABLE' });
      if (parsed.data.expectedNetMinor !== full) {
        return res.status(409).json({ error: 'QUOTE_CHANGED', details: { price_minor: full } });
      }
      const planId = String(need.detail.plan_id ?? '');
      const interval = need.detail.billing_interval === 'yearly' ? 'yearly' : 'monthly';
      const purpose = parsed.data.purpose === 'renewal' ? 'renewal' : 'plan';
      // The gateway the card is saved on: the customer's pick, else the first that saves cards.
      const providerName = parsed.data.providerName
        ?? (await cardAvailability(cfg, req.params.workspaceId, need.currency, viewerOf(auth))).providers[0];
      // Paddle names every renewal after the plan.
      const planName = (await planNamesFor(cfg, [planId])).get(planId)?.name || 'Plan';
      return startAccountCheckout(req, res, auth, {
        currency: need.currency,
        netMinor: full,
        providerName,
        callbackUrl: parsed.data.callbackUrl,
        purpose,
        purposeDetail: need.detail,
        description: planName,
        cardSetup: { purpose, planId, interval },
      });
    }
    const shortfall = need.needed - need.balance;
    if (shortfall <= 0) return res.status(409).json({ error: 'BALANCE_SUFFICIENT' });
    const limits = TOPUP_LIMITS[need.currency];
    if (!limits) return res.status(400).json({ error: 'CURRENCY_NOT_SUPPORTED' });
    const net = Math.max(shortfall, limits.min);
    if (net > limits.max) return res.status(400).json({ error: 'TOPUP_AMOUNT_TOO_LARGE' });
    return startAccountCheckout(req, res, auth, {
      currency: need.currency,
      netMinor: net,
      providerName: parsed.data.providerName,
      callbackUrl: parsed.data.callbackUrl,
      purpose: parsed.data.purpose,
      purposeDetail: need.detail,
      description: parsed.data.purpose === 'renewal' ? 'Plan renewal' : parsed.data.purpose === 'upgrade' ? 'Plan upgrade' : 'Plan',
    });
  } catch (e) {
    fail(res, e);
  }
});

// ─── The saved card (Multi Region, phase 3b) ──────────────────────────────
// Managers only; outside the International edition CARD_NOT_AVAILABLE.
// The card itself decides the rest (card.ts): no live card → CARD_NOT_FOUND,
// past_due → CARD_PAST_DUE, Paddle about to charge → CARD_RENEWAL_IN_PROGRESS.

const cardChargeSchema = z.object({
  purpose: z.literal('upgrade'),
  planId: z.string().uuid(),
  /** The upgrade's net amount the page showed; another amount now answers QUOTE_CHANGED. */
  expectedNetMinor: z.number().int().positive(),
});

/**
 * Upgrade now, charged to the saved card: exactly the quoted difference, as
 * one Paddle charge per payment row. 200 when Paddle charged and it was
 * settled; 202 'processing' when Paddle's answer is not known yet (the
 * webhook, the verify route or the job settles it; it is never charged twice).
 */
billingAccountRouter.post('/account/:workspaceId/card/charge', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = cardChargeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    if (!(await cardsOffered(cfg))) return res.status(400).json({ error: 'CARD_NOT_AVAILABLE' });
    const result = await chargeCardForUpgrade(cfg, req.params.workspaceId, {
      planId: parsed.data.planId,
      expectedNetMinor: parsed.data.expectedNetMinor,
      actorId: auth.userId,
    });
    if (result.status === 'processing') return res.status(202).json({ status: 'processing', paymentId: result.paymentId });
    res.json({ status: 'succeeded', paymentId: result.paymentId, purpose_result: result.purposeResult ?? null });
  } catch (e) {
    fail(res, e);
  }
});

const cardUpdateSchema = z.object({ callbackUrl: z.string().url() });

/**
 * Change the card (and, while a renewal failed, pay it with the new one):
 * Paddle's update-payment-method transaction, opened with Paddle.js. The
 * card's new details arrive with Paddle's events.
 */
billingAccountRouter.post('/account/:workspaceId/card/update', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = cardUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  if (!isAllowedBillingCallbackUrl(req, cfg, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }
  try {
    if (!(await cardsOffered(cfg))) return res.status(400).json({ error: 'CARD_NOT_AVAILABLE' });
    // Paddle already has the customer's e-mail: none is prefilled.
    res.json(await cardUpdateCheckout(cfg, req.params.workspaceId, { successUrl: parsed.data.callbackUrl }));
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Remove the saved card: cancelled at Paddle first, then here (auto-renew
 * goes off). The plan runs to the end of its period; a next period already
 * paid stays paid.
 */
billingAccountRouter.delete('/account/:workspaceId/card', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  try {
    const cfg = serverConfigOf(req);
    if (!(await cardsOffered(cfg))) return res.status(400).json({ error: 'CARD_NOT_AVAILABLE' });
    res.json(await removeCard(cfg, req.params.workspaceId));
  } catch (e) {
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
    // An unpaid checkout past its window is ended, so it stops showing as
    // pending. A charge on a saved card has no checkout: Paddle may have
    // taken it, so it is only ever resolved by looking it up (card.ts).
    if (outcome.status === 'pending' && payment.status === 'pending' && !payment.verified_at
        && isCheckoutPayment(payment) && isAccountPaymentLapsed(payment)) {
      await expireAccountPayment(cfg, payment, resolved.config);
      return res.json({ status: 'failed', reason: 'expired' });
    }
    res.json(outcome);
  } catch (e) {
    fail(res, e);
  }
});

/** The app origins this server itself knows (configuration, platform domains), never a request's. */
async function trustedReturnOrigins(cfg: ReturnType<typeof serverConfigOf>): Promise<Set<string>> {
  const origins = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    try {
      origins.add(new URL(raw.trim()).origin.toLowerCase());
    } catch {
      /* not a URL */
    }
  };
  for (const origin of allowedOrigins(cfg)) add(origin);
  add(process.env.PUBLIC_APP_URL);
  add(process.env.APP_URL);
  add(await resolveAppBaseUrl(cfg).catch(() => ''));
  return origins;
}

// ─── Gateway callback hop for a non-https app origin ─────────────────────
// Forwards the gateway's result to the exact return URL stored on the
// payment at checkout. Never answers with data; only an allow-listed page.
billingAccountRouter.get('/account-return', async (req, res) => {
  try {
    const paymentId = typeof req.query.payment === 'string' ? req.query.payment : '';
    const providerName = typeof req.query.provider === 'string' ? req.query.provider : '';
    const cfg = serverConfigOf(req);
    const payment = paymentId ? await readAccountPayment(cfg, paymentId) : null;
    if (!payment || payment.provider !== providerName || !payment.return_url) {
      return res.status(400).type('text/plain').send('Invalid payment return.');
    }
    const destination = new URL(payment.return_url);
    // Only to this platform's own app: never to an origin a request supplied.
    if (!(await trustedReturnOrigins(cfg)).has(destination.origin.toLowerCase())) {
      return res.status(400).type('text/plain').send('Invalid payment return.');
    }
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
