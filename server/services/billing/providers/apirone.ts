import type {
  BillingProviderConfig,
  BillingProviderHandler,
  CheckoutRequest,
  CheckoutResult,
  PaymentVerification,
  WebhookEvent,
} from '../types.js';
import { asRecord, errorText, providerFetch, readProviderJson, settingText } from './providerHttp.js';
import { requireSupportedCurrency } from './minorAmount.js';

// Apirone (apirone.com, API v2): crypto invoices, here USDT on TRON only
// (`usdt@trx`), charged in US dollars. The Iranian edition only
// (shared/edition.ts IRAN_ONLY_PAYMENT_PROVIDERS): a WebYar workspace whose
// dashboard is not in Persian pays its USD account with it (owner,
// 2026-11-01: temporary, for Apple's App Review).
//
//   create   POST /v2/accounts/{account}/invoices {currency, amount (micro-USDT,
//            a string), lifetime, callback-url, linkback, user-data}
//            → {invoice, amount, status, invoice-url, …}. No key is needed.
//   lookup   GET  /v2/invoices/{invoice} (public) → {invoice, currency, amount,
//            status, history: [{date, status, txid?, amount?}], linkback, …}.
//            It names no account; the private lookup needs the transfer key,
//            which can move the account's funds, so it is never stored here.
//   callback POST callback-url {account, invoice, status}, unsigned, from
//            callback.apirone.com; answered `*ok*` (text/plain, 200) or sent
//            again every 5 TRON blocks. Only a nudge: the invoice is looked up.
//
// Statuses: created → paid (the expected amount arrived, maybe unconfirmed) /
// partpaid / overpaid → completed (confirmed); expired at the end of its
// lifetime (with partpaid money, "check the amount arrived"). paid, partpaid
// and overpaid are set as soon as a transaction is SEEN (0 confirmations;
// Apirone: "do not finish a customer's order when you got an unconfirmed
// transaction"), so they all wait. Final here: completed (the status, or a
// `completed` entry in the history), and expired with money. What the
// confirmed transactions brought (the history's amounts up to the last
// `completed` entry, one per transaction; a later one is not confirmed by it)
// is credited, mapped back to cents in the proportion of the invoice: a full
// payment is exactly the payment's amount; less or more is credited as it
// came (account/index.ts, received amount).
//
// The customer pays Apirone's fee: the invoice is the USD amount plus
// `fee_percent` (default 1), rounded up to whole micro-USDT. The funds are
// forwarded to the owner's own TRON wallet by the forwarding set in Apirone's
// dashboard (docs/operations/APIRONE.md); nothing here moves them.

export const APIRONE_PROVIDER = 'apirone';
export const APIRONE_API = 'https://apirone.com/api/v2';
/** The only coin and network: USDT on TRON (TRC-20), 6 decimals. */
export const APIRONE_CURRENCY = 'usdt@trx';
/** How long an invoice can be paid (the account payment's own window is the same hour). */
export const APIRONE_INVOICE_LIFETIME_S = 3600;
export const APIRONE_DEFAULT_FEE_PERCENT = 1;
export const APIRONE_MAX_FEE_PERCENT = 10;

const ACCOUNT_RE = /^apr-[0-9a-f]{32}$/;
const INVOICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 1 cent = 10 000 micro-USDT (USDT is taken at 1 USD). */
const MICRO_PER_CENT = 10_000n;
const PPM = 1_000_000n;

/**
 * The status whose money is confirmed. `paid`, `partpaid` and `overpaid` are
 * set at 0 confirmations: overpaying never skips the wait for `completed`.
 */
const CONFIRMED_STATUS = 'completed';

/** The configured account id (Providers' `account`; `account_id` is read too), lower-cased; '' when unset. */
export function apironeAccountId(config: BillingProviderConfig | Record<string, unknown> | null | undefined): string {
  return (settingText(config?.account) || settingText(config?.account_id)).toLowerCase();
}

