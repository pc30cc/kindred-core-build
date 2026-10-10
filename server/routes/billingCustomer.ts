// ============================================================================
// UNIFIED BILLING — CUSTOMER (WORKSPACE) SURFACE
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
import type { ServerConfig } from '../config.js';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { resolveBillingConfig, resolveNamedBillingConfig, logBillingEvent } from '../services/billing/index.js';
import {
  buildBillingOverview,
  listInvoices,
  getInvoiceDetail,
  buildWalletView,
  listTransactions,
  invoiceCurrency,
  WALLET_CURRENCY,
  INVOICE_FILTERS,
  type InvoiceFilter,
} from '../services/billing/customer/readModels.js';
import {
  previewPlanChange,
  applyPlanChange,
  cancelPendingPlanChange,
  setWalletAutoPay,
  issueAiCreditPurchase,
  issueWalletDepositPurchase,
  billingCurrencyOf,
  planPriceInCurrency,
  BillingActionError,
} from '../services/billing/customer/actions.js';
import {
  canCollectInvoice,
  closeSupersededCheckouts,
  collectionDependsOnAccount,
  isCardInvoiceProvider,
  openCheckoutAttempts,
  CARD_COLLECTION_TTL_SECONDS,
  CARD_INTENT_TTL_MS,
} from '../services/billing/cardInvoice.js';
import {
  settleInvoiceFromWallet,
  applyInvoiceEffects,
  beginCollection,
  releaseCollection,
  getInvoice,
  InvoiceSettlementError,
} from '../services/billing/invoice/settle.js';
import { createWalletDeposit, type WalletDepositRow } from '../services/billing/wallet/index.js';
import type { PurchaseActionType } from '../services/billing/periods.js';
import {
  createInvoiceIntent,
  createWalletDepositIntent,
  setPaymentIntentProviderRef,
  markPaymentIntentFailed,
  IRAN_PROVIDERS,
} from '../services/billing/paymentIntent.js';
import { requiresReferenceBinding } from '../services/billing/providerBinding.js';
import {
  BillingConfigError,
  evaluateCoupon,
  listPayableGateways,
} from '../services/billing/config/index.js';
import { isAllowedBillingCallbackUrl, resolvePublicApiOrigin } from '../services/billing/callbackUrl.js';
import { readTopupConfig } from '../services/billing/topupConfig.js';
import {
  assertEditionFeature,
  assertProviderAllowed,
  assertCurrencyAllowed,
  editionErrorResponse,
  getBillingRegion,
  type Edition,
} from '../services/billing/edition.js';
import {
  REGION_CURRENCY,
  currencyForEditionRegion,
  isCurrencyAllowedInEdition,
  regionPinsCurrency,
  type RegionMode,
} from '../../shared/edition.js';
import { PADDLE_SANDBOX_PROVIDER } from '../../shared/testGateways.js';
import { paddleSandboxOpenToCustomers } from '../services/billing/providers/paddle-sandbox.js';


export const billingCustomerRouter = Router();

/** The part of an Express response the error mapper writes to. */
type JsonResponse = { status(code: number): { json(body: unknown): unknown } };

/** The `billing_plans` fields the plans tab reads; legacy rows may lack some. */
interface CatalogPlanRow {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  is_hidden?: boolean | null;
  /** `{ CURRENCY: { monthly, yearly } }` — minor units, whole Rial for IRR. */
  prices?: Record<string, { monthly?: unknown; yearly?: unknown } | null | undefined> | null;
  price_monthly?: unknown;
  price_yearly?: unknown;
  limits?: Record<string, unknown> | null;
  entitlements?: Record<string, unknown> | null;
  features?: unknown;
}

/** The `workspace_subscriptions` columns the plans tab selects. */
interface PlanTabSubscriptionRow {
  plan_id: string | null;
  billing_interval: string | null;
  pending_change_type: string | null;
  next_plan_id: string | null;
}

function fail(res: JsonResponse, e: unknown) {
  const editionError = editionErrorResponse(e);
  if (editionError) return res.status(editionError.status).json(editionError.body);
  if (e instanceof BillingActionError) {
    return res.status(e.status).json({ error: e.code, message: e.message, details: e.details ?? null });
  }
  if (e instanceof InvoiceSettlementError) {
    return res.status(e.status || 409).json({ error: e.code || 'SETTLEMENT_FAILED' });
  }
  const message = e instanceof Error ? e.message : 'unexpected_error';
  return res.status(500).json({ error: 'INTERNAL_ERROR', message });
}

/** A gateway refused to open a checkout; carries the gateway's own message. */
class CheckoutProviderError extends Error {
  readonly provider: string;
  readonly providerMessage: string;
  constructor(provider: string, cause: unknown) {
    const message = (cause instanceof Error ? cause.message : String(cause || '')).trim() || 'checkout failed';
    super(message);
    this.name = 'CheckoutProviderError';
    this.provider = provider;
    this.providerMessage = message.slice(0, 300);
  }
}

