/**
 * A stateful stand-in for Paddle Billing's API and its notifications, for the
 * simple billing's end-to-end suites (docs/billing/SIMPLE_BILLING.md, phase
 * 3b design §5). It answers what the server calls
 * (server/services/billing/providers/paddle.ts and paddleSubscriptions.ts)
 * the way Paddle does, keeps what Paddle would keep, and queues the
 * notifications Paddle would send, signed with the gateway's webhook secret
 * when they are delivered.
 *
 *   state      customers, subscriptions (status, next_billed_at, the
 *              current billing period, items with their price custom_data,
 *              scheduled_change, custom_data, billing_cycle, currency) and
 *              transactions (origin, status, items, totals, payments with
 *              their card), adjustments;
 *   endpoints  POST/GET/PATCH /transactions, GET /transactions?subscription_id,
 *              GET/PATCH /subscriptions/:id and /preview, /cancel, /charge
 *              and /charge/preview, /update-payment-method-transaction,
 *              GET /subscriptions (list) and /event-types (connection test);
 *   rules      the 30-minute renewal lock (409), no update while past_due or
 *              canceled, a 70-cent minimum per charge, scheduled_change can
 *              only be cleared, items and next_billed_at need a
 *              proration_billing_mode, and a mode other than do_not_bill
 *              bills (the preview shows the immediate transaction);
 *              custom_data is copied checkout → subscription → transactions;
 *   controls   completeCheckout, renew, collect, declineNext,
 *              failAfterCreate, refuseClose, adjust (refund / chargeback),
 *              portalCancel, foreignSubscription, shift + runClock (time),
 *              deliver / deliverAll / replay ({shuffle, duplicate, drop});
 *   evidence   every call is recorded (`calls`), and `billingViolations()`
 *              lists the calls that could have billed outside our rules
 *              (invariant I5).
 *
 * `installOutboundGuard` answers Paddle's base URL from the fake and refuses
 * every other request that would leave this machine.
 */
import crypto from 'node:crypto';
import https from 'node:https';

type Json = Record<string, unknown>;

export const PADDLE_SANDBOX_API = 'https://sandbox-api.paddle.com';

/** Paddle refuses changes to a subscription this long before its renewal. */
const LOCK_MS = 30 * 60 * 1000;
/** Paddle's smallest charge (USD/EUR/GBP), in minor units. */
const MIN_CHARGE_MINOR = 70;
/** Paddle's limit of immediate charges per subscription and hour. */
const CHARGES_PER_HOUR = 20;
const BILLING_MODES = new Set([
  'prorated_immediately', 'prorated_next_billing_period', 'full_immediately', 'full_next_billing_period', 'do_not_bill',
]);
const PATCH_FIELDS = new Set([
  'items', 'next_billed_at', 'custom_data', 'scheduled_change', 'proration_billing_mode', 'on_payment_failure',
  'customer_id', 'address_id', 'business_id', 'currency_code', 'collection_mode', 'billing_details', 'discount',
]);

export interface FakeCard { type: string; last4: string; expiry_month: number; expiry_year: number; cardholder_name?: string }
export const VISA_4242: FakeCard = { type: 'visa', last4: '4242', expiry_month: 12, expiry_year: 2030, cardholder_name: 'Test Owner' };
export const MASTERCARD_5555: FakeCard = { type: 'mastercard', last4: '5555', expiry_month: 6, expiry_year: 2031, cardholder_name: 'Test Owner' };

export type BillingCycle = { interval: 'month' | 'year'; frequency: number };

export interface FakePrice {
  id: string;
  product_id: string;
  name: string;
  description: string;
  type: 'custom';
  unit_price: { amount: string; currency_code: string };
  billing_cycle: BillingCycle | null;
  tax_mode: string;
  custom_data: Json | null;
  status: 'active';
}

export interface FakeSubscriptionItem {
  status: 'active';
  quantity: number;
  recurring: boolean;
  created_at: string;
  updated_at: string;
  previously_billed_at: string | null;
  next_billed_at: string | null;
  price: FakePrice;
  product: { id: string; name: string };
}

export interface FakeSubscription {
  id: string;
  status: 'active' | 'past_due' | 'paused' | 'canceled';
  customer_id: string;
  address_id: string | null;
  business_id: null;
  currency_code: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  first_billed_at: string;
  next_billed_at: string | null;
  paused_at: null;
  canceled_at: string | null;
  collection_mode: 'automatic';
  billing_details: null;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  billing_cycle: BillingCycle;
  scheduled_change: { action: 'cancel' | 'pause' | 'resume'; effective_at: string; resume_at: string | null } | null;
  items: FakeSubscriptionItem[];
  custom_data: Json | null;
  discount: null;
  import_meta: null;
  management_urls: { update_payment_method: string; cancel: string };
}

export interface FakePayment {
  payment_attempt_id: string;
  stored_payment_method_id: string;
  amount: string;
  status: 'captured' | 'error';
  error_code: string | null;
  method_details: { type: 'card'; card: FakeCard };
  created_at: string;
  captured_at: string | null;
}

export interface FakeTotals {
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  credit: string;
  credit_to_balance: string;
  balance: string;
  grand_total: string;
  fee: string | null;
  earnings: string | null;
  currency_code: string;
}

export type FakeOrigin = 'api' | 'web' | 'subscription_recurring' | 'subscription_charge' | 'subscription_update' | 'subscription_payment_method_change';

export interface FakeTransaction {
  id: string;
  status: 'draft' | 'ready' | 'billed' | 'paid' | 'completed' | 'canceled' | 'past_due';
  customer_id: string | null;
  address_id: string | null;
  business_id: null;
  custom_data: Json | null;
  currency_code: string;
  origin: FakeOrigin;
  subscription_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  collection_mode: 'automatic';
  billing_details: null;
  billing_period: { starts_at: string; ends_at: string } | null;
  items: Array<{ price: FakePrice; quantity: number; proration: null }>;
  details: { totals: FakeTotals; line_items: unknown[] };
  payments: FakePayment[];
  checkout: { url: string | null } | null;
  created_at: string;
  updated_at: string;
  billed_at: string | null;
}

export interface FakeAdjustment {
  id: string;
  action: 'refund' | 'chargeback';
  transaction_id: string;
  subscription_id: string | null;
  customer_id: string | null;
  reason: string;
  currency_code: string;
  status: 'pending_approval' | 'approved';
  items: Array<{ item_id: string; type: 'full' | 'partial'; amount: string }>;
  totals: { subtotal: string; tax: string; total: string; fee: string; earnings: string; currency_code: string };
  created_at: string;
  updated_at: string;
}

/** A notification as Paddle sends it. */
export interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: Json;
}

/** A queued notification, with what it is about (for filtering; never sent). */
export interface QueuedEvent {
  event: PaddleEvent;
  workspaceId: string | null;
  subscriptionId: string | null;
  transactionId: string | null;
  foreign: boolean;
}

export interface DeliveryResult {
  queued: QueuedEvent;
  eventId: string;
  status: number;
  body: unknown;
}

/** One call the server made to the fake. */
export interface PaddleCall {
  seq: number;
  at: number;
  method: string;
  path: string;
  query: string;
  body: Json | null;
  status: number;
  code: string | null;
  subscriptionId: string | null;
  /** What `inspectCharge` saw for a /charge (our payment row, at the time of the call). */
  inspected?: Json | null;
  /** A path the fake does not answer. */
  unexpected?: boolean;
}

export type WebhookPoster = (body: string, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;

interface SubMeta {
  workspaceId: string | null;
  foreign: boolean;
  card: FakeCard;
  declineNext: string | null;
  failAfterCreate: boolean;
  mergeCustomData: boolean;
  chargesAt: number[];
}

interface TxnMeta {
  workspaceId: string | null;
  foreign: boolean;
  refuseClose: boolean;
}

export interface FakePaddleOptions {
  api?: string;
  webhookSecret: string;
  /** Delivers a notification to the server (the webhook route). */
  post?: WebhookPoster;
  /** Looked up when a /charge arrives, before it is answered: our payment row for its item's payment_id (I5). */
  inspectCharge?: (paymentId: string | null) => Promise<Json | null>;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const clone = <T>(value: T): T => structuredClone(value);
const iso = (ms: number) => new Date(ms).toISOString();
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `at` plus `frequency` months or years, in UTC, the last day of a shorter month when the day does not exist. */
export function addCycle(at: string, cycle: BillingCycle): string {
  const d = new Date(Date.parse(at));
  const months = d.getUTCMonth() + (cycle.interval === 'year' ? 12 : 1) * Math.max(1, cycle.frequency);
  const year = d.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  )).toISOString();
}

