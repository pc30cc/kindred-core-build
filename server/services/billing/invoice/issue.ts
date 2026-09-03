// ============================================================
// INVOICE ISSUING — the moment the financial contract is frozen.
//
// Flow: build lines and the effect snapshot from SERVER-KNOWN data → insert a
// draft → open it. From `open` on, the database trigger (migration 113) makes
// the priced contract immutable, so nothing downstream can re-price it.
//
// Client-supplied amounts are never used. The caller passes a plan id and an
// interval; prices come from `billing_plans`.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { insertWithDocumentNumber } from '../invoiceNumber.js';
import type { BillingInterval, PlanActionType } from '../periods.js';
import { addBillingInterval, computeSubscriptionWindow } from '../periods.js';
import { computeUpgradeProration } from '../proration.js';
import type {
  InvoiceEffectSnapshot,
  InvoiceLineInput,
  InvoiceRow,
  InvoiceType,
} from './types.js';

const INVOICE_TYPE_BY_ACTION: Record<PlanActionType, InvoiceType> = {
  plan_new: 'new_subscription',
  plan_renewal: 'subscription_renewal',
  plan_upgrade: 'plan_upgrade',
  plan_downgrade: 'subscription_renewal',
};

interface PlanRecord {
  id: string;
  name: string;
  /** Canonical price map: { CURRENCY: { monthly, yearly } }. */
  prices?: Record<string, Record<string, unknown>> | null;
  /** Legacy flat columns, still honoured when a deployment has them. */
  price_monthly?: number | null;
  price_yearly?: number | null;
  limits: Record<string, unknown> | null;
  [key: string]: unknown;
}

function planPriceIrr(plan: PlanRecord, interval: BillingInterval): number {
  // `billing_plans.prices` is the schema's real price authority; the flat
  // columns only exist on older deployments and are a fallback, never the
  // silent 0 that would give away paid service.
  const fromMap = (plan.prices ?? {})?.IRR?.[interval];
  const raw = fromMap ?? (interval === 'yearly' ? plan.price_yearly : plan.price_monthly);
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new Error('plan_price_invalid');
  return Math.round(value);
}


function planAiAllowanceIrr(plan: PlanRecord, interval: BillingInterval): number {
  const limits = (plan.limits ?? {}) as Record<string, unknown>;
  const monthly = Number(limits.ai_credits_per_month ?? 0);
  if (!Number.isFinite(monthly) || monthly <= 0) return 0;
  // A yearly period is served as twelve months of allowance up front; the
  // period-bound grant makes double-granting impossible either way.
  return Math.round(interval === 'yearly' ? monthly * 12 : monthly);
}