function pageParams(req: { query: Record<string, unknown> }) {
  return {
    page: Number(req.query.page ?? 1) || 1,
    pageSize: Number(req.query.pageSize ?? 10) || 10,
  };
}

function isManage(auth: { isAdmin: boolean; role: string | null } | null): boolean {
  if (!auth) return false;
  return auth.isAdmin || ['owner', 'admin'].includes(String(auth.role || ''));
}

/** Who lists or pays with the gateways: a test gateway may be open to platform admins only. */
type GatewayViewer = { isPlatformAdmin: boolean };

function viewerOf(auth: { isAdmin: boolean }): GatewayViewer {
  return { isPlatformAdmin: auth.isAdmin };
}

/**
 * The Paddle sandbox accepts Paddle's test cards, which would buy a real plan
 * for nothing: only platform admins see and use it, unless its settings open
 * it to every customer (`open_to_customers`, Super Admin → Providers).
 */
async function testGatewayOpenTo(
  cfg: ServerConfig,
  workspaceId: string,
  providerName: string,
  viewer: GatewayViewer,
): Promise<boolean> {
  if (providerName !== PADDLE_SANDBOX_PROVIDER || viewer.isPlatformAdmin) return true;
  const resolved = await resolveNamedBillingConfig(
    cfg.supabaseUrl,
    cfg.supabaseServiceRoleKey,
    workspaceId,
    providerName,
  ).catch(() => null);
  return Boolean(resolved && paddleSandboxOpenToCustomers(resolved.config));
}

/**
 * Active gateways that can collect a document in `currency`: enabled in
 * Finance → Gateways for it AND able to collect an invoice in it (Iranian
 * gateways IRR; card gateways the currencies they charge — for a gateway
 * whose account fixes the currency, like a Lemon Squeezy store, the one its
 * configured account charges).
 */
async function invoiceGateways(cfg: ServerConfig, workspaceId: string, currency: string, viewer: GatewayViewer) {
  const gateways = await listPayableGateways(cfg, currency);
  const collects = await Promise.all(
    gateways.map(async (g) => {
      if (!canCollectInvoice(g.provider_name, currency)) return false;
      if (!(await testGatewayOpenTo(cfg, workspaceId, g.provider_name, viewer))) return false;
      if (!collectionDependsOnAccount(g.provider_name)) return true;
      const resolved = await resolveNamedBillingConfig(
        cfg.supabaseUrl,
        cfg.supabaseServiceRoleKey,
        workspaceId,
        g.provider_name,
      ).catch(() => null);
      return Boolean(resolved && canCollectInvoice(g.provider_name, currency, resolved.config));
    }),
  );
  return gateways.filter((_g, i) => collects[i]);
}

/**
 * Which gateway actually runs this checkout.
 *
 * When the customer picked one of the ACTIVE gateways we honour that choice —
 * but only after re-validating it against the payable list on the server, so a
 * crafted request cannot reach a disabled or unimplemented provider. With no
 * explicit choice we fall back to the configured default resolution, and to
 * the first payable gateway when the default cannot take this currency.
 */
async function resolveCheckoutProvider(
  cfg: ServerConfig,
  workspaceId: string,
  providerName: string | null | undefined,
  currency: string,
  viewer: GatewayViewer,
) {
  const gateways = await invoiceGateways(cfg, workspaceId, currency, viewer);
  if (providerName) {
    const gateway = gateways.find((g) => g.provider_name === providerName);
    if (!gateway) return null;
    return resolveNamedBillingConfig(
      cfg.supabaseUrl,
      cfg.supabaseServiceRoleKey,
      workspaceId,
      gateway.provider_name,
    );
  }
  const configured = await resolveBillingConfig(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, workspaceId);
  // A platform default this customer may not use (the admin-only sandbox) is no default for them.
  const fallback =
    configured && (await testGatewayOpenTo(cfg, workspaceId, configured.provider.name, viewer)) ? configured : null;
  if (fallback && canCollectInvoice(fallback.provider.name, currency, fallback.config)) return fallback;
  if (gateways.length === 0) return fallback;
  return resolveNamedBillingConfig(
    cfg.supabaseUrl,
    cfg.supabaseServiceRoleKey,
    workspaceId,
    gateways[0].provider_name,
  );
}

/** What the customer is buying, as the card provider's checkout page shows it. */
function checkoutDescription(invoice: {
  plan_name_snapshot?: string | null;
  billing_interval?: string | null;
  invoice_type?: string | null;
  invoice_number: string;
}): string {
  const what = invoice.plan_name_snapshot
    ? `${invoice.plan_name_snapshot}${invoice.billing_interval === 'yearly' ? ' (yearly)' : invoice.billing_interval === 'monthly' ? ' (monthly)' : ''}`
    : invoice.invoice_type === 'ai_credit_purchase'
      ? 'AI credit'
      : 'Subscription';
  return `${what} — invoice ${invoice.invoice_number}`;
}