function shiftIso(value: string | null | undefined, ms: number): string | null {
  if (!value) return value ?? null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? iso(t - ms) : value;
}

/** A small seeded random generator (mulberry32), so a shuffled delivery can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function minorOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function totalsOf(amount: number, currency: string, credit = 0): FakeTotals {
  return {
    subtotal: String(amount),
    discount: '0',
    tax: '0',
    total: String(amount),
    credit: String(credit),
    credit_to_balance: '0',
    balance: '0',
    grand_total: String(Math.max(0, amount - credit)),
    fee: null,
    earnings: null,
    currency_code: currency,
  };
}

class PaddleRefusal extends Error {
  constructor(public status: number, public code: string, detail: string) {
    super(detail);
  }
}

// ─── The fake ───────────────────────────────────────────────────────────────

export class FakePaddle {
  readonly api: string;
  readonly customers = new Map<string, { id: string; email: string }>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly transactions = new Map<string, FakeTransaction>();
  readonly adjustments = new Map<string, FakeAdjustment>();
  readonly calls: PaddleCall[] = [];
  /** Notifications Paddle has to send. */
  readonly outbox: QueuedEvent[] = [];
  /** Notifications the server acknowledged (2xx). */
  readonly delivered: QueuedEvent[] = [];
  /** Notifications that never arrived (deliver's `drop`). */
  readonly lost: QueuedEvent[] = [];

  private readonly secret: string;
  private post: WebhookPoster | null;
  private readonly inspectCharge: FakePaddleOptions['inspectCharge'];
  private readonly subMeta = new Map<string, SubMeta>();
  private readonly txnMeta = new Map<string, TxnMeta>();
  private seq = 0;

  constructor(options: FakePaddleOptions) {
    this.api = options.api ?? PADDLE_SANDBOX_API;
    this.secret = options.webhookSecret;
    this.post = options.post ?? null;
    this.inspectCharge = options.inspectCharge;
  }

  /** Where notifications are delivered (the webhook route). */
  connect(post: WebhookPoster): void {
    this.post = post;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_01fake${String(this.seq).padStart(6, '0')}`;
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  /** Answers one request to Paddle's API. */
  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const full = url.slice(this.api.length);
    const [path, query = ''] = full.split('?');
    let body: Json | null = null;
    if (typeof init.body === 'string' && init.body.trim()) {
      try {
        const parsed: unknown = JSON.parse(init.body);
        body = isRecord(parsed) ? parsed : null;
      } catch {
        body = null;
      }
    }
    const subMatch = /^\/subscriptions\/([^/]+)/.exec(path);
    const call: PaddleCall = {
      seq: this.calls.length + 1, at: Date.now(), method, path, query, body,
      status: 0, code: null, subscriptionId: subMatch ? decodeURIComponent(subMatch[1]) : null,
    };
    this.calls.push(call);
    let status = 200;
    let payload: unknown;
    try {
      const answer = await this.route(method, path, new URLSearchParams(query), body, call);
      status = answer.status;
      payload = answer.status >= 400 ? answer.data : { data: answer.data, meta: { request_id: crypto.randomUUID() } };
      if (answer.status >= 400) call.code = String((answer.data as { error?: { code?: string } }).error?.code ?? '');
    } catch (e) {
      if (!(e instanceof PaddleRefusal)) throw e;
      status = e.status;
      call.code = e.code;
      payload = {
        error: { type: e.status >= 500 ? 'api_error' : 'request_error', code: e.code, detail: e.message },
        meta: { request_id: crypto.randomUUID() },
      };
    }
    call.status = status;
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }

  private async route(method: string, path: string, query: URLSearchParams, body: Json | null, call: PaddleCall): Promise<{ status: number; data: unknown }> {
    const ok = (data: unknown, status = 200) => ({ status, data });
    if (method === 'GET' && path === '/event-types') return ok([]);
    if (method === 'GET' && path === '/subscriptions') {
      const perPage = Math.min(200, Math.max(1, Number(query.get('per_page') ?? 50)));
      return ok([...this.subscriptions.values()].slice(0, perPage).map((s) => clone(s)));
    }
    if (method === 'POST' && path === '/transactions') return ok(this.createCheckout(body ?? {}), 201);
    if (method === 'GET' && path === '/transactions') return ok(this.listTransactions(query));

    let m = /^\/transactions\/([^/]+)$/.exec(path);
    if (m) {
      const txn = this.transactions.get(decodeURIComponent(m[1]));
      if (!txn) throw new PaddleRefusal(404, 'entity_not_found', 'Transaction not found');
      if (method === 'GET') return ok(clone(txn));
      if (method === 'PATCH') return ok(this.patchTransaction(txn, body ?? {}));
    }

    m = /^\/subscriptions\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const sub = this.subscriptions.get(decodeURIComponent(m[1]));
      if (!sub) throw new PaddleRefusal(404, 'entity_not_found', 'Subscription not found');
      const rest = m[2] ?? '';
      if (method === 'GET' && rest === '') return ok(clone(sub));
      if (method === 'PATCH' && rest === '') return ok(this.updateSubscription(sub, body ?? {}, false));
      if (method === 'PATCH' && rest === '/preview') return ok(this.updateSubscription(sub, body ?? {}, true));
      if (method === 'POST' && rest === '/cancel') return ok(this.cancelSubscription(sub, body ?? {}));
      if (method === 'POST' && rest === '/charge/preview') return ok(this.charge(sub, body ?? {}, true));
      if (method === 'POST' && rest === '/charge') {
        const paymentId = this.chargePaymentId(body);
        if (this.inspectCharge) call.inspected = await this.inspectCharge(paymentId);
        const meta = this.meta(sub.id);
        const answer = this.charge(sub, body ?? {}, false);
        if (meta.failAfterCreate) {
          // Paddle charged, but its answer never arrives in one piece.
          meta.failAfterCreate = false;
          throw new PaddleRefusal(500, 'internal_error', 'An internal error occurred');
        }
        return ok(answer);
      }
      if (method === 'GET' && rest === '/update-payment-method-transaction') return ok(this.updatePaymentMethodTransaction(sub));
    }
    call.unexpected = true;
    throw new PaddleRefusal(404, 'not_found', `${method} ${path} is not answered by the fake`);
  }

  private meta(subId: string): SubMeta {
    let meta = this.subMeta.get(subId);
    if (!meta) {
      meta = { workspaceId: null, foreign: false, card: VISA_4242, declineNext: null, failAfterCreate: false, mergeCustomData: false, chargesAt: [] };
      this.subMeta.set(subId, meta);
    }
    return meta;
  }

  private tmeta(txnId: string): TxnMeta {
    let meta = this.txnMeta.get(txnId);
    if (!meta) {
      meta = { workspaceId: null, foreign: false, refuseClose: false };
      this.txnMeta.set(txnId, meta);
    }
    return meta;
  }

  private chargePaymentId(body: Json | null): string | null {
    const items = Array.isArray(body?.items) ? body.items : [];
    for (const item of items) {
      const data = isRecord(item) && isRecord(item.price) && isRecord(item.price.custom_data) ? item.price.custom_data : null;
      if (data && typeof data.payment_id === 'string') return data.payment_id;
    }
    return null;
  }

  // ─── Notifications ─────────────────────────────────────────────────────

  private emit(eventType: string, data: Json, about: { workspaceId: string | null; subscriptionId?: string | null; transactionId?: string | null; foreign?: boolean }): void {
    const n = this.seq + 1;
    this.seq = n;
    this.outbox.push({
      event: {
        event_id: `evt_01fake${String(n).padStart(6, '0')}`,
        event_type: eventType,
        occurred_at: new Date().toISOString(),
        notification_id: `ntf_01fake${String(n).padStart(6, '0')}`,
        data: clone(data),
      },
      workspaceId: about.workspaceId,
      subscriptionId: about.subscriptionId ?? null,
      transactionId: about.transactionId ?? null,
      foreign: about.foreign === true,
    });
  }

  private emitTxn(eventType: string, txn: FakeTransaction): void {
    const meta = this.tmeta(txn.id);
    this.emit(eventType, txn as unknown as Json, {
      workspaceId: meta.workspaceId, subscriptionId: txn.subscription_id, transactionId: txn.id, foreign: meta.foreign,
    });
  }

  private emitSub(eventType: string, sub: FakeSubscription, extra: Json = {}): void {
    const meta = this.meta(sub.id);
    this.emit(eventType, { ...(sub as unknown as Json), ...extra }, { workspaceId: meta.workspaceId, subscriptionId: sub.id, foreign: meta.foreign });
  }

  /** The signature header Paddle sends with `body`. */
  sign(body: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', this.secret).update(`${ts}:${body}`).digest('hex');
    return { 'paddle-signature': `ts=${ts};h1=${h1}` };
  }

  private async send(queued: QueuedEvent, eventId?: string): Promise<DeliveryResult> {
    if (!this.post) throw new Error('fake Paddle: no webhook endpoint connected');
    const event = eventId ? { ...queued.event, event_id: eventId, notification_id: `ntf_${eventId}` } : queued.event;
    const body = JSON.stringify(event);
    const res = await this.post(body, this.sign(body));
    return { queued, eventId: event.event_id, status: res.status, body: res.json };
  }

  /**
   * Sends the queued notifications (all, or those `only` selects). `drop`
   * loses some for good; `duplicate` sends each twice; `shuffle` sends them
   * in a random (seeded) order. A notification the server did not
   * acknowledge goes back to the queue (Paddle retries it).
   */
  async deliver(opts: {
    only?: (e: QueuedEvent) => boolean;
    drop?: (e: QueuedEvent) => boolean;
    duplicate?: boolean;
    shuffle?: boolean | number;
  } = {}): Promise<DeliveryResult[]> {
    const taken = this.outbox.filter((e) => !opts.only || opts.only(e));
    for (const e of taken) this.outbox.splice(this.outbox.indexOf(e), 1);
    const lost = opts.drop ? taken.filter(opts.drop) : [];
    this.lost.push(...lost);
    let batch = taken.filter((e) => !lost.includes(e));
    if (opts.duplicate) batch = batch.flatMap((e) => [e, e]);
    if (opts.shuffle !== undefined && opts.shuffle !== false) {
      batch = shuffled(batch, typeof opts.shuffle === 'number' ? opts.shuffle : 0x5eed);
    }
    const results: DeliveryResult[] = [];
    const acknowledged = new Set<QueuedEvent>();
    for (const queued of batch) {
      const result = await this.send(queued);
      results.push(result);
      if (result.status >= 200 && result.status < 300) {
        if (!acknowledged.has(queued) && !this.delivered.includes(queued)) this.delivered.push(queued);
        acknowledged.add(queued);
      }
    }
    for (const queued of new Set(batch)) {
      if (!acknowledged.has(queued) && !this.outbox.includes(queued)) this.outbox.push(queued);
    }
    return results;
  }

  /** Delivers until nothing is queued (Paddle's retries included), at most `rounds` times. */
  async deliverAll(opts: Parameters<FakePaddle['deliver']>[0] = {}, rounds = 5): Promise<DeliveryResult[]> {
    const all: DeliveryResult[] = [];
    for (let i = 0; i < rounds && this.outbox.some((e) => !opts.only || opts.only(e)); i += 1) {
      all.push(...(await this.deliver(opts)));
    }
    return all;
  }

  /**
   * Sends every notification the server already acknowledged once more:
   * Paddle's redelivery (same event ids), or `freshIds` (the same payloads
   * as new notifications, as several events about one object are).
   */
  async replay(opts: { shuffle?: boolean | number; duplicate?: boolean; freshIds?: boolean } = {}): Promise<DeliveryResult[]> {
    let batch: QueuedEvent[] = [...this.delivered];
    if (opts.duplicate) batch = batch.flatMap((e) => [e, e]);
    if (opts.shuffle !== undefined && opts.shuffle !== false) batch = shuffled(batch, typeof opts.shuffle === 'number' ? opts.shuffle : 0xbeef);
    const results: DeliveryResult[] = [];
    let n = 0;
    for (const queued of batch) {
      n += 1;
      results.push(await this.send(queued, opts.freshIds ? `${queued.event.event_id}_replay${n}` : undefined));
    }
    return results;
  }

  // ─── Checkouts ─────────────────────────────────────────────────────────

  private buildPrice(raw: unknown, currencyFallback: string, opts: { recurring: 'required' | 'forbidden' | 'any' }): FakePrice {
    if (!isRecord(raw)) throw new PaddleRefusal(400, 'invalid_field', 'price is required');
    const unit = isRecord(raw.unit_price) ? raw.unit_price : null;
    const amount = minorOf(unit?.amount);
    if (amount === null || amount < 0) throw new PaddleRefusal(400, 'invalid_field', 'unit_price.amount must be a whole number of minor units');
    const currency = typeof unit?.currency_code === 'string' ? unit.currency_code : currencyFallback;
    if (!['USD', 'EUR', 'GBP', 'TRY'].includes(currency)) throw new PaddleRefusal(400, 'invalid_field', `currency ${currency} is not supported`);
    let cycle: BillingCycle | null = null;
    if (raw.billing_cycle !== undefined && raw.billing_cycle !== null) {
      const c = isRecord(raw.billing_cycle) ? raw.billing_cycle : {};
      if ((c.interval !== 'month' && c.interval !== 'year') || !Number.isInteger(c.frequency) || Number(c.frequency) < 1) {
        throw new PaddleRefusal(400, 'invalid_field', 'billing_cycle is not valid');
      }
      cycle = { interval: c.interval, frequency: Number(c.frequency) };
    }
    if (opts.recurring === 'required' && !cycle) throw new PaddleRefusal(400, 'invalid_field', 'subscription items must recur');
    if (opts.recurring === 'forbidden' && cycle) throw new PaddleRefusal(400, 'invalid_field', 'a one-time charge cannot recur');
    const name = typeof raw.name === 'string' ? raw.name : '';
    const description = typeof raw.description === 'string' ? raw.description : '';
    if (!description) throw new PaddleRefusal(400, 'invalid_field', 'price.description is required');
    const product = isRecord(raw.product) ? raw.product : null;
    const productId = typeof raw.product_id === 'string' && raw.product_id
      ? raw.product_id
      : product ? this.id('pro') : '';
    if (!productId) throw new PaddleRefusal(400, 'invalid_field', 'product_id or product is required');
    if (raw.tax_mode !== undefined && !['internal', 'external', 'account_setting', 'location'].includes(String(raw.tax_mode))) {
      throw new PaddleRefusal(400, 'invalid_field', 'tax_mode is not valid');
    }
    return {
      id: this.id('pri'),
      product_id: productId,
      name,
      description,
      type: 'custom',
      unit_price: { amount: String(amount), currency_code: currency },
      billing_cycle: cycle,
      tax_mode: typeof raw.tax_mode === 'string' ? raw.tax_mode : 'account_setting',
      custom_data: isRecord(raw.custom_data) ? clone(raw.custom_data) : null,
      status: 'active',
    };
  }

  private itemsTotal(items: Array<{ price: FakePrice; quantity: number }>): number {
    return items.reduce((sum, item) => sum + Number(item.price.unit_price.amount) * item.quantity, 0);
  }

  /** POST /transactions: a checkout Paddle.js will open (`foreign`: another installation's). */
  private createCheckout(body: Json, foreign = false): FakeTransaction {
    const currency = typeof body.currency_code === 'string' ? body.currency_code : 'USD';
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw new PaddleRefusal(400, 'invalid_field', 'items is required');
    const items = rawItems.map((item) => {
      const record = isRecord(item) ? item : {};
      const quantity = Number(record.quantity ?? 1);
      return { price: this.buildPrice(record.price, currency, { recurring: 'any' }), quantity, proration: null };
    });
    if (items.some((i) => i.price.unit_price.currency_code !== currency)) throw new PaddleRefusal(400, 'invalid_field', 'mixed currencies');
    const customerId = typeof body.customer_id === 'string' ? body.customer_id : null;
    if (customerId && !this.customers.has(customerId)) throw new PaddleRefusal(404, 'entity_not_found', 'Customer not found');
    const now = new Date().toISOString();
    const txn: FakeTransaction = {
      id: this.id('txn'),
      status: 'ready',
      customer_id: customerId,
      address_id: null,
      business_id: null,
      custom_data: isRecord(body.custom_data) ? clone(body.custom_data) : null,
      currency_code: currency,
      origin: 'api',
      subscription_id: null,
      invoice_id: null,
      invoice_number: null,
      collection_mode: 'automatic',
      billing_details: null,
      billing_period: null,
      items,
      details: { totals: totalsOf(this.itemsTotal(items), currency), line_items: [] },
      payments: [],
      checkout: { url: null },
      created_at: now,
      updated_at: now,
      billed_at: null,
    };
    this.transactions.set(txn.id, txn);
    // What it is about: the workspace our checkout was made for (another
    // installation's checkout is nobody's here, whatever it names).
    const ws = txn.custom_data && typeof txn.custom_data.workspace_id === 'string' ? txn.custom_data.workspace_id : null;
    Object.assign(this.tmeta(txn.id), { workspaceId: foreign ? null : ws, foreign });
    this.emitTxn('transaction.created', txn);
    return clone(txn);
  }

  /** PATCH /transactions/:id: only closing an unpaid checkout ({status: 'canceled'}). */
  private patchTransaction(txn: FakeTransaction, body: Json): FakeTransaction {
    if (body.status !== 'canceled' || Object.keys(body).length !== 1) throw new PaddleRefusal(400, 'invalid_field', 'only status: canceled is supported');
    if (this.tmeta(txn.id).refuseClose) throw new PaddleRefusal(400, 'transaction_cannot_be_canceled', 'This transaction cannot be canceled');
    if (txn.status !== 'draft' && txn.status !== 'ready') {
      throw new PaddleRefusal(400, 'transaction_immutable', `A ${txn.status} transaction cannot be changed`);
    }
    txn.status = 'canceled';
    txn.updated_at = new Date().toISOString();
    this.emitTxn('transaction.canceled', txn);
    return clone(txn);
  }

  private listTransactions(query: URLSearchParams): FakeTransaction[] {
    const subId = query.get('subscription_id');
    const perPage = Math.min(30, Math.max(1, Number(query.get('per_page') ?? 30)));
    const newestFirst = (query.get('order_by') ?? '').includes('[DESC]');
    const rows = [...this.transactions.values()]
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => !subId || t.subscription_id === subId)
      .sort((a, b) => (Date.parse(a.t.created_at) - Date.parse(b.t.created_at)) || (a.index - b.index));
    if (newestFirst) rows.reverse();
    return rows.slice(0, perPage).map(({ t }) => clone(t));
  }

  private capture(txn: FakeTransaction, card: FakeCard, amount: number): void {
    const now = new Date().toISOString();
    txn.payments.unshift({
      payment_attempt_id: crypto.randomUUID(),
      stored_payment_method_id: crypto.randomUUID(),
      amount: String(amount),
      status: 'captured',
      error_code: null,
      method_details: { type: 'card', card: clone(card) },
      created_at: now,
      captured_at: now,
    });
  }

  private decline(txn: FakeTransaction, card: FakeCard, amount: number, code: string): void {
    txn.payments.unshift({
      payment_attempt_id: crypto.randomUUID(),
      stored_payment_method_id: crypto.randomUUID(),
      amount: String(amount),
      status: 'error',
      error_code: code,
      method_details: { type: 'card', card: clone(card) },
      created_at: new Date().toISOString(),
      captured_at: null,
    });
  }

  /**
   * The customer pays a transaction in Paddle.js: a checkout (a recurring
   * price creates the subscription that holds the card, with the checkout's
   * custom_data), a past_due renewal (the subscription is active again), or
   * the card-change transaction (the subscription's card is replaced).
   */
  completeCheckout(txnId: string, opts: { card?: FakeCard } = {}): { transaction: FakeTransaction; subscription: FakeSubscription | null } {
    const txn = this.transactions.get(txnId);
    if (!txn) throw new Error(`fake Paddle: no transaction ${txnId}`);
    const card = opts.card ?? VISA_4242;
    const now = new Date().toISOString();
    const amount = minorOf(txn.details.totals.grand_total) ?? 0;

    if (txn.origin === 'subscription_recurring' || txn.origin === 'subscription_payment_method_change') {
      const sub = txn.subscription_id ? this.subscriptions.get(txn.subscription_id) ?? null : null;
      if (!['past_due', 'billed', 'ready', 'draft'].includes(txn.status)) throw new Error(`fake Paddle: ${txn.id} is ${txn.status}`);
      this.capture(txn, card, amount);
      Object.assign(txn, { status: 'paid', billed_at: txn.billed_at ?? now, updated_at: now });
      this.emitTxn('transaction.paid', txn);
      Object.assign(txn, { status: 'completed', updated_at: now });
      this.emitTxn('transaction.completed', txn);
      if (sub) {
        this.meta(sub.id).card = clone(card);
        if (sub.status === 'past_due' && txn.origin === 'subscription_recurring') {
          Object.assign(sub, { status: 'active', updated_at: now });
          this.emitSub('subscription.updated', sub);
        }
      }
      return { transaction: clone(txn), subscription: sub ? clone(sub) : null };
    }

    if (txn.status !== 'ready' && txn.status !== 'draft') throw new Error(`fake Paddle: checkout ${txn.id} is ${txn.status}`);
    let customerId = txn.customer_id;
    if (!customerId) {
      customerId = this.id('ctm');
      this.customers.set(customerId, { id: customerId, email: `${customerId}@customers.example.test` });
    }
    this.capture(txn, card, amount);
    Object.assign(txn, { status: 'paid', customer_id: customerId, billed_at: now, updated_at: now });
    // Paddle's paid notification for a checkout comes before the subscription exists.
    this.emitTxn('transaction.paid', txn);

    let sub: FakeSubscription | null = null;
    const recurring = txn.items.find((i) => i.price.billing_cycle);
    if (recurring?.price.billing_cycle) {
      const cycle = recurring.price.billing_cycle;
      const end = addCycle(now, cycle);
      sub = {
        id: this.id('sub'),
        status: 'active',
        customer_id: customerId,
        address_id: null,
        business_id: null,
        currency_code: txn.currency_code,
        created_at: now,
        updated_at: now,
        started_at: now,
        first_billed_at: now,
        next_billed_at: end,
        paused_at: null,
        canceled_at: null,
        collection_mode: 'automatic',
        billing_details: null,
        current_billing_period: { starts_at: now, ends_at: end },
        billing_cycle: clone(cycle),
        scheduled_change: null,
        items: txn.items.filter((i) => i.price.billing_cycle).map((i) => ({
          status: 'active' as const,
          quantity: i.quantity,
          recurring: true,
          created_at: now,
          updated_at: now,
          previously_billed_at: now,
          next_billed_at: end,
          price: clone(i.price),
          product: { id: i.price.product_id, name: i.price.name },
        })),
        // Paddle copies the checkout's custom_data onto the subscription.
        custom_data: txn.custom_data ? clone(txn.custom_data) : null,
        discount: null,
        import_meta: null,
        management_urls: { update_payment_method: 'https://sandbox-customer-portal.paddle.com/pm', cancel: 'https://sandbox-customer-portal.paddle.com/cancel' },
      };
      this.subscriptions.set(sub.id, sub);
      const tm = this.tmeta(txn.id);
      Object.assign(this.meta(sub.id), { workspaceId: tm.workspaceId, foreign: tm.foreign, card: clone(card) });
      txn.subscription_id = sub.id;
      txn.billing_period = { starts_at: now, ends_at: end };
      this.emitSub('subscription.created', sub, { transaction_id: txn.id });
      this.emitSub('subscription.activated', sub);
    }
    Object.assign(txn, { status: 'completed', updated_at: now });
    this.emitTxn('transaction.completed', txn);
    return { transaction: clone(txn), subscription: sub ? clone(sub) : null };
  }

  /**
   * A subscription another installation made on the same Paddle account (a
   * clone of this database names the same workspace ids): its checkout,
   * paid, with whatever custom_data it carries.
   */
  foreignSubscription(customData: Json, opts: { amountMinor?: number; interval?: 'month' | 'year' } = {}): FakeSubscription {
    const txn = this.createCheckout({
      currency_code: 'USD',
      custom_data: customData,
      items: [{
        quantity: 1,
        price: {
          name: 'Elsewhere', description: 'Elsewhere',
          unit_price: { amount: String(opts.amountMinor ?? 2900), currency_code: 'USD' },
          billing_cycle: { interval: opts.interval ?? 'month', frequency: 1 },
          tax_mode: 'internal', product: { name: 'Elsewhere', tax_category: 'standard' },
          custom_data: { plan_id: crypto.randomUUID(), interval: 'monthly', net_minor: opts.amountMinor ?? 2900, tax_minor: 0 },
        },
      }],
    }, true);
    const { subscription } = this.completeCheckout(txn.id);
    if (!subscription) throw new Error('fake Paddle: foreign checkout made no subscription');
    return subscription;
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  private lockedAt(sub: FakeSubscription, now: number): boolean {
    if (sub.status !== 'active' || !sub.next_billed_at) return false;
    const next = Date.parse(sub.next_billed_at);
    return now >= next - LOCK_MS && now < next;
  }

  private assertChangeable(sub: FakeSubscription): void {
    if (sub.status === 'canceled') throw new PaddleRefusal(400, 'subscription_update_when_canceled', 'The subscription is canceled');
    if (sub.status === 'past_due') throw new PaddleRefusal(400, 'subscription_update_when_past_due', 'The subscription is past due');
    if (this.lockedAt(sub, Date.now())) throw new PaddleRefusal(409, 'subscription_locked_renewal', 'The subscription renews within 30 minutes');
  }

  /** PATCH /subscriptions/:id (and its preview). */
  private updateSubscription(sub: FakeSubscription, body: Json, preview: boolean): Json {
    for (const field of Object.keys(body)) {
      if (!PATCH_FIELDS.has(field)) throw new PaddleRefusal(400, 'invalid_field', `${field} cannot be updated`);
    }
    if (sub.status === 'paused' && Object.keys(body).some((f) => f !== 'items' && f !== 'proration_billing_mode')) {
      throw new PaddleRefusal(400, 'subscription_update_when_paused', 'Only items can be changed while paused');
    }
    this.assertChangeable(sub);
    if ('scheduled_change' in body && body.scheduled_change !== null) {
      throw new PaddleRefusal(400, 'invalid_field', 'scheduled_change can only be set to null');
    }
    const mode = body.proration_billing_mode;
    if (mode !== undefined && !BILLING_MODES.has(String(mode))) throw new PaddleRefusal(400, 'invalid_field', 'proration_billing_mode is not valid');
    if ((body.items !== undefined || body.next_billed_at !== undefined) && mode === undefined) {
      throw new PaddleRefusal(400, 'invalid_field', 'proration_billing_mode is required when items or next_billed_at change');
    }
    const now = new Date().toISOString();
    const next: FakeSubscription = clone(sub);
    if ('scheduled_change' in body) {
      if (next.scheduled_change?.action === 'cancel' && next.current_billing_period) next.next_billed_at = next.current_billing_period.ends_at;
      next.scheduled_change = null;
    }
    if ('custom_data' in body) {
      if (body.custom_data !== null && !isRecord(body.custom_data)) throw new PaddleRefusal(400, 'invalid_field', 'custom_data must be an object');
      const meta = this.meta(sub.id);
      next.custom_data = body.custom_data === null
        ? null
        : meta.mergeCustomData ? { ...(next.custom_data ?? {}), ...clone(body.custom_data as Json) } : clone(body.custom_data as Json);
    }
    if (body.items !== undefined) {
      const raw = Array.isArray(body.items) ? body.items : [];
      if (!raw.length) throw new PaddleRefusal(400, 'invalid_field', 'a subscription needs at least one item');
      const items = raw.map((item) => {
        const record = isRecord(item) ? item : {};
        if (typeof record.price_id === 'string') {
          const known = sub.items.find((i) => i.price.id === record.price_id);
          if (!known) throw new PaddleRefusal(404, 'entity_not_found', 'Price not found');
          return { ...clone(known), quantity: Number(record.quantity ?? known.quantity) };
        }
        const price = this.buildPrice(record.price, sub.currency_code, { recurring: 'required' });
        if (price.unit_price.currency_code !== sub.currency_code) {
          throw new PaddleRefusal(400, 'invalid_field', 'items must be in the subscription currency');
        }
        return {
          status: 'active' as const, quantity: Number(record.quantity ?? 1), recurring: true, created_at: now, updated_at: now,
          previously_billed_at: null, next_billed_at: next.next_billed_at, price, product: { id: price.product_id, name: price.name },
        };
      });
      const cycles = new Set(items.map((i) => `${i.price.billing_cycle?.interval}:${i.price.billing_cycle?.frequency}`));
      if (cycles.size !== 1) throw new PaddleRefusal(400, 'invalid_field', 'every item must share one billing cycle');
      next.items = items;
      next.billing_cycle = clone(items[0].price.billing_cycle as BillingCycle);
    }
    if (body.next_billed_at !== undefined) {
      const at = typeof body.next_billed_at === 'string' ? Date.parse(body.next_billed_at) : Number.NaN;
      if (!Number.isFinite(at) || at <= Date.now()) throw new PaddleRefusal(400, 'invalid_field', 'next_billed_at must be a time in the future');
      next.next_billed_at = iso(at);
      // Moving the date moves the end of the current billing period with it.
      if (next.current_billing_period) next.current_billing_period.ends_at = iso(at);
      for (const item of next.items) item.next_billed_at = iso(at);
    }
    next.updated_at = now;

    // What this update bills now (only a billing mode other than do_not_bill does).
    const oldAmount = this.itemsTotal(sub.items);
    const newAmount = this.itemsTotal(next.items);
    let immediate = 0;
    const changesBilling = body.items !== undefined || body.next_billed_at !== undefined;
    if (changesBilling && (mode === 'full_immediately' || mode === 'prorated_immediately')) {
      if (mode === 'full_immediately') immediate = body.items !== undefined ? newAmount : 0;
      else {
        const period = sub.current_billing_period;
        const left = period ? Math.max(0, Date.parse(period.ends_at) - Date.now()) / Math.max(1, Date.parse(period.ends_at) - Date.parse(period.starts_at)) : 0;
        immediate = Math.max(0, Math.round((newAmount - oldAmount) * left));
      }
    }
    const nextPeriodStart = next.next_billed_at ?? next.current_billing_period?.ends_at ?? now;
    const answer: Json = {
      ...(clone(next) as unknown as Json),
      immediate_transaction: immediate > 0
        ? { billing_period: next.current_billing_period, details: { totals: totalsOf(immediate, sub.currency_code) }, items: clone(next.items.map((i) => ({ price: i.price, quantity: i.quantity }))) }
        : null,
      next_transaction: next.status === 'active' && next.next_billed_at
        ? {
            billing_period: { starts_at: nextPeriodStart, ends_at: addCycle(nextPeriodStart, next.billing_cycle) },
            details: { totals: totalsOf(newAmount, sub.currency_code) },
          }
        : null,
      recurring_transaction_details: { totals: totalsOf(newAmount, sub.currency_code) },
      update_summary: changesBilling && mode !== 'do_not_bill'
        ? {
            credit: { amount: '0', currency_code: sub.currency_code },
            charge: { amount: String(immediate), currency_code: sub.currency_code },
            result: { action: 'charge', amount: String(immediate), currency_code: sub.currency_code },
          }
        : null,
    };
    if (preview) return answer;

    Object.assign(sub, next);
    if (immediate > 0) this.billUpdate(sub, immediate, now);
    this.emitSub('subscription.updated', sub);
    return clone(sub) as unknown as Json;
  }

  /** An update that bills (a mode other than do_not_bill): Paddle charges the card now. */
  private billUpdate(sub: FakeSubscription, amount: number, now: string): void {
    const txn = this.newSubscriptionTransaction(sub, 'subscription_update', sub.items.map((i) => ({ price: clone(i.price), quantity: i.quantity, proration: null })), now);
    txn.details.totals = totalsOf(amount, sub.currency_code);
    this.emitTxn('transaction.created', txn);
    this.capture(txn, this.meta(sub.id).card, amount);
    Object.assign(txn, { status: 'paid', billed_at: now });
    this.emitTxn('transaction.paid', txn);
    txn.status = 'completed';
    this.emitTxn('transaction.completed', txn);
  }

  private newSubscriptionTransaction(
    sub: FakeSubscription,
    origin: FakeOrigin,
    items: FakeTransaction['items'],
    now: string,
    period: FakeTransaction['billing_period'] = null,
  ): FakeTransaction {
    const meta = this.meta(sub.id);
    const txn: FakeTransaction = {
      id: this.id('txn'),
      status: 'billed',
      customer_id: sub.customer_id,
      address_id: null,
      business_id: null,
      // Paddle copies the subscription's custom_data onto every transaction it makes from it.
      custom_data: sub.custom_data ? clone(sub.custom_data) : null,
      currency_code: sub.currency_code,
      origin,
      subscription_id: sub.id,
      invoice_id: null,
      invoice_number: null,
      collection_mode: 'automatic',
      billing_details: null,
      billing_period: period,
      items,
      details: { totals: totalsOf(this.itemsTotal(items), sub.currency_code), line_items: [] },
      payments: [],
      checkout: null,
      created_at: now,
      updated_at: now,
      billed_at: now,
    };
    this.transactions.set(txn.id, txn);
    Object.assign(this.tmeta(txn.id), { workspaceId: meta.workspaceId, foreign: meta.foreign });
    return txn;
  }

  /** POST /subscriptions/:id/cancel. */
  private cancelSubscription(sub: FakeSubscription, body: Json): FakeSubscription {
    const from = body.effective_from ?? 'next_billing_period';
    if (from !== 'immediately' && from !== 'next_billing_period') throw new PaddleRefusal(400, 'invalid_field', 'effective_from is not valid');
    if (sub.status === 'canceled') throw new PaddleRefusal(400, 'subscription_update_when_canceled', 'The subscription is canceled');
    if (this.lockedAt(sub, Date.now())) throw new PaddleRefusal(409, 'subscription_locked_renewal', 'The subscription renews within 30 minutes');
    if (from === 'immediately') this.cancelNow(sub);
    else this.scheduleCancel(sub);
    return clone(sub);
  }

  private cancelNow(sub: FakeSubscription, at = new Date().toISOString()): void {
    Object.assign(sub, { status: 'canceled', canceled_at: at, next_billed_at: null, current_billing_period: null, scheduled_change: null, updated_at: at });
    for (const item of sub.items) item.next_billed_at = null;
    // Cancelling ends the subscription's open (past_due) transactions, and Paddle's retries with them.
    for (const txn of this.transactions.values()) {
      if (txn.subscription_id === sub.id && (txn.status === 'past_due' || txn.status === 'billed')) {
        Object.assign(txn, { status: 'canceled', updated_at: at });
        this.emitTxn('transaction.canceled', txn);
      }
    }
    this.emitSub('subscription.canceled', sub);
  }

  private scheduleCancel(sub: FakeSubscription): void {
    const effective = sub.current_billing_period?.ends_at ?? sub.next_billed_at ?? new Date().toISOString();
    Object.assign(sub, {
      scheduled_change: { action: 'cancel', effective_at: effective, resume_at: null },
      next_billed_at: null,
      updated_at: new Date().toISOString(),
    });
    for (const item of sub.items) item.next_billed_at = null;
    this.emitSub('subscription.updated', sub);
  }

  /** POST /subscriptions/:id/charge (and its preview): a one-time charge. */
  private charge(sub: FakeSubscription, body: Json, preview: boolean): Json {
    if (sub.status === 'canceled') throw new PaddleRefusal(400, 'subscription_update_when_canceled', 'The subscription is canceled');
    if (sub.status === 'past_due') throw new PaddleRefusal(400, 'subscription_update_when_past_due', 'The subscription is past due');
    if (sub.status !== 'active') throw new PaddleRefusal(400, 'subscription_not_active', 'The subscription is not active');
    if (this.lockedAt(sub, Date.now())) throw new PaddleRefusal(409, 'subscription_locked_renewal', 'The subscription renews within 30 minutes');
    for (const field of Object.keys(body)) {
      if (!['effective_from', 'items', 'on_payment_failure'].includes(field)) throw new PaddleRefusal(400, 'invalid_field', `${field} is not a charge field`);
    }
    const from = body.effective_from;
    if (from !== 'immediately' && from !== 'next_billing_period') throw new PaddleRefusal(400, 'invalid_field', 'effective_from is required');
    const onFailure = body.on_payment_failure ?? 'prevent_change';
    if (onFailure !== 'prevent_change' && onFailure !== 'apply_change') throw new PaddleRefusal(400, 'invalid_field', 'on_payment_failure is not valid');
    const raw = Array.isArray(body.items) ? body.items : [];
    if (!raw.length) throw new PaddleRefusal(400, 'invalid_field', 'items is required');
    const items = raw.map((item) => {
      const record = isRecord(item) ? item : {};
      const price = this.buildPrice(record.price, sub.currency_code, { recurring: 'forbidden' });
      if (price.unit_price.currency_code !== sub.currency_code) throw new PaddleRefusal(400, 'invalid_field', 'items must be in the subscription currency');
      return { price, quantity: Number(record.quantity ?? 1), proration: null };
    });
    const amount = this.itemsTotal(items);
    if (amount < MIN_CHARGE_MINOR) {
      throw new PaddleRefusal(400, 'subscription_update_transaction_balance_less_than_charge_limit', 'The charge is below the minimum');
    }
    const now = new Date().toISOString();
    if (preview) {
      return {
        ...(clone(sub) as unknown as Json),
        immediate_transaction: from === 'immediately'
          ? { billing_period: sub.current_billing_period, details: { totals: totalsOf(amount, sub.currency_code) }, items: clone(items) }
          : null,
        next_transaction: null,
        update_summary: {
          credit: { amount: '0', currency_code: sub.currency_code },
          charge: { amount: String(amount), currency_code: sub.currency_code },
          result: { action: 'charge', amount: String(amount), currency_code: sub.currency_code },
        },
      };
    }
    if (from !== 'immediately') throw new PaddleRefusal(400, 'invalid_field', 'the fake charges immediately only');
    const meta = this.meta(sub.id);
    meta.chargesAt = meta.chargesAt.filter((t) => Date.now() - t < 60 * 60 * 1000);
    if (meta.chargesAt.length >= CHARGES_PER_HOUR) {
      throw new PaddleRefusal(429, 'subscription_immediate_charge_hour_limit_exceeded', 'Too many charges this hour');
    }
    meta.chargesAt.push(Date.now());
    const txn = this.newSubscriptionTransaction(sub, 'subscription_charge', items, now, sub.current_billing_period ? clone(sub.current_billing_period) : null);
    this.emitTxn('transaction.created', txn);
    if (meta.declineNext) {
      const code = meta.declineNext;
      meta.declineNext = null;
      this.decline(txn, meta.card, amount, code);
      this.emitTxn('transaction.payment_failed', txn);
      // prevent_change: nothing applies; the attempt ends.
      Object.assign(txn, { status: 'canceled', updated_at: now });
      this.emitTxn('transaction.canceled', txn);
      throw new PaddleRefusal(400, 'subscription_payment_declined', 'The payment was declined');
    }
    this.capture(txn, meta.card, amount);
    Object.assign(txn, { status: 'paid', updated_at: now });
    this.emitTxn('transaction.paid', txn);
    txn.status = 'completed';
    this.emitTxn('transaction.completed', txn);
    return clone(sub) as unknown as Json;
  }

  /** GET /subscriptions/:id/update-payment-method-transaction. */
  private updatePaymentMethodTransaction(sub: FakeSubscription): FakeTransaction {
    if (sub.status === 'canceled') throw new PaddleRefusal(400, 'subscription_update_when_canceled', 'The subscription is canceled');
    if (sub.status === 'past_due') {
      const due = [...this.transactions.values()].filter((t) => t.subscription_id === sub.id && t.status === 'past_due').at(-1);
      if (due) return clone(due);
    }
    const now = new Date().toISOString();
    const txn = this.newSubscriptionTransaction(sub, 'subscription_payment_method_change', [], now);
    Object.assign(txn, { status: 'ready', billed_at: null, details: { totals: totalsOf(0, sub.currency_code), line_items: [] } });
    this.emitTxn('transaction.created', txn);
    return clone(txn);
  }

  // ─── Paddle's own clock ────────────────────────────────────────────────

  /**
   * Paddle renews the subscription now (its next_billed_at has come): the
   * period moves on one cycle, then the renewal transaction (origin
   * subscription_recurring, its items and custom_data copied from the
   * subscription) is charged to the card: paid, or declined (the
   * subscription past_due), or left billed (`collect: false`, collected
   * later). `grandTotalMinor` charges another amount than the items (Paddle
   * credit applied).
   */
  renew(subId: string, opts: { decline?: string; collect?: boolean; grandTotalMinor?: number } = {}): FakeTransaction | null {
    const sub = this.subscriptions.get(subId);
    if (!sub || sub.status !== 'active' || !sub.next_billed_at) return null;
    const meta = this.meta(sub.id);
    const now = new Date().toISOString();
    const start = sub.next_billed_at;
    const end = addCycle(start, sub.billing_cycle);
    Object.assign(sub, { current_billing_period: { starts_at: start, ends_at: end }, next_billed_at: end, updated_at: now });
    for (const item of sub.items) Object.assign(item, { previously_billed_at: start, next_billed_at: end });
    // Paddle moves the dates before it collects.
    this.emitSub('subscription.updated', sub);
    const items = sub.items.map((i) => ({ price: clone(i.price), quantity: i.quantity, proration: null }));
    const txn = this.newSubscriptionTransaction(sub, 'subscription_recurring', items, now, { starts_at: start, ends_at: end });
    const total = this.itemsTotal(items);
    if (opts.grandTotalMinor !== undefined) txn.details.totals = totalsOf(total, sub.currency_code, total - opts.grandTotalMinor);
    this.emitTxn('transaction.created', txn);
    this.emitTxn('transaction.billed', txn);
    const decline = opts.decline ?? meta.declineNext;
    if (decline) {
      meta.declineNext = null;
      this.decline(txn, meta.card, minorOf(txn.details.totals.grand_total) ?? total, decline);
      this.emitTxn('transaction.payment_failed', txn);
      Object.assign(txn, { status: 'past_due', updated_at: now });
      this.emitTxn('transaction.past_due', txn);
      Object.assign(sub, { status: 'past_due', updated_at: now });
      this.emitSub('subscription.past_due', sub);
      return clone(txn);
    }
    if (opts.collect !== false) this.collect(txn.id);
    return clone(this.transactions.get(txn.id) as FakeTransaction);
  }

  /** A billed renewal (or charge) is collected from the subscription's card. */
  collect(txnId: string): void {
    const txn = this.transactions.get(txnId);
    if (!txn || txn.status !== 'billed') throw new Error(`fake Paddle: ${txnId} is not billed`);
    const sub = txn.subscription_id ? this.subscriptions.get(txn.subscription_id) : null;
    const now = new Date().toISOString();
    this.capture(txn, sub ? this.meta(sub.id).card : VISA_4242, minorOf(txn.details.totals.grand_total) ?? 0);
    Object.assign(txn, { status: 'paid', updated_at: now });
    this.emitTxn('transaction.paid', txn);
    Object.assign(txn, { status: 'completed', updated_at: now });
    this.emitTxn('transaction.completed', txn);
  }

  /**
   * Does what Paddle's clock does by `now`: renewals whose next_billed_at has
   * come (each moves the period one cycle; a long gap renews more than once),
   * scheduled cancels that took effect. Returns how many things happened.
   */
  runClock(now = Date.now()): number {
    let done = 0;
    for (const sub of this.subscriptions.values()) {
      for (let guard = 0; guard < 24; guard += 1) {
        if (sub.status !== 'active') break;
        const cancelAt = sub.scheduled_change?.action === 'cancel' ? Date.parse(sub.scheduled_change.effective_at) : Number.NaN;
        if (Number.isFinite(cancelAt)) {
          if (cancelAt > now) break;
          this.cancelNow(sub, iso(cancelAt));
          done += 1;
          break;
        }
        if (!sub.next_billed_at || Date.parse(sub.next_billed_at) > now) break;
        this.renew(sub.id);
        done += 1;
      }
    }
    return done;
  }

  /**
   * Time passes for one workspace's Paddle objects: every date they hold
   * moves `ms` into the past (with the database's, the world moved on).
   * Then call runClock.
   */
  shift(workspaceId: string, ms: number): void {
    for (const [id, sub] of this.subscriptions) {
      if (this.meta(id).workspaceId !== workspaceId) continue;
      for (const key of ['created_at', 'updated_at', 'started_at', 'first_billed_at', 'next_billed_at', 'canceled_at'] as const) {
        (sub as unknown as Record<string, string | null>)[key] = shiftIso(sub[key], ms);
      }
      if (sub.current_billing_period) {
        sub.current_billing_period = {
          starts_at: shiftIso(sub.current_billing_period.starts_at, ms) as string,
          ends_at: shiftIso(sub.current_billing_period.ends_at, ms) as string,
        };
      }
      if (sub.scheduled_change) sub.scheduled_change.effective_at = shiftIso(sub.scheduled_change.effective_at, ms) as string;
      for (const item of sub.items) {
        item.created_at = shiftIso(item.created_at, ms) as string;
        item.updated_at = shiftIso(item.updated_at, ms) as string;
        item.previously_billed_at = shiftIso(item.previously_billed_at, ms);
        item.next_billed_at = shiftIso(item.next_billed_at, ms);
      }
    }
    for (const [id, txn] of this.transactions) {
      if (this.tmeta(id).workspaceId !== workspaceId) continue;
      txn.created_at = shiftIso(txn.created_at, ms) as string;
      txn.updated_at = shiftIso(txn.updated_at, ms) as string;
      txn.billed_at = shiftIso(txn.billed_at, ms);
      if (txn.billing_period) {
        txn.billing_period = {
          starts_at: shiftIso(txn.billing_period.starts_at, ms) as string,
          ends_at: shiftIso(txn.billing_period.ends_at, ms) as string,
        };
      }
      for (const p of txn.payments) {
        p.created_at = shiftIso(p.created_at, ms) as string;
        p.captured_at = shiftIso(p.captured_at, ms);
      }
    }
    for (const sub of this.subscriptions.values()) {
      const meta = this.meta(sub.id);
      if (meta.workspaceId === workspaceId) meta.chargesAt = meta.chargesAt.map((t) => t - ms);
    }
  }

  // ─── Test controls ─────────────────────────────────────────────────────

  /**
   * A one-time charge someone made in Paddle's dashboard (not through our
   * API: its item carries no payment id of ours), collected from the card now.
   */
  dashboardCharge(subId: string, amountMinor: number): FakeTransaction {
    const sub = this.subscriptions.get(subId);
    if (!sub || sub.status !== 'active') throw new Error(`fake Paddle: ${subId} cannot be charged`);
    const now = new Date().toISOString();
    const price = this.buildPrice({
      name: 'Manual charge', description: 'Manual charge',
      unit_price: { amount: String(amountMinor), currency_code: sub.currency_code },
      tax_mode: 'internal', product: { name: 'Manual charge', tax_category: 'standard' },
    }, sub.currency_code, { recurring: 'forbidden' });
    const txn = this.newSubscriptionTransaction(sub, 'subscription_charge', [{ price, quantity: 1, proration: null }], now,
      sub.current_billing_period ? clone(sub.current_billing_period) : null);
    this.emitTxn('transaction.created', txn);
    this.collect(txn.id);
    return clone(this.transactions.get(txn.id) as FakeTransaction);
  }

  /** The next charge of this subscription (a renewal or a /charge) is declined with `code`. */
  declineNext(subId: string, code = 'declined'): void {
    this.meta(subId).declineNext = code;
  }

  /** The next /charge of this subscription charges the card, then answers 500 (its outcome unknown to the caller). */
  failAfterCreate(subId: string): void {
    this.meta(subId).failAfterCreate = true;
  }

  /** Paddle refuses to close this checkout (as when it is being paid at that moment). */
  refuseClose(txnId: string): void {
    this.tmeta(txnId).refuseClose = true;
  }

  /** PATCH custom_data merges into the subscription's instead of replacing it. */
  mergeCustomData(subId: string): void {
    this.meta(subId).mergeCustomData = true;
  }

  /** The workspace a subscription was made for (from its checkout's custom_data), or null. */
  workspaceOf(subId: string): string | null {
    return this.subMeta.get(subId)?.workspaceId ?? null;
  }

  isForeign(subId: string): boolean {
    return this.subMeta.get(subId)?.foreign === true;
  }

  /** Whether a transaction came from our checkouts or our subscriptions (not another installation's). */
  isOurs(txnId: string): boolean {
    const meta = this.txnMeta.get(txnId);
    return Boolean(meta && !meta.foreign);
  }

  transactionWorkspace(txnId: string): string | null {
    return this.txnMeta.get(txnId)?.workspaceId ?? null;
  }

  subscriptionsOf(workspaceId: string): FakeSubscription[] {
    return [...this.subscriptions.values()].filter((s) => this.workspaceOf(s.id) === workspaceId);
  }

  transactionsOf(subId: string): FakeTransaction[] {
    return [...this.transactions.values()].filter((t) => t.subscription_id === subId);
  }

  /**
   * A refund (created pending approval, then approved) or a chargeback
   * (approved at once) of a completed transaction, as Paddle's adjustment
   * notifications report them. The whole amount unless `amountMinor`.
   */
  adjust(txnId: string, action: 'refund' | 'chargeback', amountMinor?: number): FakeAdjustment {
    const txn = this.transactions.get(txnId);
    if (!txn || txn.status !== 'completed') throw new Error(`fake Paddle: ${txnId} cannot be adjusted`);
    const full = minorOf(txn.details.totals.grand_total) ?? 0;
    const amount = amountMinor ?? full;
    const now = new Date().toISOString();
    const adj: FakeAdjustment = {
      id: this.id('adj'),
      action,
      transaction_id: txn.id,
      subscription_id: txn.subscription_id,
      customer_id: txn.customer_id,
      reason: action === 'refund' ? 'requested by the customer' : 'dispute lost',
      currency_code: txn.currency_code,
      status: action === 'refund' ? 'pending_approval' : 'approved',
      items: [{ item_id: crypto.randomUUID(), type: amount === full ? 'full' : 'partial', amount: String(amount) }],
      totals: { subtotal: String(amount), tax: '0', total: String(amount), fee: '0', earnings: String(amount), currency_code: txn.currency_code },
      created_at: now,
      updated_at: now,
    };
    this.adjustments.set(adj.id, adj);
    const meta = this.tmeta(txn.id);
    const about = { workspaceId: meta.workspaceId, subscriptionId: txn.subscription_id, transactionId: txn.id, foreign: meta.foreign };
    this.emit('adjustment.created', adj as unknown as Json, about);
    if (action === 'refund') {
      adj.status = 'approved';
      adj.updated_at = new Date().toISOString();
      this.emit('adjustment.updated', adj as unknown as Json, about);
    }
    return clone(adj);
  }

  /**
   * The customer cancels in Paddle's own customer portal: at the end of the
   * billing period (a scheduled cancel), or at once.
   */
  portalCancel(subId: string, opts: { immediately?: boolean } = {}): void {
    const sub = this.subscriptions.get(subId);
    if (!sub || sub.status === 'canceled') throw new Error(`fake Paddle: ${subId} cannot be cancelled`);
    if (opts.immediately) this.cancelNow(sub);
    else this.scheduleCancel(sub);
  }

  // ─── Evidence ──────────────────────────────────────────────────────────

  /**
   * The calls that broke the rules a saved card must keep with Paddle (I5):
   *   - a PATCH /subscriptions/:id that changes items or the date without
   *     do_not_bill, or names any other billing mode;
   *   - a PATCH not preceded by a successful preview of the same body for the
   *     same subscription (no other change to it in between);
   *   - a /charge not preceded by its preview, or a second /charge for one
   *     payment row;
   *   - any transaction Paddle billed because of an update.
   */
  billingViolations(): string[] {
    const out: string[] = [];
    const mutating = (c: PaddleCall) => c.method !== 'GET';
    const chargedFor = new Map<string, number>();
    this.calls.forEach((c, index) => {
      if (!c.subscriptionId) return;
      const base = `/subscriptions/${encodeURIComponent(c.subscriptionId)}`;
      const before = this.calls.slice(0, index).filter((p) => p.subscriptionId === c.subscriptionId && mutating(p)).at(-1);
      const sameBody = (p: PaddleCall | undefined) => JSON.stringify(p?.body ?? null) === JSON.stringify(c.body ?? null);
      if (c.method === 'PATCH' && c.path === base) {
        const body = c.body ?? {};
        const mode = body.proration_billing_mode;
        if ((body.items !== undefined || body.next_billed_at !== undefined) && mode !== 'do_not_bill') {
          out.push(`#${c.seq} PATCH ${c.subscriptionId} changes items/next_billed_at with proration_billing_mode ${String(mode)}`);
        }
        if (mode !== undefined && mode !== 'do_not_bill') out.push(`#${c.seq} PATCH ${c.subscriptionId} names billing mode ${String(mode)}`);
        if (!(before && before.method === 'PATCH' && before.path === `${base}/preview` && before.status === 200 && sameBody(before))) {
          out.push(`#${c.seq} PATCH ${c.subscriptionId} without its preview right before it`);
        }
      }
      if (c.method === 'POST' && c.path === `${base}/charge`) {
        if (!(before && before.method === 'POST' && before.path === `${base}/charge/preview` && before.status === 200 && sameBody(before))) {
          out.push(`#${c.seq} /charge on ${c.subscriptionId} without its preview right before it`);
        }
        const paymentId = this.chargePaymentId(c.body) ?? '-';
        chargedFor.set(paymentId, (chargedFor.get(paymentId) ?? 0) + 1);
      }
    });
    for (const [paymentId, n] of chargedFor) {
      if (n > 1) out.push(`/charge made ${n} times for payment ${paymentId}`);
    }
    for (const txn of this.transactions.values()) {
      if (txn.origin === 'subscription_update' && (minorOf(txn.details.totals.grand_total) ?? 0) > 0) {
        out.push(`transaction ${txn.id} billed by an update of ${txn.subscription_id}`);
      }
    }
    return out;
  }

  /** Calls the fake does not answer (a path Paddle may not have either). */
  unexpectedCalls(): PaddleCall[] {
    return this.calls.filter((c) => c.unexpected);
  }
}

// ─── The guard on outbound requests ──────────────────────────────────────────

export interface OutboundGuard {
  /** Every request that was refused (it would have left this machine). */
  blocked: string[];
  restore(): void;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Answers Paddle's API from `fake` and refuses every other request that
 * would leave this machine (fetch to a non-local host, any https.request).
 */
export function installOutboundGuard(fake: FakePaddle): OutboundGuard {
  const originals = { fetch: globalThis.fetch, https: https.request };
  const blocked: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(fake.api)) return fake.handle(url, init ?? {});
    const host = new URL(url, 'http://localhost').hostname;
    if (!LOCAL_HOSTS.has(host)) {
      blocked.push(url);
      throw new Error(`outbound request refused by the test: ${host}`);
    }
    return originals.fetch(input, init);
  }) as typeof fetch;
  https.request = ((...args: Parameters<typeof https.request>) => {
    blocked.push(String(args[0]));
    throw new Error('outbound https refused by the test');
  }) as typeof https.request;
  return {
    blocked,
    restore() {
      globalThis.fetch = originals.fetch;
      https.request = originals.https;
    },
  };
}
