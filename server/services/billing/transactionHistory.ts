// ============================================================
// UNIFIED CUSTOMER TRANSACTION HISTORY
//
// Two tables, two responsibilities — kept clean:
//
//   billing_payment_intents  → source of truth for payment ATTEMPTS
//                              (pending / processing / succeeded / canceled /
//                              failed / expired). No money is implied.
//   billing_payments         → source of truth for money that actually
//                              SETTLED (successful payments, refunds).
//
// The customer-facing history is a VIEW over both. It must never fabricate a
// settlement row in `billing_payments` just to make an attempt visible.
//
// De-duplication rule: when an intent succeeded and a payment exists for it,
// exactly ONE row is returned — the payment wins and is enriched with the
// intent's proforma snapshot (document number, plan name, interval, action).
// An attempt with no payment is returned on its own.
// ============================================================

export type TransactionStatus =
  | 'pending' | 'processing' | 'succeeded' | 'canceled' | 'failed' | 'expired' | 'refunded';

export interface CustomerTransaction {
  id: string;
  /** WebYar proforma/order number (NOT a legal tax invoice number). */
  documentNumber: string | null;
  type: string | null;
  purchaseType: 'subscription' | 'ai_credit_topup';
  planName: string | null;
  billingInterval: 'monthly' | 'yearly' | null;
  amountIrr: number;
  status: TransactionStatus;
  createdAt: string;
  paidAt: string | null;
  canceledAt: string | null;
  provider: string | null;
  /** Bank tracking reference — deliberately distinct from documentNumber. */
  providerReference: string | null;
  settled: boolean;
}

export interface PaymentRowInput {
  id: string;
  payment_intent_id?: string | null;
  invoice_number?: string | null;
  amount?: number | string | null;
  status?: string | null;
  action_type?: string | null;
  plan_name_snapshot?: string | null;
  billing_interval?: string | null;
  provider_name?: string | null;
  provider_payment_id?: string | null;
  paid_at?: string | null;
  created_at: string;
  metadata?: any;
}

export interface IntentRowInput {
  id: string;
  invoice_number?: string | null;
  amount_irr?: number | string | null;
  final_amount_irr?: number | string | null;
  status: string;
  purchase_type?: string | null;
  action_type?: string | null;
  plan_name_snapshot?: string | null;
  billing_plans?: { name?: string | null } | null;
  billing_interval?: string | null;
  provider_name?: string | null;
  provider_ref?: string | null;
  created_at: string;
  updated_at?: string | null;
  succeeded_at?: string | null;
  metadata?: any;
}

const KNOWN: TransactionStatus[] = ['pending', 'processing', 'succeeded', 'canceled', 'failed', 'expired', 'refunded'];

function normalizeStatus(raw: string | null | undefined, settled: boolean): TransactionStatus {
  const s = String(raw || '').toLowerCase();
  if (s === 'partially_refunded') return 'refunded';
  if ((KNOWN as string[]).includes(s)) return s as TransactionStatus;
  return settled ? 'succeeded' : 'failed';
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function buildTransactionHistory(
  payments: PaymentRowInput[],
  intents: IntentRowInput[],
): CustomerTransaction[] {
  const byIntentId = new Map<string, IntentRowInput>();
  for (const i of intents || []) byIntentId.set(i.id, i);

  const consumedIntents = new Set<string>();
  const rows: CustomerTransaction[] = [];

  for (const p of payments || []) {
    const intent = p.payment_intent_id ? byIntentId.get(p.payment_intent_id) : undefined;
    if (intent) consumedIntents.add(intent.id);
    const purchaseType = (intent?.purchase_type === 'ai_credit_topup'
      || p.action_type === 'ai_credit_topup'
      || p.metadata?.purchase_type === 'ai_credit_topup')
      ? 'ai_credit_topup' : 'subscription';
    rows.push({
      id: p.id,
      documentNumber: p.invoice_number || intent?.invoice_number || null,
      type: p.action_type || intent?.action_type || null,
      purchaseType,
      planName: p.plan_name_snapshot || intent?.plan_name_snapshot || intent?.billing_plans?.name || null,
      billingInterval: (p.billing_interval || intent?.billing_interval || null) as any,
      amountIrr: num(p.amount ?? intent?.final_amount_irr ?? intent?.amount_irr),
      status: normalizeStatus(p.status, true),
      createdAt: p.created_at,
      paidAt: p.paid_at || intent?.succeeded_at || null,
      canceledAt: null,
      provider: p.provider_name || intent?.provider_name || null,
      providerReference: p.provider_payment_id || intent?.provider_ref || null,
      settled: true,
    });
  }

  for (const i of intents || []) {
    if (consumedIntents.has(i.id)) continue;
    // A succeeded intent whose payment row is not in this page is already
    // represented by that payment elsewhere — never duplicate it here.
    if (i.status === 'succeeded' && (payments || []).some((p) => p.payment_intent_id === i.id)) continue;
    const status = normalizeStatus(i.status, false);
    rows.push({
      id: i.id,
      documentNumber: i.invoice_number || null,
      type: i.action_type || null,
      purchaseType: i.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
      planName: i.plan_name_snapshot || i.billing_plans?.name || null,
      billingInterval: (i.billing_interval || null) as any,
      amountIrr: num(i.final_amount_irr ?? i.amount_irr),
      status,
      createdAt: i.created_at,
      paidAt: i.succeeded_at || null,
      canceledAt: status === 'canceled' ? (i.updated_at || null) : null,
      provider: i.provider_name || null,
      providerReference: i.provider_ref || null,
      settled: false,
    });
  }

  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