/** The signed-in customer's e-mail, prefilled on the card provider's checkout. */
async function customerEmailOf(cfg: ServerConfig, userId: string): Promise<string | undefined> {
  const { data } = await getServiceClient(cfg).from('profiles').select('email').eq('id', userId).maybeSingle();
  const email = (data as { email?: string | null } | null)?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}


/** Payment methods the customer may actually use for a given currency. */
billingCustomerRouter.get('/workspaces/:workspaceId/gateways', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    const cfg = serverConfigOf(req);
    const currency = billingCurrencyOf(req.query.currency, (await getBillingRegion(cfg)).currency);
    const gateways = await invoiceGateways(cfg, req.params.workspaceId, currency, viewerOf(auth));
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
billingCustomerRouter.post('/workspaces/:workspaceId/coupons/validate', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  if (!isManage(auth)) return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    const { edition, currency: regionCurrency } = await getBillingRegion(serverConfigOf(req));
    const body = z
      .object({
        code: z.string().min(2).max(40),
        currency: z.string().length(3).default(regionCurrency),
        subtotalMinor: z.number().int().nonnegative(),
        planId: z.string().uuid().nullish(),
      })
      .parse(req.body);
    assertCurrencyAllowed(edition, body.currency);
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


billingCustomerRouter.get('/workspaces/:workspaceId/overview', async (req, res) => {
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

billingCustomerRouter.get('/workspaces/:workspaceId/invoices', async (req, res) => {
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

billingCustomerRouter.get('/workspaces/:workspaceId/invoices/:invoiceId', async (req, res) => {
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
billingCustomerRouter.post('/workspaces/:workspaceId/invoices/:invoiceId/pay-wallet', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const invoiceId = req.params.invoiceId;

  try {
    // The Rial wallet exists in the Iranian edition only.
    await assertEditionFeature(cfg, 'wallet');
    const invoice = await getInvoice(cfg, invoiceId);
    if (!invoice || invoice.workspace_id !== workspaceId) return res.status(404).json({ error: 'NOT_FOUND' });
    // The wallet holds Rial. Debiting it by a USD invoice's cents would pay a
    // $29 invoice with 2,900 Rial.
    if (invoiceCurrency(invoice) !== WALLET_CURRENCY) {
      return res.status(409).json({ error: 'WALLET_CURRENCY_MISMATCH' });
    }

    const settlement = await settleInvoiceFromWallet(cfg, { invoiceId, actorId: auth.userId });
    let application: unknown = null;
    if (settlement.status === 'paid') {
      application = await applyInvoiceEffects(cfg, invoiceId);
    }
    res.json({ success: true, settlement, application });
  } catch (e) {
    fail(res, e);
  }
});

const checkoutSchema = z.object({
  callbackUrl: z.string().url(),
  providerName: z.string().min(2).max(60).optional(),
});

/**
 * The bank returns the customer STRAIGHT to the payment document page on the
 * app origin — no `/api/...` hop in the address bar. The app origin is a
 * plain SPA host, so this works in a split app/API deployment too (the app
 * host does not need to proxy `/api/*`).
 *
 * `/api/billing/return` on the API origin stays alive as a compatibility
 * redirect for sessions/gateways that were configured with the old callback;
 * `apiOrigin` is still resolved server-side and used as the fallback when the
 * caller-supplied return URL is unusable.
 */
export function paymentReturnUrls(browserUrl: string, intentId: string, providerName: string, apiOrigin: string) {
  const browserReturn = new URL(browserUrl);
  browserReturn.searchParams.set('intent', intentId);
  browserReturn.searchParams.set('provider', providerName);

  let gatewayCallback = browserReturn.toString();
  if (browserReturn.protocol !== 'https:' && browserReturn.hostname !== 'localhost' && browserReturn.hostname !== '127.0.0.1') {
    const fallback = new URL('/api/billing/return', apiOrigin);
    fallback.searchParams.set('intent', intentId);
    fallback.searchParams.set('provider', providerName);
    gatewayCallback = fallback.toString();
  }

  return {
    browserReturnUrl: browserReturn.toString(),
    gatewayCallbackUrl: gatewayCallback,
  };
}


/** Start a gateway collection for an open invoice. */
billingCustomerRouter.post('/workspaces/:workspaceId/invoices/:invoiceId/checkout', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });

  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const invoiceId = req.params.invoiceId;
  if (!isAllowedBillingCallbackUrl(req, cfg, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }

  let hold: { collection_id: string } | null = null;
  let intentId: string | null = null;
  try {
    const invoice = await getInvoice(cfg, invoiceId);
    if (!invoice || invoice.workspace_id !== workspaceId) return res.status(404).json({ error: 'NOT_FOUND' });
    const due = Number(invoice.amount_due_irr ?? 0);
    if (!['open', 'partially_paid', 'past_due'].includes(invoice.status) || due <= 0) {
      return res.status(409).json({ error: 'INVOICE_NOT_PAYABLE' });
    }

    // The invoice fixed the currency when it was issued; the gateway must be
    // able to collect exactly that (an invoice is never re-priced here). In
    // the International edition neither a Rial invoice nor an Iranian
    // gateway can be collected.
    const { edition, currency: regionCurrency } = await getBillingRegion(cfg);
    const currency = invoiceCurrency(invoice, regionCurrency);
    assertCurrencyAllowed(edition, currency);
    assertProviderAllowed(edition, parsed.data.providerName);
    const resolved = await resolveCheckoutProvider(cfg, workspaceId, parsed.data.providerName, currency, viewerOf(auth));
    if (!resolved) return res.status(400).json({ error: 'NO_PROVIDER_CONFIGURED' });
    if (!canCollectInvoice(resolved.provider.name, currency, resolved.config)) {
      return res.status(400).json({ error: 'PROVIDER_NOT_SUPPORTED' });
    }
    const card = isCardInvoiceProvider(resolved.provider.name);

    // Checkouts this one will supersede: once it holds the invoice, theirs
    // are closed at the provider where possible (best effort, below).
    const superseded = await openCheckoutAttempts(cfg, invoiceId).catch(() => [] as string[]);

    // Create the attempt first, then bind the reservation to it. The former
    // order created an unowned 15-minute lock whenever execution stopped
    // between these two writes.
    const intent = await createInvoiceIntent(cfg, {
      workspaceId,
      invoiceId,
      amountIrr: due,
      providerName: resolved.provider.name,
      planId: invoice.plan_id ?? null,
      interval: invoice.billing_interval ?? null,
      // The frozen effect may name the invoice act ('ai_credit_purchase');
      // createInvoiceIntent maps it onto the purchase vocabulary.
      actionType: (invoice.effect_snapshot?.action_type as PurchaseActionType) ?? null,
      planNameSnapshot: invoice.plan_name_snapshot ?? null,
      invoiceNumber: invoice.invoice_number,
      currency,
      ...(card ? { ttlMs: CARD_INTENT_TTL_MS } : {}),
      metadata: { origin: 'customer_invoice_checkout' },
    });
    intentId = intent.id;

    // Exclusive collection: wallet auto-pay and another browser tab must not
    // collect this invoice simultaneously. The database automatically clears
    // reservations whose linked attempt is terminal.
    hold = await beginCollection(cfg, {
      invoiceId,
      channel: 'gateway',
      amountIrr: due,
      commandKey: `customer_checkout:${intent.id}`,
      paymentIntentId: intent.id,
      ttlSeconds: card ? CARD_COLLECTION_TTL_SECONDS : 900,
    });
    // Never delays or fails this checkout; a checkout left open is still
    // settled or recorded for review if it is paid (cardInvoice.ts).
    void closeSupersededCheckouts(cfg, workspaceId, superseded).catch(() => undefined);

    const apiOrigin = await resolvePublicApiOrigin(cfg.supabaseUrl, cfg.supabaseServiceRoleKey);
    const { browserReturnUrl, gatewayCallbackUrl } = paymentReturnUrls(
      parsed.data.callbackUrl,
      intent.id,
      resolved.provider.name,
      apiOrigin,
    );

    // Persist the browser return before leaving this server. If a gateway (or
    // proxy in front of it) sends the customer to our API callback instead of
    // the SPA URL, the callback can still finish and redirect to this exact,
    // allow-listed destination rather than exposing JSON in the browser.
    const sb = getServiceClient(cfg);
    const { error: returnUrlError } = await sb
      .from('billing_payment_intents')
      .update({
        metadata: {
          ...((intent.metadata as Record<string, unknown>) || {}),
          return_url: browserReturnUrl,
        },
      })
      .eq('id', intent.id);
    if (returnUrlError) throw new Error(`checkout return URL write failed: ${returnUrlError.message}`);

    // `amount` is the invoice due in minor units of `currency` (Rial for IRR).
    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId,
      planId: invoice.plan_id || 'invoice',
      interval: invoice.billing_interval || 'monthly',
      currency,
      callbackUrl: gatewayCallbackUrl,
      intentId: intent.id,
      invoiceId,
      ...(card
        ? { description: checkoutDescription(invoice), customerEmail: await customerEmailOf(cfg, auth.userId) }
        : {}),
      metadata: { amount: String(due), invoiceId },
    }).catch((providerError: unknown) => {
      throw new CheckoutProviderError(resolved.provider.name, providerError);
    });

    // Fail-closed reference binding: an unbound intent must never be reported
    // as a live checkout — the callback could otherwise accept any payment.
    const ref = result.providerRef || result.authority || result.sessionId || '';
    const bindingRequired = requiresReferenceBinding(resolved.provider.name);
    if (bindingRequired || ref) {
      try {
        await setPaymentIntentProviderRef(cfg, intent.id, ref);
      } catch (bindError) {
        await markPaymentIntentFailed(
          cfg,
          intent.id,
          String((bindError as { message?: string })?.message || 'binding_failed'),
        );
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
      currency,
      status: 'pending',
      metadata: { invoiceId, intentId: intent.id },
    });

    res.json({ success: true, ...result, intentId: intent.id, invoiceNumber: invoice.invoice_number });
  } catch (e) {
    if (hold) {
      await releaseCollection(serverConfigOf(req), hold.collection_id, 'checkout_failed').catch(
        () => undefined,
      );
    }
    if (intentId) {
      const reason = e instanceof CheckoutProviderError ? `checkout_failed: ${e.providerMessage}`.slice(0, 500) : 'checkout_failed';
      await markPaymentIntentFailed(serverConfigOf(req), intentId, reason).catch(
        () => undefined,
      );
    }
    if (e instanceof CheckoutProviderError) {
      // The gateway's own reason (e.g. Paddle's "checkout url domain is not
      // approved"), so whoever manages billing sees why and can fix it.
      console.warn(`[billing-checkout] provider=${e.provider} refused: ${e.providerMessage}`);
      return res.status(502).json({
        error: 'CHECKOUT_PROVIDER_ERROR',
        message: e.providerMessage,
        details: { provider: e.provider, providerMessage: e.providerMessage },
      });
    }
    fail(res, e);
  }
});

// ─── Plans / plan change ───────────────────────────────────────────────────

billingCustomerRouter.get('/workspaces/:workspaceId/plans', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const cfg = serverConfigOf(req);
  const sb = getServiceClient(cfg);
  try {
    const [plansRes, subRes] = await Promise.all([
      sb.from('billing_plans').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
      sb
        .from('workspace_subscriptions')
        .select('plan_id, billing_interval, pending_change_type, next_plan_id')
        .eq('workspace_id', req.params.workspaceId)
        .maybeSingle(),
    ]);
    if (plansRes.error) throw new Error(`billing plans read failed: ${plansRes.error.message}`);
    if (subRes.error) throw new Error(`billing subscription read failed: ${subRes.error.message}`);
    const plans = plansRes.data as CatalogPlanRow[] | null;
    const sub = subRes.data as PlanTabSubscriptionRow | null;

    // The plans tab is an upgrade catalogue: it lists only the paid plans a
    // customer can move to. Hidden plans stay admin-only, and the free/trial
    // tiers are never offered here — a trial or free workspace sees the paid
    // plans it can upgrade to, and its current tier is reported by the
    // overview tab instead.
    const currentPlanId = sub?.plan_id ?? null;
    const catalog = (plans || []).filter((p) => p.is_hidden !== true && p.slug !== 'trial' && p.slug !== 'free');

    // Every plan is priced per currency. The catalogue is shown in ONE
    // currency the customer can actually pay in: a visible plan is priced in
    // it and an active gateway can collect an invoice in it.
    // The International edition never offers Rial (its legacy flat price
    // columns included); the Iranian edition is unchanged. The region's own
    // currency (IRR / TRY / USD) is always a candidate; Multi Region and
    // Global offer only USD (plus the currency the running paid period was
    // bought in, so that customer can still upgrade in it).
    const { edition, regionMode } = await getBillingRegion(cfg);
    const regionCurrency = currencyForEditionRegion(edition, regionMode);
    const subscriptionCurrency = await paidSubscriptionCurrency(cfg, req.params.workspaceId);
    const candidates = new Set<string>([regionCurrency]);
    for (const p of catalog) {
      for (const code of Object.keys(p.prices ?? {})) {
        if (/^[A-Za-z]{3}$/.test(code)) candidates.add(code.toUpperCase());
      }
    }
    const sellable = [...candidates].filter(
      (c) =>
        isCurrencyAllowedInEdition(c, edition) &&
        catalogOffersCurrency(c, { edition, regionMode, subscription: subscriptionCurrency }) &&
        catalog.some((p) => planSellsIn(p, c)),
    );
    const collectable = await Promise.all(
      sellable.map(async (c) => (await invoiceGateways(cfg, req.params.workspaceId, c, viewerOf(auth))).length > 0),
    );
    const currencies = sellable.filter((_c, i) => collectable[i]);
    const currency = pickCatalogCurrency(currencies, {
      requested: typeof req.query.currency === 'string' ? req.query.currency : null,
      subscription: subscriptionCurrency,
      locale: typeof req.query.locale === 'string' ? req.query.locale : null,
      edition,
      regionMode,
    });
    const visiblePlans = catalog.filter((p) => planSellsIn(p, currency));

    res.json({
      currentPlanId,
      currentInterval: sub?.billing_interval ?? null,
      pendingPlanId: sub?.next_plan_id ?? null,
      currency,
      currencies,
      plans: visiblePlans.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        // Minor units of `currency` (whole Rial for IRR); the field names are historic.
        monthlyPriceIrr: catalogPrice(p, currency, 'monthly'),
        yearlyPriceIrr: catalogPrice(p, currency, 'yearly'),
        currency,
        aiMonthlyAllowanceIrr: Math.round(Number(p.limits?.ai_credits_per_month ?? 0)) || 0,
        limits: p.limits ?? {},
        entitlements: p.entitlements ?? {},
        features: p.features ?? [],
        isFree: !planSellsIn(p, currency),
      })),
    });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * A catalogue price, minor units of `currency`; 0 when the plan is not sold
 * in it at that interval. The same rule as the plan change that charges it
 * (planPriceInCurrency): a plan with a price map is sold only at a positive
 * price set in that currency; only a plan with no price map at all reads the
 * legacy flat columns, for IRR.
 */
function catalogPrice(p: CatalogPlanRow, currency: string, interval: 'monthly' | 'yearly'): number {
  return Math.max(0, planPriceInCurrency(p, interval, currency) ?? 0) || 0;
}

function planSellsIn(p: CatalogPlanRow, currency: string): boolean {
  return catalogPrice(p, currency, 'monthly') > 0 || catalogPrice(p, currency, 'yearly') > 0;
}

/**
 * May the catalogue offer `currency` in this region? Multi Region and Global
 * show and charge USD for every language: only the region's currency and the
 * currency a running paid period was bought in. The Iranian and Turkish
 * regions offer every currency their edition allows (as before).
 */
export function catalogOffersCurrency(
  currency: string,
  ctx: { edition: Edition; regionMode?: RegionMode | null; subscription?: string | null },
): boolean {
  const code = currency.trim().toUpperCase();
  if (ctx.edition === 'iran' || !regionPinsCurrency(ctx.regionMode ?? 'multi')) return true;
  return code === currencyForEditionRegion(ctx.edition, ctx.regionMode ?? 'multi') || code === ctx.subscription;
}

/**
 * The currency the catalogue opens in when the customer chose none: the
 * region's (shared/edition.ts editionCurrencyFor). The UI language never
 * picks it: Persian means Toman only in the Iranian edition (whose only
 * language it is), Turkish means Lira only on a Turkish-only site; in Multi
 * Region and Global every language reads USD.
 */
function regionDefaultCurrency(edition: Edition, regionMode: RegionMode | null | undefined, locale: string | null): string {
  // The Iranian edition keeps its rule exactly as before: Rial for Persian
  // (its only language), the old per-language pick otherwise.
  if (edition === 'iran') return locale === 'fa' ? 'IRR' : locale === 'tr' ? 'TRY' : 'USD';
  return regionMode ? currencyForEditionRegion(edition, regionMode) : REGION_CURRENCY.multi;
}

/**
 * The catalogue currency: the customer's explicit choice, else the currency
 * their running paid period was bought in (an upgrade stays in it), else the
 * region's (Rial in Iran, Lira in Turkey, USD in Multi Region / Global), else
 * whatever can be paid at all. `edition` defaults to the Iranian one, whose
 * rule this was before editions existed.
 */
export function pickCatalogCurrency(
  currencies: string[],
  prefs: {
    requested?: string | null;
    subscription?: string | null;
    locale?: string | null;
    edition?: Edition;
    regionMode?: RegionMode | null;
  },
): string {
  const edition = prefs.edition ?? 'iran';
  const fallback = prefs.regionMode
    ? currencyForEditionRegion(edition, prefs.regionMode)
    : edition === 'iran'
      ? 'IRR'
      : REGION_CURRENCY.multi;
  const requested = prefs.requested ? billingCurrencyOf(prefs.requested, fallback) : null;
  for (const code of [requested, prefs.subscription, regionDefaultCurrency(edition, prefs.regionMode, prefs.locale ?? null), fallback]) {
    if (code && currencies.includes(code)) return code;
  }
  return currencies[0] ?? requested ?? fallback;
}

/** Currency of the invoice that bought the workspace's active service period, if any. */
async function paidSubscriptionCurrency(cfg: ServerConfig, workspaceId: string): Promise<string | null> {
  const sb = getServiceClient(cfg);
  const { data: period } = await sb
    .from('billing_subscription_periods')
    .select('invoice_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .maybeSingle();
  const invoiceId = (period as { invoice_id?: string | null } | null)?.invoice_id;
  if (!invoiceId) return null;
  const { data: invoice } = await sb.from('billing_invoices').select('currency').eq('id', invoiceId).maybeSingle();
  return invoice ? invoiceCurrency(invoice as { currency?: unknown }) : null;
}

const planChangeSchema = z.object({
  planId: z.string().uuid(),
  interval: z.enum(['monthly', 'yearly']),
  mode: z.enum(['immediate', 'next_cycle']),
  /** Currency the catalogue was shown in (ISO 4217); IRR when absent. */
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
});

billingCustomerRouter.post('/workspaces/:workspaceId/plan-change/preview', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = planChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const { planId, interval, mode, currency } = parsed.data;
    res.json(await previewPlanChange(serverConfigOf(req), req.params.workspaceId, { planId, interval, mode, currency }));
  } catch (e) {
    fail(res, e);
  }
});

billingCustomerRouter.post('/workspaces/:workspaceId/plan-change', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = planChangeSchema.extend({ expectedAmountIrr: z.number().int().min(0) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const { planId, interval, mode, expectedAmountIrr, currency } = parsed.data;
    res.json(
      await applyPlanChange(serverConfigOf(req), req.params.workspaceId, {
        planId,
        interval,
        mode,
        expectedAmountIrr,
        currency,
      }),
    );
  } catch (e) {
    fail(res, e);
  }
});

billingCustomerRouter.post('/workspaces/:workspaceId/plan-change/cancel', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  try {
    res.json(await cancelPendingPlanChange(serverConfigOf(req), req.params.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});

// ─── Wallet ────────────────────────────────────────────────────────────────

billingCustomerRouter.get('/workspaces/:workspaceId/wallet', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    await assertEditionFeature(serverConfigOf(req), 'wallet');
    res.json(await buildWalletView(serverConfigOf(req), req.params.workspaceId, pageParams(req)));
  } catch (e) {
    fail(res, e);
  }
});

billingCustomerRouter.put('/workspaces/:workspaceId/wallet/auto-pay', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    await assertEditionFeature(serverConfigOf(req), 'wallet');
    res.json(await setWalletAutoPay(serverConfigOf(req), req.params.workspaceId, parsed.data.enabled));
  } catch (e) {
    fail(res, e);
  }
});

