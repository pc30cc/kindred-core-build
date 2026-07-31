import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

// Local, PayTR-specific parsers for the get-token response only.
// They do not touch hashing, callback verification or amount handling.
function readPayTrRecord(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) {
    // Preserve previous runtime behaviour: property access on a nullish body threw.
    throw new TypeError("Cannot read properties of null (reading 'status')");
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function readPayTrCreateStatus(body: Record<string, unknown>): string | undefined {
  const status = body.status;
  return typeof status === 'string' ? status : undefined;
}

function readPayTrCreateToken(body: Record<string, unknown>): string | undefined {
  const token = body.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

function readPayTrCreateError(body: Record<string, unknown>): string | undefined {
  const reason = body.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

export const paytrProvider: BillingProviderHandler = {
  name: 'paytr',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const merchantId = config.merchant_id as string;
    const merchantKey = config.merchant_key as string;
    const merchantSalt = config.merchant_salt as string;
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const orderId = `${req.workspaceId}_${Date.now()}`;
    const userIp = req.metadata?.ip || '127.0.0.1';
    const email = req.customerEmail || 'user@example.com';

    // PayTR hash
    const basketJson = Buffer.from(JSON.stringify([[`Plan ${req.planId}`, String(amount), 1]])).toString('base64');
    const hashStr = `${merchantId}${userIp}${orderId}${email}${amount}subscription${0}TRY${0}${merchantSalt}`;
    const token = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');

    const params = new URLSearchParams();
    params.set('merchant_id', merchantId);
    params.set('user_ip', userIp);
    params.set('merchant_oid', orderId);
    params.set('email', email);
    params.set('payment_amount', String(amount));
    params.set('paytr_token', token);
    params.set('user_basket', basketJson);
    params.set('debug_on', config.sandbox ? '1' : '0');
    params.set('no_installment', '0');
    params.set('max_installment', '12');
    params.set('currency', 'TL');
    params.set('test_mode', config.sandbox ? '1' : '0');
    params.set('merchant_ok_url', req.callbackUrl);
    params.set('merchant_fail_url', req.callbackUrl);
    params.set('user_name', req.customerName || 'User');
    params.set('user_phone', req.metadata?.phone || '');
    params.set('user_address', 'Turkey');

    const res = await fetch('https://www.paytr.com/odeme/api/get-token', {
      method: 'POST',
      body: params,
    });
    const data = await res.json();
    const record = readPayTrRecord(data);
    if (readPayTrCreateStatus(record) !== 'success') {
      throw new Error(readPayTrCreateError(record) || 'PayTR token failed');
    }
    const iframeToken = readPayTrCreateToken(record);
    if (!iframeToken) throw new Error('PayTR token failed');
    return {
      paymentUrl: `https://www.paytr.com/odeme/guvenli/${iframeToken}`,
      sessionId: iframeToken,
    };
  },

  async verifyWebhook(config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const params = new URLSearchParams(body);
    const hash = params.get('hash');
    const merchantOid = params.get('merchant_oid') || '';
    const status = params.get('status');
    const totalAmount = params.get('total_amount') || '0';

    // Verify hash
    const merchantKey = config.merchant_key as string;
    const merchantSalt = config.merchant_salt as string;
    const hashStr = `${merchantOid}${merchantSalt}${status}${totalAmount}`;
    const expected = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');
    if (hash !== expected) throw new Error('Invalid PayTR webhook hash');

    return {
      type: status === 'success' ? 'payment_succeeded' : 'payment_failed',
      providerEventId: merchantOid,
      providerPaymentId: merchantOid,
      workspaceId: merchantOid.split('_')[0],
      amount: parseInt(totalAmount),
      currency: 'TRY',
      raw: Object.fromEntries(params),
    };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // PayTR doesn't have a health endpoint; validate credentials format
      if (!config.merchant_id || !config.merchant_key || !config.merchant_salt) {
        return { success: false, latencyMs: Date.now() - start, error: 'Missing required credentials' };
      }
      // Try a minimal token request
      const res = await fetch('https://www.paytr.com/odeme/api/get-token', { method: 'POST', body: new URLSearchParams({ merchant_id: config.merchant_id as string }) });
      const data = await res.json();
      // Any response means endpoint is reachable
      const record = readPayTrRecord(data);
      const reason = readPayTrCreateError(record);
      if (readPayTrCreateStatus(record) === 'error' && reason?.includes('Üye işyeri')) {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid merchant credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
