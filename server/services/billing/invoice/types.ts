// ============================================================
// BILLING ENGINE V2 — invoice domain types.
//
// The invoice is the ONLY pricing authority. Everything downstream (payment
// intent expected amount, gateway verification, entitlements, AI allowance)
// derives from a row of `billing_invoices` and its frozen `effect_snapshot`.
// ============================================================

import type { BillingInterval, PlanActionType } from '../periods.js';

export type InvoiceType =
  | 'new_subscription'
  | 'subscription_renewal'
  | 'plan_upgrade'
  | 'addon'
  | 'manual'
  | 'ai_credit_purchase';

export type InvoiceStatus =
  | 'draft'
  | 'open'
  | 'partially_paid'
  | 'paid'
  | 'past_due'
  | 'void'
  | 'expired'
  | 'refunded';

export type InvoiceLineType =
  | 'plan'
  | 'upgrade_proration'
  | 'addon'
  | 'ai_credit'
  | 'discount'
  | 'tax'
  | 'credit'
  | 'manual_adjustment';

export interface InvoiceLineInput {
  lineType: InvoiceLineType;
  description: string;
  quantity?: number;
  unitAmountIrr: number;
  amountIrr: number;
  planId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The business effect frozen at issue time.
 *
 * `applyInvoiceEffects()` reads ONLY this object. If a Super Admin later
 * changes the plan price, renames the plan, alters its limits or its AI
 * allowance, an invoice issued before that change still applies exactly the
 * contract the customer paid for.
 */
export interface InvoiceEffectSnapshot {
  action_type: PlanActionType | 'ai_credit_purchase';
  source_plan_id: string | null;
  target_plan_id: string | null;
  billing_interval: BillingInterval | null;
  effective_at: string;
  period_start: string | null;
  period_end: string | null;
  /** Full plan record as priced at issue time. */
  plan_snapshot: Record<string, unknown>;
  /** Entitlement limits granted by the period this invoice creates. */
  limits_snapshot: Record<string, unknown>;
  /** Plan AI allowance for the period, in IRR. Granted once, at activation. */
  ai_allowance_irr: number;
  /** Purchased AI credit (ai_credit_purchase invoices only), in IRR. */
  ai_credit_amount_irr?: number;
  /** Inputs and result of the proration, for audit and dispute resolution. */
  proration?: {
    total_ms: number;
    remaining_ms: number;
    unused_credit_irr: number;
    target_remaining_irr: number;
    payable_irr: number;
  } | null;
}

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  subscription_id: string | null;
  invoice_number: string;
  document_type: string;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  currency: string;
  subtotal_irr: number;
  discount_irr: number;
  tax_irr: number;
  total_irr: number;
  amount_paid_irr: number;
  amount_due_irr: number;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  period_start: string | null;
  period_end: string | null;
  plan_id: string | null;
  plan_name_snapshot: string | null;
  billing_interval: BillingInterval | null;
  effect_snapshot: InvoiceEffectSnapshot | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SettlementResult {
  invoice_id: string;
  status: InvoiceStatus;
  amount_paid_irr: number;
  amount_due_irr: number;
  allocation_id: string;
  fully_paid?: boolean;
  replayed: boolean;
}

export interface InvoiceApplicationResult {
  invoice_id: string;
  application_id: string;
  period_id?: string | null;
  lot_id?: string | null;
  activated?: boolean;
  replayed: boolean;
}