const depositSchema = z.object({ amountIrr: z.number().int().positive() });

/**
 * Wallet top-up as an INVOICE — identical to a plan purchase or an AI credit
 * purchase. Amount bounds come from server policy, so a hand-crafted request
 * cannot deposit an out-of-policy amount.
 */
billingCustomerRouter.post('/workspaces/:workspaceId/wallet/deposit/invoice', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    await assertEditionFeature(cfg, 'wallet');
    const view = await buildWalletView(cfg, req.params.workspaceId, { page: 1, pageSize: 5 });
    const { minIrr, maxIrr, allowCustom, presetsIrr } = view.deposit;
    const amount = parsed.data.amountIrr;
    if (!allowCustom && !presetsIrr.includes(amount)) {
      return res.status(400).json({ error: 'AMOUNT_NOT_ALLOWED' });
    }
    const invoice = await issueWalletDepositPurchase(cfg, req.params.workspaceId, amount, {
      minIrr,
      maxIrr,
    });
    res.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amountIrr: Number(invoice.amount_due_irr),
    });
  } catch (e) {
    fail(res, e);
  }
});


/**
 * Deposit receipt shown BEFORE the bank. Amount bounds come from server policy,
 * so a hand-crafted request cannot deposit an out-of-policy amount.
 */
billingCustomerRouter.post('/workspaces/:workspaceId/wallet/deposit/preview', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    await assertEditionFeature(cfg, 'wallet');
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

/** A single deposit proforma — the document the customer pays on its own page. */
billingCustomerRouter.get('/workspaces/:workspaceId/wallet/deposits/:depositId', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const cfg = serverConfigOf(req);
  try {
    await assertEditionFeature(cfg, 'wallet');
    const sb = getServiceClient(cfg);
    const { data: deposit } = await sb
      .from('billing_wallet_deposits')
      .select('*')
      .eq('id', req.params.depositId)
      .eq('workspace_id', req.params.workspaceId)
      .maybeSingle<WalletDepositRow>();
    if (!deposit) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({
      deposit: {
        id: deposit.id,
        documentNumber: deposit.document_number,
        documentType: 'wallet_deposit',
        amountIrr: Number(deposit.amount_irr),
        status: deposit.status,
        createdAt: deposit.created_at,
      },
    });
  } catch (e) {
    fail(res, e);
  }
});



