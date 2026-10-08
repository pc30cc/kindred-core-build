import type {
  BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification, WebhookEvent,
} from '../types.js';
import { majorToMinor, minorToMajorString, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

/** Currencies an order may be priced in (the `billing_plans.prices` keys PayPal settles; no TRY). */
export const PAYPAL_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readPayPalAccessToken(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const token = record.access_token;
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

export function readPayPalOAuthError(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const description = record.error_description;
  if (typeof description === 'string' && description.length > 0) return description;
  return null;
}

/** `message` of a PayPal REST error body (orders, subscriptions, refunds). */
export function readPayPalSubscriptionError(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const message = record.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return null;
}

/** `id` of a created PayPal resource (an order here). */
export function readPayPalSubscriptionId(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return id;
}

/**
 * The link the buyer approves the payment at: `payer-action` for an order
 * created with `payment_source.paypal.experience_context`, `approve` for the
 * older `application_context` shape.
 */
export function readPayPalApprovalUrl(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const links = record.links;
  if (!Array.isArray(links)) return undefined;
  for (const link of links) {
    const entry = asRecord(link);
    if (!entry) continue;
    if (entry.rel !== 'approve' && entry.rel !== 'payer-action') continue;
    return typeof entry.href === 'string' ? entry.href : undefined;
  }
  return undefined;
}

export function readPayPalRefundId(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return id;
}

/** First issue code of a PayPal error body (`details[0].issue`), e.g. ORDER_ALREADY_CAPTURED. */
export function readPayPalIssue(body: unknown): string | undefined {
  const details = asRecord(body)?.details;
  if (!Array.isArray(details)) return undefined;
  return readString(asRecord(details[0]), 'issue');
}

/** The capture of a captured order: `purchase_units[0].payments.captures[0]`. */
export function readPayPalOrderCapture(order: unknown): Record<string, unknown> | null {
  const units = asRecord(order)?.purchase_units;
  if (!Array.isArray(units)) return null;
  const captures = asRecord(asRecord(units[0])?.payments)?.captures;
  return Array.isArray(captures) ? asRecord(captures[0]) : null;
}

/**
 * `custom_id` carries `<workspace id>:<payment intent id>` for orders created
 * by createCheckoutSession, and just the workspace id for legacy subscriptions.
 */
export function parsePayPalCustomId(raw: unknown): { workspaceId?: string; intentId?: string } {
  if (typeof raw !== 'string' || !raw) return {};
  const [workspaceId, intentId] = raw.split(':');
  return { workspaceId: workspaceId || undefined, intentId: intentId || undefined };
}

async function getAccessToken(config: BillingProviderConfig): Promise<string> {
  const res = await fetch(`${baseUrl(config)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(readPayPalOAuthError(data) || 'PayPal auth failed');
  const token = readPayPalAccessToken(data);
  if (!token) throw new Error('PayPal auth failed');
  return token;
}

function withQuery(url: string, pair: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${pair}`;
}

/** A capture as a verification result (amount in minor units of its own currency). */
function captureVerification(orderId: string, capture: Record<string, unknown> | null): PaymentVerification {
  const status = readString(capture, 'status');
  const amount = asRecord(capture?.amount);
  if (status === 'COMPLETED') {
    return {
      verified: true,
      providerRef: orderId,
      amount: majorToMinor(amount?.value),
      currency: normalizeCurrencyCode(amount?.currency_code),
      paymentId: readString(capture, 'id'),
      status: 'paid',
    };
  }
  if (status === 'DECLINED' || status === 'FAILED') return { verified: false, providerRef: orderId, status: 'failed' };
  // PENDING (e.g. an eCheck): money is not there yet; the webhook completes it.
  return { verified: false, providerRef: orderId, status: 'pending' };
}

/** PayPal webhook transmission headers, lower-cased as Express delivers them. */
const TRANSMISSION_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

/**
 * Asks PayPal whether this delivery is genuine (POST
 * /v1/notifications/verify-webhook-signature). The event is spliced in as the
 * exact raw bytes received: PayPal checks a CRC32 of the body it signed, so a
 * re-serialised object could fail verification.
 */
async function verifyPayPalTransmission(
  config: BillingProviderConfig,
  headers: Record<string, string>,
  rawBody: string,
  webhookId: string,
): Promise<boolean> {
  const fields: Record<string, string> = {};
  for (const [field, header] of Object.entries(TRANSMISSION_HEADERS)) {
    const value = headers[header];
    if (!value) return false;
    fields[field] = value;
  }
  const token = await getAccessToken(config);
  const prefix = JSON.stringify({ ...fields, webhook_id: webhookId });
  const body = `${prefix.slice(0, -1)},"webhook_event":${rawBody}}`;
  const res = await fetch(`${baseUrl(config)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  return asRecord(data)?.verification_status === 'SUCCESS';
}

export const paypalProvider: BillingProviderHandler = {
  name: 'paypal',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: true,
  },
  supportedCurrencies: PAYPAL_CURRENCIES,

  /**
   * One PayPal order (Orders v2, intent CAPTURE) for exactly the amount being
   * collected — `metadata.amount` in minor units of `req.currency`, sent as
   * PayPal's decimal `value`. `custom_id` carries workspace and payment
   * intent, so the capture webhook settles exactly that intent. The buyer
   * approves at PayPal and returns with `token=<order id>`; the server then
   * captures (verifyPayment).
   */
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const currency = requireSupportedCurrency('PayPal', req.currency, PAYPAL_CURRENCIES);
    const value = minorToMajorString(req.metadata?.amount);
    if (value === '0') throw new Error('PayPal checkout needs a positive amount');
    const token = await getAccessToken(config);

    const brandName = (typeof config.brand_name === 'string' && config.brand_name.trim())
      || req.metadata?.brand_name
      || undefined;
    const purchaseUnit: Record<string, unknown> = {
      reference_id: req.invoiceId || req.workspaceId,
      custom_id: req.intentId ? `${req.workspaceId}:${req.intentId}` : req.workspaceId,
      amount: { currency_code: currency, value },
    };
    if (req.description) purchaseUnit.description = req.description.slice(0, 127);

    const headers: Record<string, string> = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (req.intentId) headers['PayPal-Request-Id'] = `order-${req.intentId}`;
    const res = await fetch(`${baseUrl(config)}/v2/checkout/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [purchaseUnit],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: req.callbackUrl,
              cancel_url: withQuery(req.callbackUrl, 'canceled=1'),
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              ...(brandName ? { brand_name: String(brandName).slice(0, 127) } : {}),
            },
            ...(req.customerEmail ? { email_address: req.customerEmail } : {}),
          },
        },
      }),
    });
    const data = await res.json();
    // Preserve prior runtime behavior: property access on a null/undefined body threw a TypeError.
    if (data === null || data === undefined) {
      throw new TypeError("Cannot read properties of null (reading 'message')");
    }
    if (!res.ok) throw new Error(readPayPalSubscriptionError(data) || 'PayPal order creation failed');
    const paymentUrl = readPayPalApprovalUrl(data);
    const orderId = readPayPalSubscriptionId(data);
    if (!paymentUrl || !orderId) throw new Error('PayPal order creation failed');
    return { paymentUrl, sessionId: orderId };
  },

  /**
   * Captures the order bound to the intent (`token` is the STORED order id).
   * A capture is idempotent per order (PayPal-Request-Id), and an order that
   * was already captured — by an earlier return or a retry — is read back
   * instead. Only a COMPLETED capture is a payment.
   */
  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
    const orderId = (params.token || '').trim();
    if (!orderId) return { verified: false, providerRef: '', status: 'failed' };
    const token = await getAccessToken(config);
    const orderUrl = `${baseUrl(config)}/v2/checkout/orders/${encodeURIComponent(orderId)}`;
    const auth = { 'Authorization': `Bearer ${token}` };

    const readOrder = async (): Promise<PaymentVerification> => {
      const res = await fetch(orderUrl, { headers: auth });
      if (!res.ok) return { verified: false, providerRef: orderId, status: 'pending' };
      const order = await res.json().catch(() => null);
      return captureVerification(orderId, readPayPalOrderCapture(order));
    };

    if (params.canceled === '1') {
      // The buyer left PayPal without approving: nothing can be captured.
      const current = await readOrder();
      return current.verified ? current : { verified: false, providerRef: orderId, status: 'canceled' };
    }

    const res = await fetch(`${orderUrl}/capture`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'PayPal-Request-Id': `capture-${orderId}` },
      body: '{}',
    });
    const body = await res.json().catch(() => null);
    if (res.ok) return captureVerification(orderId, readPayPalOrderCapture(body));

    const issue = readPayPalIssue(body);
    if (issue === 'ORDER_ALREADY_CAPTURED') return readOrder();
    if (issue === 'ORDER_NOT_APPROVED') return { verified: false, providerRef: orderId, status: 'canceled' };
    if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_ACTION_REQUIRED') {
      return { verified: false, providerRef: orderId, status: 'failed' };
    }
    return { verified: false, providerRef: orderId, status: 'pending' };
  },

  /**
   * Verified through PayPal's own verify-webhook-signature API against the
   * webhook id configured for this app (`webhook_id`). Without that id, or
   * without the transmission headers, nothing is verified.
   */
  async verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const webhookId = typeof config.webhook_id === 'string' ? config.webhook_id.trim() : '';
    if (!webhookId || !headers['paypal-transmission-sig']) return null;
    if (!(await verifyPayPalTransmission(config, headers, body, webhookId))) {
      throw new Error('Invalid PayPal webhook signature');
    }

    const event = JSON.parse(body);
    const resource = asRecord(event?.resource);
    const eventType = typeof event?.event_type === 'string' ? event.event_type : '';
    const amount = asRecord(resource?.amount);
    const base = { providerEventId: event.id, raw: event };

    // Orders v2 captures (createCheckoutSession above).
    if (eventType.startsWith('PAYMENT.CAPTURE.')) {
      const ids = parsePayPalCustomId(resource?.custom_id);
      const related = asRecord(asRecord(resource?.supplementary_data)?.related_ids);
      const capture = {
        ...base,
        ...ids,
        providerRef: readString(related, 'order_id'),
        providerPaymentId: readString(resource, 'id'),
        amount: majorToMinor(amount?.value),
        currency: normalizeCurrencyCode(amount?.currency_code),
      };
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED') return { ...capture, type: 'payment_succeeded' };
      if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.DECLINED') {
        return { ...capture, type: 'payment_failed', status: 'failed' };
      }
      if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
        // The resource is the refund; its `up` link names the capture it refunds.
        const links = Array.isArray(resource?.links) ? resource.links : [];
        const up = links.map(asRecord).find((l) => l?.rel === 'up');
        const captureId = /\/captures\/([^/?]+)/.exec(readString(up ?? null, 'href') || '')?.[1];
        const total = asRecord(asRecord(resource?.seller_payable_breakdown)?.total_refunded_amount);
        return {
          ...capture,
          type: 'refund_processed',
          providerRef: undefined,
          providerPaymentId: captureId || capture.providerPaymentId,
          refundedTotal: majorToMinor(total?.value),
        };
      }
      return { ...capture, type: 'ignored' };
    }

    // Subscriptions API (legacy: this platform no longer creates them).
    const legacyMap: Record<string, WebhookEvent['type']> = {
      'BILLING.SUBSCRIPTION.CREATED': 'subscription_created',
      'BILLING.SUBSCRIPTION.ACTIVATED': 'subscription_updated',
      'BILLING.SUBSCRIPTION.CANCELLED': 'subscription_canceled',
      'BILLING.SUBSCRIPTION.SUSPENDED': 'subscription_updated',
      'PAYMENT.SALE.COMPLETED': 'payment_succeeded',
      'PAYMENT.SALE.DENIED': 'payment_failed',
      'PAYMENT.SALE.REFUNDED': 'refund_processed',
    };
    const mapped = legacyMap[eventType];
    if (!mapped) return { ...base, type: 'ignored' };
    return {
      ...base,
      type: mapped,
      providerSubscriptionId: readString(resource, 'billing_agreement_id') || readString(resource, 'id'),
      providerCustomerId: readString(asRecord(asRecord(resource?.payer)?.payer_info), 'payer_id'),
      workspaceId: parsePayPalCustomId(resource?.custom_id).workspaceId,
      amount: majorToMinor(amount?.total),
      currency: normalizeCurrencyCode(amount?.currency),
    };
  },

  async cancelSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const token = await getAccessToken(config);
    const res = await fetch(`${baseUrl(config)}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer requested cancellation' }),
    });
    return { success: res.status === 204 || res.ok };
  },

  /**
   * Refunds a capture. A partial refund must name the capture's currency
   * (PayPal rejects a mismatch, and guessing USD would mislabel a EUR amount);
   * no amount refunds the whole capture.
   */
  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number, currency?: string) {
    const body: { amount?: { value: string; currency_code: string } } = {};
    if (amount) {
      const code = normalizeCurrencyCode(currency);
      if (!code) throw new Error('PayPal partial refund needs the capture currency');
      body.amount = { value: minorToMajorString(amount), currency_code: code };
    }
    const token = await getAccessToken(config);
    const res = await fetch(`${baseUrl(config)}/v2/payments/captures/${paymentId}/refund`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    // Preserve prior runtime behavior: property access on a null/undefined body threw a TypeError.
    if (data === null || data === undefined) {
      throw new TypeError("Cannot read properties of null (reading 'id')");
    }
    return { success: res.ok, refundId: readPayPalRefundId(data) };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      await getAccessToken(config);
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