/** The fee the customer pays on top, in percent: blank is the default 1; null when not a number from 0 to 10. */
export function apironeFeePercent(config: BillingProviderConfig | Record<string, unknown> | null | undefined): number | null {
  const text = settingText(config?.fee_percent);
  if (!text) return APIRONE_DEFAULT_FEE_PERCENT;
  if (!/^\d+(\.\d{1,4})?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= APIRONE_MAX_FEE_PERCENT ? value : null;
}

/** What stops Apirone from taking a payment with these settings, or null. */
export function apironeSettingsProblem(config: BillingProviderConfig | Record<string, unknown> | null | undefined): string | null {
  const account = apironeAccountId(config);
  if (!account) return 'Apirone: Account ID is empty.';
  if (!ACCOUNT_RE.test(account)) {
    return 'Apirone: the Account ID must be "apr-" followed by 32 hexadecimal characters (Apirone dashboard → Settings).';
  }
  if (apironeFeePercent(config) === null) {
    return `Apirone: Fee percent must be a number from 0 to ${APIRONE_MAX_FEE_PERCENT} (blank is ${APIRONE_DEFAULT_FEE_PERCENT}).`;
  }
  return null;
}

/** The invoice amount in micro-USDT for `cents`, with the fee on top, rounded UP to a whole micro-USDT. */
export function apironeInvoiceAmount(cents: number, feePercent: number): bigint {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Apirone: invalid amount');
  const micro = BigInt(cents) * MICRO_PER_CENT;
  const feePpm = BigInt(Math.round(feePercent * 10_000));
  return (micro * (PPM + feePpm) + PPM - 1n) / PPM;
}

/** A non-negative whole amount Apirone reports (a number or a digit string), as a bigint; null otherwise. */
function readMicro(raw: unknown): bigint | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  if (typeof raw === 'string' && /^\d{1,30}$/.test(raw.trim())) return BigInt(raw.trim());
  return null;
}

/** What arrived on the invoice: the amounts of its history, each transaction (txid) counted once. */
export function apironeReceived(history: unknown): bigint {
  if (!Array.isArray(history)) return 0n;
  const byTx = new Map<string, bigint>();
  for (const item of history) {
    const entry = asRecord(item);
    const txid = typeof entry?.txid === 'string' ? entry.txid.trim() : '';
    const amount = readMicro(entry?.amount);
    if (!txid || amount === null) continue;
    const seen = byTx.get(txid);
    if (seen === undefined || amount > seen) byTx.set(txid, amount);
  }
  let total = 0n;
  for (const amount of byTx.values()) total += amount;
  return total;
}

/**
 * `received` micro-USDT in cents of the payment, in the proportion of the
 * invoice (whose amount carries the fee): floor(received × amountMinor ÷
 * invoiceAmount). A full payment is exactly `amountMinor`.
 */
export function apironeReceivedMinor(received: bigint, amountMinor: number, invoiceAmount: bigint): number {
  if (invoiceAmount <= 0n || received <= 0n) return 0;
  return Number((received * BigInt(amountMinor)) / invoiceAmount);
}

