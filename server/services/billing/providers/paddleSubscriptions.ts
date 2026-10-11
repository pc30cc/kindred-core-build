import type {
  BillingProviderConfig, PaddleCardDetails, PaddleCardEvent, PaddleSubscription, PaddleSubscriptionItem, PaddleTransaction,
} from '../types.js';
import {
  PADDLE_CURRENCIES, isPaddleSandboxFlag, paddleApiBase, paddleClientCheckout, paddleCredentialProblem,
} from './paddle.js';
import { minorFromProvider, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';
import { PADDLE_SANDBOX_PROVIDER } from '../../../../shared/testGateways.js';

// ─────────────────────────────────────────────────────────────────────
// PADDLE SUBSCRIPTIONS (saved card, simple billing phase 3b)
//
// The card a customer saves in a Paddle checkout lives on a Paddle
// subscription with one non-catalog recurring price that we set. Paddle's
// clock charges it; we only move that clock and that price (account/card.ts
// decides what they should be). This module is the wire layer for it:
//   - `paddleRequest`: every call here goes through it. It has a timeout,
//     never throws on an HTTP or network error, and tells a call that may have
//     charged (timeout, network error, 5xx) apart from one Paddle refused, so a
//     charge whose outcome is unknown is looked up instead of re-posted.
//   - readers for Paddle's subscription / transaction JSON (webhooks and
//     API answers alike), into the shapes of ../types.ts;
//   - the calls the card code makes. Only `createCharge` can bill. Updates are
//     refused unless they say `do_not_bill`, so a sync can never charge.
//
// The gateway config passed in must already be the right one for the card's
// provider: `paddleConfigFor` forces the sandbox for `paddle_sandbox`.
// ─────────────────────────────────────────────────────────────────────

/** Default for `paddleRequest`: Paddle normally answers within a second or two, a charge within a few. */
export const PADDLE_REQUEST_TIMEOUT_MS = 15_000;

/** Paddle's page-size limit for `GET /transactions`. */
const PADDLE_TRANSACTIONS_MAX_PER_PAGE = 30;

export interface PaddleResult<T = unknown> {
  ok: boolean;
  /** HTTP status; 0 when no answer arrived (timeout, network error, nothing sent). */
  status: number;
  /** The `data` member of Paddle's `{ data, meta }` envelope (an entity, or a list). */
  data: T | null;
  /**
   * Paddle's own code (`subscription_payment_declined`, `subscription_locked_renewal`,
   * `subscription_update_when_past_due`, …), or ours: `timeout`, `network_error`,
   * `http_<status>`, `unknown_outcome`, `not_configured`, `invalid_request`.
   */
  error: { code: string; detail: string } | null;
  /** A call that may have charged: timeout, network error or 5xx. Never retried blindly. */
  unknownOutcome: boolean;
}

// --- Local runtime narrowing for Paddle JSON bodies ----------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** A Paddle RFC 3339 time (microseconds included) as an ISO string, or null. */
function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function int(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function customData(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return record ? { ...record } : {};
}

function minor(value: unknown): number | null {
  return minorFromProvider(value) ?? null;
}

/** The entity itself, also when handed a whole `{ data: entity }` answer. */
function entity(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record && typeof record.id !== 'string' && asRecord(record.data)) return asRecord(record.data);
  return record;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function failure<T>(status: number, code: string, detail: string, unknownOutcome = false): PaddleResult<T> {
  return { ok: false, status, data: null, error: { code, detail }, unknownOutcome };
}

/**
 * One Paddle API call. Resolves for every outcome (it never throws on an HTTP
 * or network error); `ok` only for a 2xx with a readable body and no error
 * envelope.
 *
 * `charges: true` marks a call that may move money: its outcome is unknown
 * unless Paddle answered with a clean 2xx (it charged) or a 4xx (it refused,
 * nothing was charged). A timeout, a network error, a 5xx or an unreadable
 * answer sets `unknownOutcome`; the caller must look the charge up, never
 * re-post it.
 */
export async function paddleRequest<T = unknown>(
  config: BillingProviderConfig,
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; timeoutMs?: number; charges?: boolean } = {},
): Promise<PaddleResult<T>> {
  const method = init.method ?? 'GET';
  const charges = init.charges === true;
  const timeoutMs = init.timeoutMs ?? PADDLE_REQUEST_TIMEOUT_MS;
  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  if (!apiKey) return failure(0, 'not_configured', 'Paddle API key is not configured');
  // Errors are logged and stored: the key must never be in them.
  const clean = (text: string) => text.split(apiKey).join('[redacted]').slice(0, 500);

  let body: string | undefined;
  if (init.body !== undefined) {
    try {
      body = JSON.stringify(init.body);
    } catch (e: unknown) {
      return failure(0, 'invalid_request', clean(`The request body cannot be sent: ${messageOf(e)}`));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const lost = (status: number, e: unknown): PaddleResult<T> => controller.signal.aborted
    ? failure(status, 'timeout', `Paddle did not answer within ${timeoutMs} ms`, charges)
    : failure(status, 'network_error', clean(messageOf(e)), charges);

  let status: number;
  let text: string;
  try {
    const res = await fetch(`${paddleApiBase(config)}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
    status = res.status;
    try {
      text = await res.text();
    } catch (e: unknown) {
      return lost(status, e);
    }
  } catch (e: unknown) {
    return lost(0, e);
  } finally {
    clearTimeout(timer);
  }

  const success = status >= 200 && status < 300;
  // Paddle refused the request (validation, lock, decline, permission): nothing was charged.
  const refused = status >= 400 && status < 500;
  let json: unknown = null;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      return success
        ? failure(status, charges ? 'unknown_outcome' : `http_${status}`, 'Paddle answered with a body that is not JSON', charges)
        : failure(status, `http_${status}`, `Paddle answered HTTP ${status} with a body that is not JSON`, charges && !refused);
    }
  }
  const envelope = asRecord(json);
  const error = asRecord(envelope?.error);
  if (!success || envelope?.error) {
    return failure(
      status,
      str(error?.code) ?? `http_${status}`,
      clean(str(error?.detail) ?? `Paddle answered HTTP ${status}`),
      charges && !refused,
    );
  }
  return { ok: true, status, data: (envelope && 'data' in envelope ? envelope.data : null) as T | null, error: null, unknownOutcome: false };
}

// --- Readers ----------------------------------------------------------------

function readSubscriptionItem(value: unknown): PaddleSubscriptionItem | null {
  const item = asRecord(value);
  if (!item) return null;
  const price = asRecord(item.price);
  const unitPrice = asRecord(price?.unit_price);
  const cycle = asRecord(price?.billing_cycle);
  return {
    priceId: str(price?.id),
    amountMinor: minor(unitPrice?.amount),
    currency: normalizeCurrencyCode(unitPrice?.currency_code) ?? null,
    interval: cycle?.interval === 'month' || cycle?.interval === 'year' ? cycle.interval : null,
    frequency: int(cycle?.frequency),
    customData: customData(price?.custom_data),
  };
}

/** A Paddle subscription entity (API answer or webhook `data`), or null when it has no id. */
export function readSubscription(data: unknown): PaddleSubscription | null {
  const sub = entity(data);
  const id = str(sub?.id);
  if (!sub || !id) return null;
  const scheduled = asRecord(sub.scheduled_change);
  const action = str(scheduled?.action);
  return {
    id,
    status: str(sub.status) ?? '',
    customerId: str(sub.customer_id),
    currency: normalizeCurrencyCode(sub.currency_code) ?? null,
    nextBilledAt: iso(sub.next_billed_at),
    currentPeriodStart: iso(asRecord(sub.current_billing_period)?.starts_at),
    currentPeriodEnd: iso(asRecord(sub.current_billing_period)?.ends_at),
    scheduledChange: action ? { action, effectiveAt: iso(scheduled?.effective_at) } : null,
    items: (Array.isArray(sub.items) ? sub.items : [])
      .map(readSubscriptionItem)
      .filter((item): item is PaddleSubscriptionItem => item !== null),
    customData: customData(sub.custom_data),
    canceledAt: iso(sub.canceled_at),
  };
}

/** Payment attempts, newest first (Paddle sends them so; re-sorted when every attempt is dated). */
function paymentAttempts(txn: Record<string, unknown> | null): Record<string, unknown>[] {
  const attempts = (Array.isArray(txn?.payments) ? txn.payments : [])
    .map(asRecord)
    .filter((p): p is Record<string, unknown> => p !== null);
  const times = attempts.map((p) => Date.parse(typeof p.created_at === 'string' ? p.created_at : ''));
  if (!times.every(Number.isFinite)) return attempts;
  return attempts
    .map((p, i) => ({ p, t: times[i] }))
    .sort((a, b) => b.t - a.t)
    .map(({ p }) => p);
}

/**
 * The card of a transaction's newest payment attempt that has one
 * (`payments[].method_details.card`), or null (no attempt yet, PayPal, …).
 */
export function readCardDetails(txnData: unknown): PaddleCardDetails | null {
  for (const attempt of paymentAttempts(entity(txnData))) {
    const card = asRecord(asRecord(attempt.method_details)?.card);
    if (!card) continue;
    const last4 = str(card.last4);
    const expMonth = int(card.expiry_month);
    const details: PaddleCardDetails = {
      brand: str(card.type),
      last4: last4 && /^\d{4}$/.test(last4) ? last4 : null,
      expMonth: expMonth !== null && expMonth >= 1 && expMonth <= 12 ? expMonth : null,
      expYear: int(card.expiry_year),
    };
    if (details.brand || details.last4) return details;
  }
  return null;
}

/** A Paddle transaction entity (API answer or webhook `data`), or null when it has no id. */
export function readTransaction(data: unknown): PaddleTransaction | null {
  const txn = entity(data);
  const id = str(txn?.id);
  if (!txn || !id) return null;
  const totals = asRecord(asRecord(txn.details)?.totals);
  const newest = paymentAttempts(txn)[0];
  return {
    id,
    status: str(txn.status) ?? '',
    origin: str(txn.origin),
    subscriptionId: str(txn.subscription_id),
    customerId: str(txn.customer_id),
    currency: normalizeCurrencyCode(txn.currency_code) ?? null,
    totalMinor: minor(totals?.total),
    grandTotalMinor: minor(totals?.grand_total),
    creditMinor: minor(totals?.credit),
    itemCustomData: (Array.isArray(txn.items) ? txn.items : []).map((item) => customData(asRecord(asRecord(item)?.price)?.custom_data)),
    customData: customData(txn.custom_data),
    card: readCardDetails(txn),
    errorCode: str(newest?.error_code),
    createdAt: iso(txn.created_at),
    billedAt: iso(txn.billed_at),
  };
}

/**
 * The card-relevant part of a verified notification about a subscription or
 * a transaction Paddle made from one (providers/paddle.ts → `card_event`).
 */
export function readCardEvent(event: unknown): PaddleCardEvent {
  const root = asRecord(event);
  const data = asRecord(root?.data);
  const eventType = str(root?.event_type) ?? '';
  const isTransaction = eventType.startsWith('transaction.');
  return {
    eventType,
    entity: isTransaction ? 'transaction' : 'subscription',
    occurredAt: iso(root?.occurred_at),
    subscriptionId: isTransaction ? str(data?.subscription_id) : str(data?.id),
    customerId: str(data?.customer_id),
    // subscription.created names the checkout transaction that created it.
    transactionId: isTransaction ? str(data?.id) : str(data?.transaction_id),
    transaction: isTransaction ? readTransaction(data) : null,
    subscription: isTransaction ? null : readSubscription(data),
    customData: customData(data?.custom_data),
  };
}

// --- Subscription calls -------------------------------------------------------

function subscriptionPath(id: string, suffix = ''): string | null {
  const clean = typeof id === 'string' ? id.trim() : '';
  return clean ? `/subscriptions/${encodeURIComponent(clean)}${suffix}` : null;
}

function missingId<T>(): PaddleResult<T> {
  return failure(0, 'invalid_request', 'A Paddle id is required');
}

type SubscriptionAnswer = PaddleResult<unknown> & { subscription: PaddleSubscription | null };

async function subscriptionCall(
  config: BillingProviderConfig,
  path: string | null,
  init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown },
): Promise<SubscriptionAnswer> {
  if (!path) return { ...missingId(), subscription: null };
  const result = await paddleRequest(config, path, init);
  return { ...result, subscription: result.ok ? readSubscription(result.data) : null };
}

export function getSubscription(config: BillingProviderConfig, id: string): Promise<SubscriptionAnswer> {
  return subscriptionCall(config, subscriptionPath(id), { method: 'GET' });
}

/** What a sync may change on a subscription (`PATCH /subscriptions/{id}`). */
export interface SubscriptionPatch {
  /** The complete list of recurring items (an item left out is removed). */
  items?: Array<{ quantity: number; price: Record<string, unknown> }>;
  /** RFC 3339. */
  next_billed_at?: string;
  custom_data?: Record<string, unknown>;
  /** null undoes a scheduled cancel (the only value Paddle accepts). */
  scheduled_change?: null;
  proration_billing_mode?: 'do_not_bill';
}

const PATCH_FIELDS = new Set(['items', 'next_billed_at', 'custom_data', 'scheduled_change', 'proration_billing_mode']);

/**
 * Throws (before anything is sent) for a patch that could bill: items or a
 * billing date without `proration_billing_mode: 'do_not_bill'`, any other
 * billing mode, or a field outside SubscriptionPatch.
 */
function assertDoesNotBill(patch: SubscriptionPatch): void {
  const record = asRecord(patch);
  if (!record) throw new Error('Paddle subscription update refused: no patch');
  for (const field of Object.keys(record)) {
    if (!PATCH_FIELDS.has(field)) throw new Error(`Paddle subscription update refused: "${field}" is not changed from here`);
  }
  const mode = record.proration_billing_mode;
  if (mode !== undefined && mode !== 'do_not_bill') {
    throw new Error(`Paddle subscription update refused: proration_billing_mode "${String(mode)}" could bill; only do_not_bill is used`);
  }
  if ((record.items !== undefined || record.next_billed_at !== undefined) && mode !== 'do_not_bill') {
    throw new Error('Paddle subscription update refused: items and next_billed_at change only with proration_billing_mode "do_not_bill"');
  }
  if (record.next_billed_at !== undefined && !(typeof record.next_billed_at === 'string' && Number.isFinite(Date.parse(record.next_billed_at)))) {
    throw new Error('Paddle subscription update refused: next_billed_at is not a date');
  }
  if ('scheduled_change' in record && record.scheduled_change !== null) {
    throw new Error('Paddle subscription update refused: scheduled_change can only be cleared (null)');
  }
}

/** Whether a preview answer moves money now: an immediate transaction, or a prorated charge or credit. */
function previewMovesMoney(preview: Record<string, unknown> | null): boolean {
  if (!preview) return true;
  if (preview.immediate_transaction !== null && preview.immediate_transaction !== undefined) return true;
  const summary = asRecord(preview.update_summary);
  for (const part of [summary?.charge, summary?.credit, summary?.result]) {
    if ((minor(asRecord(part)?.amount) ?? 0) > 0) return true;
  }
  return false;
}

/**
 * PATCH /subscriptions/{id}/preview. `billsNow` = the preview has an
 * immediate_transaction, or its update summary a charge or credit above 0. A
 * preview that failed or could not be read counts as billing.
 */
export async function previewSubscriptionUpdate(
  config: BillingProviderConfig,
  id: string,
  patch: SubscriptionPatch,
): Promise<SubscriptionAnswer & { billsNow: boolean }> {
  assertDoesNotBill(patch);
  const path = subscriptionPath(id, '/preview');
  if (!path) return { ...missingId(), subscription: null, billsNow: true };
  const result = await paddleRequest(config, path, { method: 'PATCH', body: patch });
  const preview = asRecord(result.data);
  return {
    ...result,
    billsNow: !result.ok || previewMovesMoney(preview),
    // A preview carries no id of its own.
    subscription: result.ok && preview ? readSubscription({ ...preview, id: str(preview.id) ?? id.trim() }) : null,
  };
}

/** PATCH /subscriptions/{id}. Throws (never calls Paddle) when items/next_billed_at are present without proration_billing_mode 'do_not_bill'. */
export async function updateSubscription(config: BillingProviderConfig, id: string, patch: SubscriptionPatch): Promise<SubscriptionAnswer> {
  assertDoesNotBill(patch);
  return subscriptionCall(config, subscriptionPath(id), { method: 'PATCH', body: patch });
}

/**
 * POST /subscriptions/{id}/cancel. `immediately` ends it now (allowed while
 * past_due, and it stops Paddle's dunning); `next_billing_period` schedules
 * the cancel, which `clearScheduledChange` undoes until it takes effect.
 */
export async function cancelSubscriptionAt(
  config: BillingProviderConfig,
  id: string,
  effectiveFrom: 'immediately' | 'next_billing_period',
): Promise<SubscriptionAnswer> {
  if (effectiveFrom !== 'immediately' && effectiveFrom !== 'next_billing_period') {
    throw new Error(`Paddle cancel: unknown effective_from "${String(effectiveFrom)}"`);
  }
  return subscriptionCall(config, subscriptionPath(id, '/cancel'), { method: 'POST', body: { effective_from: effectiveFrom } });
}

/** Undoes a scheduled cancel (PATCH `scheduled_change: null`). */
export function clearScheduledChange(config: BillingProviderConfig, id: string): Promise<SubscriptionAnswer> {
  return updateSubscription(config, id, { scheduled_change: null });
}

// --- Items --------------------------------------------------------------------

export interface ChargeItem { quantity: 1; price: Record<string, unknown> }

interface ItemInput {
  name: string;
  description: string;
  amountMinor: number;
  currency: string;
  productId?: string | null;
  customData: Record<string, unknown>;
}

function clip(text: string, max: number): string {
  return Array.from(typeof text === 'string' ? text.trim() : '').slice(0, max).join('');
}

/**
 * A non-catalog price for exactly `amountMinor`, tax-INCLUSIVE like the
 * checkout's (`tax_mode: internal`), attached to the configured catalog
 * product or to an inline one. Paddle's length limits differ per endpoint.
 */
function itemPrice(input: ItemInput, limits: { name: number; description: number }): Record<string, unknown> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('A Paddle item needs a positive amount in minor units');
  }
  const currency = requireSupportedCurrency('Paddle', input.currency, PADDLE_CURRENCIES);
  const name = clip(input.name, limits.name) || 'Plan';
  const description = [clip(input.description, limits.description), clip(name, limits.description)]
    .find((text) => text.length >= 2) ?? 'Plan charge';
  const productId = typeof input.productId === 'string' ? input.productId.trim() : '';
  return {
    description,
    name,
    unit_price: { amount: String(input.amountMinor), currency_code: currency },
    tax_mode: 'internal',
    ...(productId ? { product_id: productId } : { product: { name: clip(input.name, 200) || name, tax_category: 'standard' } }),
    custom_data: { ...input.customData },
  };
}

/** A one-time item for `/charge` (`custom_data.payment_id` ties the transaction to our payment row). */
export function buildChargeItem(input: ItemInput): ChargeItem {
  return { quantity: 1, price: itemPrice(input, { name: 50, description: 200 }) };
}

/** The subscription's recurring item: the next period's price, every month or year. */
export function buildRecurringItem(input: ItemInput & { interval: 'monthly' | 'yearly' }): ChargeItem {
  if (input.interval !== 'monthly' && input.interval !== 'yearly') {
    throw new Error(`A Paddle recurring item needs a monthly or yearly interval, not "${String(input.interval)}"`);
  }
  return {
    quantity: 1,
    price: {
      ...itemPrice(input, { name: 150, description: 500 }),
      billing_cycle: { interval: input.interval === 'yearly' ? 'year' : 'month', frequency: 1 },
    },
  };
}

// --- One-time charges -----------------------------------------------------------

function chargeBody(items: ChargeItem[]) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('A Paddle charge needs at least one item');
  return { effective_from: 'immediately', on_payment_failure: 'prevent_change', items };
}

/**
 * POST /subscriptions/{id}/charge/preview with the body `createCharge` would
 * send. `grandTotalMinor`, `creditMinor` from the preview's immediate transaction.
 */
export async function previewCharge(
  config: BillingProviderConfig,
  id: string,
  items: ChargeItem[],
): Promise<PaddleResult<unknown> & { grandTotalMinor: number | null; creditMinor: number | null }> {
  const body = chargeBody(items);
  const path = subscriptionPath(id, '/charge/preview');
  if (!path) return { ...missingId(), grandTotalMinor: null, creditMinor: null };
  const result = await paddleRequest(config, path, { method: 'POST', body });
  const totals = asRecord(asRecord(asRecord(asRecord(result.data)?.immediate_transaction)?.details)?.totals);
  return {
    ...result,
    grandTotalMinor: result.ok ? minor(totals?.grand_total) : null,
    creditMinor: result.ok ? minor(totals?.credit) : null,
  };
}

/**
 * POST /subscriptions/{id}/charge {effective_from:'immediately',
 * on_payment_failure:'prevent_change', items}: Paddle charges the
 * subscription's card during the call. A decline is a 400
 * `subscription_payment_declined` and changes nothing. The answer is the
 * subscription, not the transaction: find that with
 * `listSubscriptionTransactions` by the item's `custom_data`. charges: true.
 */
export async function createCharge(config: BillingProviderConfig, id: string, items: ChargeItem[]): Promise<PaddleResult<unknown>> {
  const body = chargeBody(items);
  const path = subscriptionPath(id, '/charge');
  if (!path) return missingId();
  return paddleRequest(config, path, { method: 'POST', body, charges: true });
}

// --- Transactions ---------------------------------------------------------------

/**
 * GET /transactions?subscription_id=<id>&per_page=<n>&order_by=created_at[DESC]
 * (newest first; Paddle allows at most 30 per page), filtered again on our
 * side to that subscription.
 */
export async function listSubscriptionTransactions(
  config: BillingProviderConfig,
  subscriptionId: string,
  opts: { perPage?: number } = {},
): Promise<PaddleResult<unknown> & { transactions: PaddleTransaction[] }> {
  const id = typeof subscriptionId === 'string' ? subscriptionId.trim() : '';
  if (!id) return { ...missingId(), transactions: [] };
  const wanted = Number.isFinite(opts.perPage) ? Math.floor(opts.perPage as number) : PADDLE_TRANSACTIONS_MAX_PER_PAGE;
  const perPage = Math.min(PADDLE_TRANSACTIONS_MAX_PER_PAGE, Math.max(1, wanted));
  const result = await paddleRequest(
    config,
    `/transactions?subscription_id=${encodeURIComponent(id)}&per_page=${perPage}&order_by=created_at[DESC]`,
  );
  const rows = result.ok && Array.isArray(result.data) ? result.data : [];
  return {
    ...result,
    transactions: rows
      .map(readTransaction)
      .filter((txn): txn is PaddleTransaction => txn !== null && txn.subscriptionId === id),
  };
}

export async function getTransaction(
  config: BillingProviderConfig,
  id: string,
): Promise<PaddleResult<unknown> & { transaction: PaddleTransaction | null }> {
  const clean = typeof id === 'string' ? id.trim() : '';
  if (!clean) return { ...missingId(), transaction: null };
  const result = await paddleRequest(config, `/transactions/${encodeURIComponent(clean)}`);
  return { ...result, transaction: result.ok ? readTransaction(result.data) : null };
}

/**
 * GET /subscriptions/{id}/update-payment-method-transaction → the transaction
 * to open in Paddle.js: a zero-amount one for an active subscription, the
 * most recent past_due one (paying it settles the debt) for a past_due one.
 */
export async function getUpdatePaymentMethodTransaction(
  config: BillingProviderConfig,
  id: string,
): Promise<PaddleResult<unknown> & { transactionId: string | null }> {
  const path = subscriptionPath(id, '/update-payment-method-transaction');
  if (!path) return { ...missingId(), transactionId: null };
  const result = await paddleRequest(config, path);
  return { ...result, transactionId: result.ok ? str(asRecord(result.data)?.id) : null };
}

// --- Gateway config ---------------------------------------------------------------

/**
 * The config to call Paddle with for a card of `providerName`. For
 * `paddle_sandbox`: the sandbox forced on, and live credentials refused
 * (throws), exactly like providers/paddle-sandbox.ts. For `paddle`: the config
 * as is. Anything else is not a Paddle gateway (throws).
 */
export function paddleConfigFor(providerName: string, config: BillingProviderConfig): BillingProviderConfig {
  const name = typeof providerName === 'string' ? providerName.trim().toLowerCase() : '';
  if (name === PADDLE_SANDBOX_PROVIDER) {
    const problem = paddleCredentialProblem(config, PADDLE_SANDBOX_PROVIDER);
    if (problem) throw new Error(problem);
    return { ...config, sandbox: true };
  }
  if (name === 'paddle') return config;
  throw new Error(`${String(providerName)} is not a Paddle gateway`);
}

/**
 * Whether a gateway config offers automatic card renewal: the Super Admin's
 * `card_auto_renew` switch (off by default), read with the same rules as
 * the sandbox switch (a saved `'false'` is off).
 */
export function cardAutoRenewEnabled(config: BillingProviderConfig | null | undefined): boolean {
  return Boolean(config) && isPaddleSandboxFlag(config?.card_auto_renew);
}

/**
 * The `clientCheckout` object for a transaction (same shape as
 * createCheckoutSession's), for `paddle` or `paddle_sandbox`: the browser
 * opens it with Paddle.js and returns to `successUrl`.
 */
export function clientCheckoutFor(
  providerName: string,
  config: BillingProviderConfig,
  transactionId: string,
  successUrl: string,
  customerEmail?: string,
): Record<string, unknown> {
  const checkout = paddleClientCheckout(paddleConfigFor(providerName, config), transactionId, successUrl, customerEmail);
  return providerName.trim().toLowerCase() === PADDLE_SANDBOX_PROVIDER
    ? { ...checkout, provider: PADDLE_SANDBOX_PROVIDER, environment: 'sandbox' }
    : checkout;
}
