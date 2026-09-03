// ============================================================
// INVOICE SETTLEMENT — money → invoice → effects.
//
// The single rule this module protects:
//
//   A gateway payment NEVER grants anything by itself. It settles an invoice.
//   Only a PAID invoice may apply effects, and it may apply them exactly once.
//
// Every step is a database RPC (migration 115) so that allocation, invoice
// status and entitlement all move inside one transaction. This module only
// sequences and translates errors — it performs no money arithmetic.
//
// Fail-closed money handling: when verified gateway money cannot be applied
// (amount mismatch, invoice voided or expired), the payment is NOT discarded.
// It is recorded with `reconciliation_state = 'unapplied'` so finance can see
// and resolve it.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { InvoiceApplicationResult, InvoiceRow, SettlementResult } from './types.js';

export class InvoiceSettlementError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'InvoiceSettlementError';
  }
}

function translate(error: { message?: string | null } | null): never {
  const msg = String(error?.message || 'invoice_settlement_failed');
  if (msg.includes('invoice_amount_mismatch')) {
    throw new InvoiceSettlementError('amount_mismatch', msg, 409);
  }
  if (msg.includes('invoice_overpayment')) {
    throw new InvoiceSettlementError('overpayment', msg, 409);
  }
  if (msg.includes('invoice_not_payable')) {
    throw new InvoiceSettlementError('not_payable', msg, 409);
  }
  if (msg.includes('wallet_insufficient_funds')) {
    throw new InvoiceSettlementError('insufficient_funds', msg, 402);
  }
  if (msg.includes('unknown_invoice')) {
    throw new InvoiceSettlementError('unknown_invoice', msg, 404);
  }
  throw new InvoiceSettlementError('settlement_failed', msg, 500);
}

export async function getInvoice(config: ServerConfig, invoiceId: string): Promise<InvoiceRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('billing_invoices').select('*').eq('id', invoiceId).maybeSingle();
  return (data as InvoiceRow | null) ?? null;
}

/**
 * Settles an invoice with verified gateway money.
 *
 * `amountIrr` MUST be the amount the gateway itself confirmed — never a value
 * echoed by the client — and the RPC rejects anything that is not exactly the
 * outstanding amount.
 */
export async function settleInvoiceWithPayment(
  config: ServerConfig,
  input: { invoiceId: string; paymentId: string; amountIrr: number; commandKey: string },
): Promise<SettlementResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_settle_invoice', {
    p_invoice_id: input.invoiceId,
    p_amount_irr: input.amountIrr,
    p_source: 'gateway',
    p_command_key: input.commandKey,
    p_payment_id: input.paymentId,
    p_wallet_entry_id: null,
  });
  if (error) translate(error);
  return data as SettlementResult;
}

/** Settles an invoice from the workspace wallet (debit + settle, atomically). */
export async function settleInvoiceFromWallet(
  config: ServerConfig,
  input: { invoiceId: string; actorId?: string | null },
): Promise<SettlementResult & { wallet_entry_id: string }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_wallet_pay_invoice', {
    p_invoice_id: input.invoiceId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) translate(error);
  return data as SettlementResult & { wallet_entry_id: string };
}

/**
 * Applies a paid invoice's frozen effects.
 *
 * Safe to call repeatedly: the unique index on
 * `billing_invoice_applications.invoice_id` makes the second call a no-op that
 * returns the original result, which is what lets a crashed callback be
 * retried without granting anything twice.
 */
export async function applyInvoiceEffects(
  config: ServerConfig,
  invoiceId: string,
): Promise<InvoiceApplicationResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_apply_invoice_effects', { p_invoice_id: invoiceId });
  if (error) translate(error);
  return data as InvoiceApplicationResult;
}

/**
 * Records verified money that could NOT be applied to its invoice.
 *
 * This is the "money must never vanish" path: the customer really paid, the
 * settlement was refused, so the payment is parked for reconciliation instead
 * of being swallowed by a catch block.
 */
export async function parkUnappliedPayment(
  config: ServerConfig,
  input: { paymentId: string; reason: string },
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('billing_payments')
    .update({
      reconciliation_state: 'unapplied',
      reconciliation_reason: input.reason.slice(0, 500),
    })
    .eq('id', input.paymentId);
}

/**
 * The full post-verification pipeline used by the gateway callback:
 * settle → (if fully paid) apply effects. Any refusal parks the money.
 */
export async function settleAndApply(
  config: ServerConfig,
  input: { invoiceId: string; paymentId: string; amountIrr: number; commandKey: string },
): Promise<{ settlement: SettlementResult; application: InvoiceApplicationResult | null }> {
  let settlement: SettlementResult;
  try {
    settlement = await settleInvoiceWithPayment(config, input);
  } catch (err) {
    await parkUnappliedPayment(config, {
      paymentId: input.paymentId,
      reason: err instanceof Error ? err.message : 'settlement_failed',
    });
    throw err;
  }

  if (settlement.status !== 'paid') {
    return { settlement, application: null };
  }

  const application = await applyInvoiceEffects(config, input.invoiceId);
  return { settlement, application };
}

// ============================================================
// COLLECTION RESERVATION — gateway and wallet may not collect the same
// invoice at the same time. The reservation is durable and expiring, so an
// abandoned checkout releases itself instead of freezing the invoice.
// ============================================================

export interface CollectionHold {
  collection_id: string;
  channel: string;
  amount_irr: number;
  expires_at: string;
  replayed: boolean;
}

export async function beginCollection(
  config: ServerConfig,
  input: {
    invoiceId: string;
    channel: 'gateway' | 'wallet' | 'admin';
    amountIrr: number;
    commandKey: string;
    paymentIntentId?: string | null;
    ttlSeconds?: number;
  },
): Promise<CollectionHold> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_begin_collection', {
    p_invoice_id: input.invoiceId,
    p_channel: input.channel,
    p_amount_irr: input.amountIrr,
    p_command_key: input.commandKey,
    p_intent_id: input.paymentIntentId ?? null,
    p_ttl_seconds: input.ttlSeconds ?? 1800,
  });
  if (error) {
    const msg = String(error.message || '');
    if (msg.includes('invoice_collection_locked')) {
      throw new InvoiceSettlementError('collection_locked', msg, 409);
    }
    translate(error);
  }
  return data as CollectionHold;
}

export async function releaseCollection(
  config: ServerConfig,
  collectionId: string,
  reason = 'released',
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.rpc('billing_release_collection', {
    p_collection_id: collectionId,
    p_reason: reason,
  });
}