billingCustomerRouter.post('/workspaces/:workspaceId/wallet/deposit/checkout', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = z
    .object({
      depositId: z.string().uuid(),
      callbackUrl: z.string().url(),
      providerName: z.string().min(2).max(60).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  if (!isAllowedBillingCallbackUrl(req, cfg, parsed.data.callbackUrl)) {
    return res.status(400).json({ error: 'INVALID_CALLBACK_URL' });
  }

  try {
    await assertEditionFeature(cfg, 'wallet');
    const sb = getServiceClient(cfg);
    const { data: deposit } = await sb
      .from('billing_wallet_deposits')
      .select('*')
      .eq('id', parsed.data.depositId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<WalletDepositRow>();
    if (!deposit) return res.status(404).json({ error: 'NOT_FOUND' });
    if (deposit.status !== 'pending') return res.status(409).json({ error: 'DEPOSIT_NOT_PENDING' });

    // A wallet deposit is Rial: only an Iranian gateway can collect it.
    const resolved = await resolveCheckoutProvider(cfg, workspaceId, parsed.data.providerName, WALLET_CURRENCY, viewerOf(auth));
    if (!resolved) return res.status(400).json({ error: 'NO_PROVIDER_CONFIGURED' });
    if (!IRAN_PROVIDERS.has(resolved.provider.name)) return res.status(400).json({ error: 'PROVIDER_NOT_SUPPORTED' });

    const amount = Number(deposit.amount_irr);
    const intent = await createWalletDepositIntent(cfg, {
      workspaceId,
      depositId: deposit.id,
      documentNumber: deposit.document_number,
      amountIrr: amount,
      providerName: resolved.provider.name,
      metadata: { origin: 'customer_wallet_deposit' },
    });
    await sb
      .from('billing_wallet_deposits')
      .update({ payment_intent_id: intent.id })
      .eq('id', deposit.id);

    const apiOrigin = await resolvePublicApiOrigin(cfg.supabaseUrl, cfg.supabaseServiceRoleKey);
    const { browserReturnUrl, gatewayCallbackUrl } = paymentReturnUrls(
      parsed.data.callbackUrl,
      intent.id,
      resolved.provider.name,
      apiOrigin,
    );
    const { error: returnUrlError } = await sb
      .from('billing_payment_intents')
      .update({
        metadata: {
          ...((intent.metadata as Record<string, unknown>) || {}),
          return_url: browserReturnUrl,
        },
      })
      .eq('id', intent.id);
    if (returnUrlError) throw new Error(`checkout return URL write failed: ${returnUrlError.message}`);

    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId,
      planId: 'wallet_deposit',
      interval: 'monthly',
      currency: 'IRR',
      callbackUrl: gatewayCallbackUrl,
      metadata: { amount: String(amount), depositId: deposit.id },
    });

    const ref = result.providerRef || result.authority || result.sessionId || '';
    const bindingRequired = requiresReferenceBinding(resolved.provider.name);
    if (bindingRequired || ref) {
      try {
        await setPaymentIntentProviderRef(cfg, intent.id, ref);
      } catch (bindError) {
        await markPaymentIntentFailed(
          cfg,
          intent.id,
          String((bindError as { message?: string })?.message || 'binding_failed'),
        );
        if (bindingRequired) return res.status(502).json({ error: 'CHECKOUT_REFERENCE_BINDING_FAILED' });
      }
    }

    res.json({ success: true, ...result, intentId: intent.id, documentNumber: deposit.document_number });
  } catch (e) {
    fail(res, e);
  }
});