/** `$29.29`: micro-USDT shown in dollars, at least 2 and at most 6 decimals. */
function usd(micro: bigint): string {
  const whole = micro / PPM;
  const fraction = (micro % PPM).toString().padStart(6, '0').replace(/0{1,4}$/, '');
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

/** The account payment an invoice was made for: the `payment` query parameter of its `linkback` (our return URL). */
export function apironePaymentIdFromLinkback(linkback: unknown): string | undefined {
  if (typeof linkback !== 'string' || !linkback.trim()) return undefined;
  try {
    const id = new URL(linkback.trim()).searchParams.get('payment')?.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function describeApirone(body: unknown): string {
  const record = asRecord(body);
  const message = record?.message ?? record?.error ?? record?.detail;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200);
  return body === null || body === undefined ? 'empty answer' : JSON.stringify(body).slice(0, 200);
}

async function apironeJson(res: Response, context: string): Promise<Record<string, unknown>> {
  const data = await readProviderJson('Apirone', res, context);
  if (res.ok === false) throw new Error(`Apirone error: ${context}: ${describeApirone(data)} (HTTP ${res.status})`);
  const record = asRecord(data);
  if (!record) throw new Error(`Apirone error: ${context}: unexpected answer`);
  return record;
}

/** The public invoice info (GET /v2/invoices/{invoice}): never the transfer key. */
export async function fetchApironeInvoice(invoice: string): Promise<Record<string, unknown>> {
  if (!INVOICE_RE.test(invoice)) throw new Error('Apirone: invalid invoice id');
  const res = await providerFetch('Apirone', `${APIRONE_API}/invoices/${encodeURIComponent(invoice)}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await apironeJson(res, 'invoice lookup');
  if (data.invoice !== invoice) throw new Error('Apirone error: invoice lookup answered for another invoice');
  if (data.currency !== APIRONE_CURRENCY) throw new Error(`Apirone error: invoice ${invoice} is not ${APIRONE_CURRENCY}`);
  return data;
}

function statusOf(record: Record<string, unknown> | null | undefined): string {
  return typeof record?.status === 'string' ? record.status.trim().toLowerCase() : '';
}

/**
 * An invoice's status, and whether money that arrived on it is final: it
 * completed (its status, or a `completed` entry in its history: an invoice
 * that completed and then saw another transaction), or it expired with money.
 * `received` is what the confirmed transactions brought: those listed up to
 * the history's last `completed` entry (a later one is not confirmed by it);
 * every transaction of an invoice that expired with money.
 */
function apironeInvoiceState(invoice: Record<string, unknown>): { status: string; received: bigint; final: boolean; completed: boolean } {
  const status = statusOf(invoice);
  const history = Array.isArray(invoice.history) ? invoice.history : [];
  let completedAt = -1;
  history.forEach((item, i) => {
    if (statusOf(asRecord(item)) === CONFIRMED_STATUS) completedAt = i;
  });
  if (status === CONFIRMED_STATUS || completedAt >= 0) {
    const received = apironeReceived(completedAt >= 0 ? history.slice(0, completedAt + 1) : history);
    return { status, received, final: true, completed: true };
  }
  const received = apironeReceived(history);
  return { status, received, final: status === 'expired' && received > 0n, completed: false };
}

export const apironeProvider: BillingProviderHandler = {
  name: APIRONE_PROVIDER,
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: true, multiCurrency: false, trialSupport: false,
  },
  supportedCurrencies: ['USD'],
  webhookAckBody: '*ok*',

  // Unit contract: `req.metadata.amount` is the USD amount in cents, set
  // server-side from the payment row. The invoice adds the fee on top.
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const problem = apironeSettingsProblem(config);
    if (problem) throw new Error(problem);
    requireSupportedCurrency('Apirone', req.currency, ['USD']);
    const cents = Number(req.metadata?.amount);
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Apirone: invalid amount');
    const callbackUrl = (req.webhookUrl || '').trim();
    if (!/^https:\/\//i.test(callbackUrl)) throw new Error('Apirone: the platform\'s public API address (https) is not configured');
    const fee = apironeFeePercent(config) ?? APIRONE_DEFAULT_FEE_PERCENT;
    const subtotal = BigInt(cents) * MICRO_PER_CENT;
    const amount = apironeInvoiceAmount(cents, fee);
    const title = (req.description || 'Payment').slice(0, 100);
    const merchant = settingText(config.merchant_name);
    const res = await providerFetch('Apirone', `${APIRONE_API}/accounts/${apironeAccountId(config)}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        currency: APIRONE_CURRENCY,
        amount: amount.toString(),
        lifetime: APIRONE_INVOICE_LIFETIME_S,
        'callback-url': callbackUrl,
        linkback: req.callbackUrl,
        'user-data': {
          title,
          ...(merchant ? { merchant } : {}),
          price: usd(amount),
          'sub-price': usd(subtotal),
          items: [{ name: title, cost: usd(subtotal), qty: 1, total: usd(subtotal) }],
          ...(amount > subtotal ? { extras: [{ name: `Payment fee (${fee}%)`, price: usd(amount - subtotal) }] } : {}),
        },
      }),
    });
    const data = await apironeJson(res, 'create invoice');
    const invoice = typeof data.invoice === 'string' ? data.invoice.trim() : '';
    const invoiceUrl = typeof data['invoice-url'] === 'string' ? data['invoice-url'].trim() : '';
    if (!INVOICE_RE.test(invoice)) throw new Error('Apirone error: missing invoice id in the answer');
    if (!/^https:\/\//i.test(invoiceUrl)) throw new Error('Apirone error: missing invoice-url in the answer');
    const answered = readMicro(data.amount);
    if (answered !== null && answered !== amount) {
      throw new Error(`Apirone error: the invoice amount ${answered} is not the ${amount} asked for`);
    }
    return { paymentUrl: invoiceUrl, providerRef: invoice, sessionId: invoice };
  },

  /**
   * Looks the STORED invoice up (bound before the call; `params.amount` is
   * the payment's amount in cents). completed, or expired with money:
   * verified, with what the confirmed transactions brought in cents
   * (`receivedFinal`). expired with nothing: `expired`. created / paid /
   * partpaid / overpaid (all unconfirmed): pending, nothing is credited yet.
   */
  async verifyPayment(_config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
    const invoiceId = (params.invoice || '').trim();
    if (!invoiceId) return { verified: false, providerRef: '', status: 'pending' };
    const amountMinor = Number(params.amount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Apirone: the payment amount is missing');
    const invoice = await fetchApironeInvoice(invoiceId);
    const invoiceAmount = readMicro(invoice.amount);
    if (invoiceAmount === null || invoiceAmount <= 0n) throw new Error(`Apirone error: invoice ${invoiceId} has no amount`);
    const state = apironeInvoiceState(invoice);
    if (!state.final) {
      if (state.status === 'expired') return { verified: false, providerRef: invoiceId, status: 'expired' };
      return { verified: false, providerRef: invoiceId, status: 'pending' };
    }
    // A completed invoice whose history lists no amount was paid in full.
    const received = state.received > 0n ? state.received : state.completed ? invoiceAmount : 0n;
    if (received <= 0n) return { verified: false, providerRef: invoiceId, status: 'pending' };
    return {
      verified: true,
      providerRef: invoiceId,
      paymentId: invoiceId,
      amount: apironeReceivedMinor(received, amountMinor, invoiceAmount),
      currency: 'USD',
      status: 'success',
      receivedFinal: true,
    };
  },

  /**
   * The callback is unsigned: it is only a nudge. Its account must be the
   * configured one; everything else comes from the invoice looked up at
   * Apirone (never its status, never an amount). The payment it belongs to
   * is the `payment` parameter of the invoice's own linkback; the account
   * code then requires the invoice to be that payment's stored reference
   * and looks it up again before crediting anything.
   */
  async verifyWebhook(config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const accountId = apironeAccountId(config);
    if (!ACCOUNT_RE.test(accountId)) throw new Error('Apirone: account id not configured');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('Apirone: callback is not JSON');
    }
    const record = asRecord(payload);
    const account = typeof record?.account === 'string' ? record.account.trim().toLowerCase() : '';
    const invoiceId = typeof record?.invoice === 'string' ? record.invoice.trim() : '';
    if (account !== accountId) throw new Error('Apirone: callback for another account');
    if (!INVOICE_RE.test(invoiceId)) throw new Error('Apirone: callback without an invoice');
    const invoice = await fetchApironeInvoice(invoiceId);
    const state = apironeInvoiceState(invoice);
    const intentId = apironePaymentIdFromLinkback(invoice.linkback);
    return {
      type: state.final ? 'payment_succeeded' : 'ignored',
      providerEventId: `${invoiceId}:${state.status || 'unknown'}`,
      providerRef: invoiceId,
      providerPaymentId: invoiceId,
      ...(intentId ? { intentId } : {}),
      currency: 'USD',
      status: state.status,
      raw: { account, invoice: invoiceId, status: state.status },
    };
  },

  /** The account's public info for usdt@trx: the id exists and Apirone answers. */
  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    const problem = apironeSettingsProblem(config);
    if (problem) return { success: false, latencyMs: 0, error: problem };
    const accountId = apironeAccountId(config);
    try {
      const res = await providerFetch('Apirone', `${APIRONE_API}/accounts/${accountId}?currency=${encodeURIComponent(APIRONE_CURRENCY)}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await apironeJson(res, 'account info');
      if (String(data.account ?? '').toLowerCase() !== accountId) {
        return { success: false, latencyMs: Date.now() - start, error: 'Apirone: the answer names another account' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: errorText(e) };
    }
  },

  validateConfig(config: BillingProviderConfig) {
    const hasAny = Boolean(apironeAccountId(config) || settingText(config.fee_percent));
    return hasAny ? apironeSettingsProblem(config) : null;
  },
};
