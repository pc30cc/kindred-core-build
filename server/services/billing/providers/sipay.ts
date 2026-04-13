import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

export const sipayProvider: BillingProviderHandler = {
  name: 'sipay',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = req.metadata?.amount || '0';
    const orderId = `${req.workspaceId}_${Date.now()}`;
    const hashKey = crypto.createHmac('sha256', config.app_secret as string)
      .update(`${config.merchant_key}${amount}TRY${orderId}`)
      .digest('base64');

    const res = await fetch('https://app.sipay.com.tr/ccpayment/api/paySmart3D', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_key: config.merchant_key,
        app_key: config.app_key,
        hash_key: hashKey,
        invoice_id: orderId,
        total: amount,
        currency: 'TRY',
        return_url: req.callbackUrl,
        cancel_url: req.callbackUrl,
        bill_email: req.customerEmail,
        bill_fname: req.customerName || 'User',
        bill_lname: 'User',
        items: JSON.stringify([{ name: `Plan ${req.planId}`, price: amount, quantity: 1 }]),
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || 'Sipay checkout failed');
    return { paymentUrl: data.paymentUrl || data.url_3d, sessionId: orderId };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.status_code === '100' || data.status === 'success') {
      return {
        type: 'payment_succeeded',
        providerEventId: data.invoice_id || data.order_id,
        providerPaymentId: data.invoice_id,
        amount: parseFloat(data.total || '0') * 100,
        currency: 'TRY',
        raw: data,
      };
    }
    return null;
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const hashKey = crypto.createHmac('sha256', config.app_secret as string)
      .update(`${config.merchant_key}${paymentId}`)
      .digest('base64');
    const res = await fetch('https://app.sipay.com.tr/ccpayment/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_key: config.merchant_key,
        hash_key: hashKey,
        invoice_id: paymentId,
        refund_amount: amount ? (amount / 100).toFixed(2) : undefined,
      }),
    });
    const data = await res.json();
    return { success: data.status_code === '100', refundId: data.refund_id };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      if (!config.merchant_key || !config.app_key || !config.app_secret) {
        return { success: false, latencyMs: Date.now() - start, error: 'Missing credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