// ─── AI credit purchase (invoice-driven) ───────────────────────────────────

billingCustomerRouter.post('/workspaces/:workspaceId/ai-credit/invoice', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = z.object({ amountIrr: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    // Rial AI credit: an Iranian-edition feature only (no USD ledger yet).
    await assertEditionFeature(cfg, 'aiCreditTopup');
    // The limits Super Admin sets for AI top-ups. platform_settings has no
    // ai_topup_* columns: reading them failed and this path always ran on the
    // defaults below, which it keeps while no limit is stored.
    const topup = await readTopupConfig(cfg, { presetsToman: [], minToman: 50_000, maxToman: 100_000_000 });
    const minIrr = Math.round(topup.minToman) * 10;
    const maxIrr = Math.round(topup.maxToman) * 10;

    const invoice = await issueAiCreditPurchase(cfg, req.params.workspaceId, parsed.data.amountIrr, {
      minIrr,
      maxIrr,
    });
    res.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amountIrr: Number(invoice.amount_due_irr),
    });
  } catch (e) {
    fail(res, e);
  }
});

// ─── Transactions (money movement) ─────────────────────────────────────────

billingCustomerRouter.get('/workspaces/:workspaceId/transactions', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    res.json(await listTransactions(serverConfigOf(req), req.params.workspaceId, pageParams(req)));
  } catch (e) {
    fail(res, e);
  }
});