export interface IssueSubscriptionInvoiceInput {
  workspaceId: string;
  subscriptionId?: string | null;
  targetPlanId: string;
  interval: BillingInterval;
  action: PlanActionType;
  /** Current contract, used for renewal stacking and upgrade proration. */
  currentPlanId?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  now?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Issues (and opens) the invoice for a subscription purchase.
 *
 * Returns the open invoice. The caller then creates a payment intent whose
 * `expected_amount_irr` is copied from `invoice.amount_due_irr` — the invoice
 * stays the pricing authority and the intent carries the immutable expectation
 * that gateway verification must match exactly.
 */
export async function issueSubscriptionInvoice(
  config: ServerConfig,
  input: IssueSubscriptionInvoiceInput,
): Promise<InvoiceRow> {
  const sb = getServiceClient(config);
  const now = input.now ?? new Date();

  const { data: target, error: planError } = await sb
    .from('billing_plans')
    .select('*')
    .eq('id', input.targetPlanId)
    .maybeSingle();
  if (planError || !target) throw new Error('unknown_plan');
  const targetPlan = target as PlanRecord;

  const fullPrice = planPriceIrr(targetPlan, input.interval);
  const lines: InvoiceLineInput[] = [];
  let proration: InvoiceEffectSnapshot['proration'] = null;
  let periodStart: Date;
  let periodEnd: Date;
  let payable = fullPrice;

  if (input.action === 'plan_upgrade' && input.currentPlanId && input.currentPeriodEnd) {
    const { data: current } = await sb
      .from('billing_plans')
      .select('*')
      .eq('id', input.currentPlanId)
      .maybeSingle();

    const currentStart = new Date(input.currentPeriodStart ?? now.toISOString());
    const currentEnd = new Date(input.currentPeriodEnd);

    const result = computeUpgradeProration({
      now,
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      currentPlanPriceIrr: current ? planPriceIrr(current as PlanRecord, input.interval) : 0,
      targetPlanPriceIrr: fullPrice,
      interval: input.interval,
    });

    // An immediate upgrade keeps the SAME period window: the customer already
    // paid for that time and only tops up the difference.
    periodStart = now;
    periodEnd = currentEnd;
    payable = result.payableIrr;
    proration = {
      total_ms: result.totalMs,
      remaining_ms: result.remainingMs,
      unused_credit_irr: result.unusedCreditIrr,
      target_remaining_irr: result.targetRemainingIrr,
      payable_irr: result.payableIrr,
    };

    lines.push({
      lineType: 'upgrade_proration',
      description: `ارتقا به ${targetPlan.name} برای باقی‌مانده دوره`,
      unitAmountIrr: payable,
      amountIrr: payable,
      planId: targetPlan.id,
      metadata: { proration },
    });
  } else {
    const window = computeSubscriptionWindow({
      now,
      interval: input.interval,
      action: input.action,
      currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
    });
    periodStart = window.start;
    periodEnd = window.end;
    lines.push({
      lineType: 'plan',
      description: `${targetPlan.name} — ${input.interval === 'yearly' ? 'سالانه' : 'ماهانه'}`,
      unitAmountIrr: fullPrice,
      amountIrr: fullPrice,
      planId: targetPlan.id,
    });
  }

  const snapshot: InvoiceEffectSnapshot = {
    action_type: input.action,
    source_plan_id: input.currentPlanId ?? null,
    target_plan_id: targetPlan.id,
    billing_interval: input.interval,
    effective_at: periodStart.toISOString(),
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    plan_snapshot: targetPlan as Record<string, unknown>,
    limits_snapshot: (targetPlan.limits ?? {}) as Record<string, unknown>,
    ai_allowance_irr: planAiAllowanceIrr(targetPlan, input.interval),
    proration,
  };

  return insertAndOpen(config, {
    workspaceId: input.workspaceId,
    subscriptionId: input.subscriptionId ?? null,
    invoiceType: INVOICE_TYPE_BY_ACTION[input.action],
    planId: targetPlan.id,
    planName: targetPlan.name,
    interval: input.interval,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    totalIrr: payable,
    lines,
    snapshot,
    metadata: input.metadata ?? {},
  });
}

/**
 * Issues the invoice for an AI credit purchase.
 *
 * In V2 an AI top-up is NOT a direct ledger call any more: the money settles an
 * invoice, and only the paid invoice grants the purchased lot (exactly once,
 * keyed by invoice id).
 */
export async function issueAiCreditInvoice(
  config: ServerConfig,
  input: { workspaceId: string; amountIrr: number; metadata?: Record<string, unknown> },
): Promise<InvoiceRow> {
  const amount = Math.round(Number(input.amountIrr));
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('ai_credit_amount_invalid');

  const snapshot: InvoiceEffectSnapshot = {
    action_type: 'ai_credit_purchase',
    source_plan_id: null,
    target_plan_id: null,
    billing_interval: null,
    effective_at: new Date().toISOString(),
    period_start: null,
    period_end: null,
    plan_snapshot: {},
    limits_snapshot: {},
    ai_allowance_irr: 0,
    ai_credit_amount_irr: amount,
    proration: null,
  };

  return insertAndOpen(config, {
    workspaceId: input.workspaceId,
    subscriptionId: null,
    invoiceType: 'ai_credit_purchase',
    planId: null,
    planName: null,
    interval: null,
    periodStart: null,
    periodEnd: null,
    totalIrr: amount,
    lines: [
      {
        lineType: 'ai_credit',
        description: 'خرید اعتبار هوش مصنوعی',
        unitAmountIrr: amount,
        amountIrr: amount,
      },
    ],
    snapshot,
    metadata: input.metadata ?? {},
  });
}

interface InsertInvoiceInput {
  workspaceId: string;
  subscriptionId: string | null;
  invoiceType: InvoiceType;
  planId: string | null;
  planName: string | null;
  interval: BillingInterval | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalIrr: number;
  lines: InvoiceLineInput[];
  snapshot: InvoiceEffectSnapshot;
  metadata: Record<string, unknown>;
}

/** Draft → lines → open. The open transition freezes the document. */
async function insertAndOpen(config: ServerConfig, input: InsertInvoiceInput): Promise<InvoiceRow> {
  const sb = getServiceClient(config);

  const draft = await insertWithDocumentNumber<InvoiceRow>(async (documentNumber) => {
    const { data, error } = await sb
      .from('billing_invoices')
      .insert({
        workspace_id: input.workspaceId,
        subscription_id: input.subscriptionId,
        invoice_number: documentNumber,
        invoice_type: input.invoiceType,
        status: 'draft',
        subtotal_irr: input.totalIrr,
        total_irr: input.totalIrr,
        amount_due_irr: input.totalIrr,
        plan_id: input.planId,
        plan_name_snapshot: input.planName,
        billing_interval: input.interval,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        effect_snapshot: input.snapshot,
        metadata: input.metadata,
      })
      .select('*')
      .single();
    return { data: data as InvoiceRow | null, error };
  });

  if (input.lines.length > 0) {
    const { error: lineError } = await sb.from('billing_invoice_lines').insert(
      input.lines.map((line, index) => ({
        invoice_id: draft.id,
        line_type: line.lineType,
        description: line.description,
        quantity: line.quantity ?? 1,
        unit_amount_irr: line.unitAmountIrr,
        amount_irr: line.amountIrr,
        plan_id: line.planId ?? null,
        metadata: line.metadata ?? {},
        sort_order: index,
      })),
    );
    if (lineError) throw new Error(lineError.message);
  }

  const { data: opened, error: openError } = await sb
    .from('billing_invoices')
    .update({ status: 'open', issued_at: new Date().toISOString() })
    .eq('id', draft.id)
    .eq('status', 'draft')
    .select('*')
    .single();
  if (openError || !opened) throw new Error(openError?.message || 'invoice_open_failed');

  return opened as InvoiceRow;
}
