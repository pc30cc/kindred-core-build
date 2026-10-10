// ============================================================================
// SIMPLE BILLING — what follows a settled gateway payment: the receipt mail,
// and for a payment made for a purpose (plan, renewal, upgrade) the
// entitlement refresh and the plan mail. Runs after the settlement committed;
// never throws (the money is already where it belongs).
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { sendBillingEmail } from './notify.js';
import { afterPlanChange } from './plans.js';

export interface SettledPayment {
  replayed?: boolean;
  ledger_id?: string;
  payment_id?: string;
  receipt_number?: string;
  balance_minor?: number;
  purpose?: string;
  purpose_result?: Record<string, unknown> | null;
}

export async function afterAccountSettlement(config: ServerConfig, settled: SettledPayment): Promise<void> {
  if (settled.replayed || !settled.payment_id) return;
  try {
    const { data } = await getServiceClient(config)
      .from('billing_account_payments')
      .select('workspace_id, currency, amount_minor')
      .eq('id', settled.payment_id)
      .maybeSingle();
    const payment = data as { workspace_id: string; currency: string; amount_minor: number } | null;
    if (!payment) return;
    await sendBillingEmail(
      config,
      payment.workspace_id,
      'billing_payment_receipt',
      (ctx) => ({
        receipt_number: settled.receipt_number ?? '',
        amount: ctx.money(Number(payment.amount_minor), payment.currency),
        balance: ctx.money(Number(settled.balance_minor ?? 0), payment.currency),
      }),
      { receiptLedgerId: settled.ledger_id ?? null },
    );
    const result = settled.purpose_result;
    if (result && typeof result === 'object' && !('error' in result) && !result.replayed) {
      await afterPlanChange(config, payment.workspace_id, result, 'payment_succeeded');
    } else if (result && 'error' in result) {
      console.warn(`[billing-account] payment ${settled.payment_id} credited; its ${settled.purpose} could not be done: ${String(result.error)}`);
    }
  } catch (e) {
    console.warn('[billing-account] after settlement:', e instanceof Error ? e.message : e);
  }
}
