// ============================================================================
// BILLING V2 — CUSTOMER READ MODELS (Phase D)
//
// One cohesive shape per screen, so the workspace UI never fans out into N+1
// requests and never derives money itself. Everything here is STRICTLY
// read-only: no grant, no settle, no activation, no allowance side effect.
// A GET may not move money — not even by accident.
//
// The frontend renders exactly what these functions return. Prices, periods,
// cycles, proration, dues and eligibility are all decided server-side.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getRolloutState, type RolloutState } from '../rollout.js';
import {
  buildTransactionHistory,
  type CustomerTransaction,
  type IntentRowInput,
  type PaymentRowInput,
} from '../transactionHistory.js';

export interface EntitlementCycleView {
  id: string;
  index: number;
  start: string;
  end: string;
  allowanceIrr: number;
  usedIrr: number;
  remainingIrr: number;
  state: string;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  invoiceType: string;
  status: string;
  planName: string | null;
  interval: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** ISO 4217 code of every amount on the invoice (`*Irr` = minor units of it, Rial for IRR). */
  currency: string;
  totalIrr: number;
  amountPaidIrr: number;
  amountDueIrr: number;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  /** Paid, but the service period it buys has not started yet. */
  activatesAt: string | null;
}

export interface BillingOverview {
  engine: 'v1' | 'v2';
  rolloutState: RolloutState;
  permissions: { manage: boolean };
  subscription: {
    status: string | null;
    planId: string | null;
    planName: string | null;
    interval: 'monthly' | 'yearly' | null;
    isFree: boolean;
    isTrial: boolean;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
  };
  servicePeriod: {
    id: string;
    start: string;
    end: string;
    interval: string;
    source: string;
  } | null;
  nextInvoiceAt: string | null;
  pendingPlanChange: {
    type: string;
    planId: string | null;
    planName: string | null;
    effectiveAt: string | null;
    cancelable: boolean;
  } | null;
  aiCycle: EntitlementCycleView | null;
  aiPurchasedRemainingIrr: number;
  /** True for a yearly contract: the AI allowance is still released monthly. */
  aiMonthlyOnAnnual: boolean;
  wallet: { balanceIrr: number; frozen: boolean; autoPayEnabled: boolean };
  upcomingInvoice: InvoiceSummary | null;
  /**
   * Escalation state of the upcoming SERVICE invoice. Server-decided: the UI
   * only paints the `stage` it is given and never infers urgency from a date.
   */
  upcomingInvoiceAlert: {
    /** 0 = issued, no reminder sent yet; grows with each reminder. */
    remindersSent: number;
    remindersTotal: number;
    /** 0 = calm … 3 = past due / last call before suspension. */
    stage: 0 | 1 | 2 | 3;
    pastDue: boolean;
    suspendAt: string | null;
    daysToSuspend: number | null;
  } | null;

}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The invoice's currency (column default IRR). */
export function invoiceCurrency(inv: { currency?: unknown } | null | undefined): string {
  const code = typeof inv?.currency === 'string' ? inv.currency.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : 'IRR';
}

/** The wallet holds Rial: it can only pay invoices issued in IRR. */
export const WALLET_CURRENCY = 'IRR';

/** True when a plan has a positive price in ANY currency (or in the legacy flat columns). */
export function planHasPaidPrice(plan: { prices?: unknown; price_monthly?: unknown; price_yearly?: unknown } | null | undefined): boolean {
  if (!plan) return false;
  const prices = plan.prices && typeof plan.prices === 'object' ? (plan.prices as Record<string, unknown>) : {};
  for (const byInterval of Object.values(prices)) {
    if (!byInterval || typeof byInterval !== 'object') continue;
    const b = byInterval as Record<string, unknown>;
    if (num(b.monthly) > 0 || num(b.yearly) > 0) return true;
  }
  return num(plan.price_monthly) > 0 || num(plan.price_yearly) > 0;
}

// ─── Row shapes (the columns these read models select) ────────────────────

/** `billing_invoices`. Amount columns are minor units of `currency` (Rial for IRR). */
export interface InvoiceDbRow {
  id: string;
  invoice_number: string;
  invoice_type: string;
  status: string;
  currency?: string | null;
  plan_name_snapshot?: string | null;
  billing_interval?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  subtotal_irr?: unknown;
  discount_irr?: unknown;
  tax_irr?: unknown;
  total_irr?: unknown;
  amount_paid_irr?: unknown;
  amount_due_irr?: unknown;
  issued_at?: string | null;
  due_at?: string | null;
  paid_at?: string | null;
  created_at?: string;
}

interface SubscriptionDbRow {
  status: string | null;
  plan_id: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_invoice_at: string | null;
  next_plan_id: string | null;
  pending_change_type: string | null;
  cancel_at_period_end: boolean | null;
  trial_end: string | null;
}

interface PeriodDbRow {
  id: string;
  period_start: string;
  period_end: string;
  billing_interval: string;
  source: string;
}

interface WalletDbRow {
  available_balance_irr?: unknown;
  frozen?: boolean | null;
  auto_pay_enabled?: boolean | null;
}

interface EntitlementCycleDbRow {
  cycle_id?: string | null;
  cycle_index?: unknown;
  start: string;
  end: string;
  allowance_irr?: unknown;
  remaining_irr?: unknown;
  allowance_state?: string | null;
}

interface AiLotDbRow {
  source_type: string;
  remaining_amount: unknown;
}

interface BillingPolicyRow {
  reminder_days_before_due?: unknown;
  grace_period_days?: unknown;
  wallet_auto_pay_default?: boolean | null;
}

interface PlanDbRow {
  name: string;
  prices?: unknown;
  limits?: unknown;
}

interface InvoiceLineDbRow {
  id: string;
  line_type: string;
  description: string;
  quantity?: unknown;
  unit_amount_irr?: unknown;
  amount_irr?: unknown;
}

interface CollectionDbRow {
  channel: string | null;
  expires_at: string | null;
  status: string;
}

interface WalletLedgerDbRow {
  id: string;
  entry_type: string;
  amount_irr: unknown;
  balance_after_irr: unknown;
  created_at: string;
  billing_invoices?: { invoice_number?: string | null } | null;
  billing_wallet_deposits?: { document_number?: string | null } | null;
}

interface DepositConfigRow {
  presets_irr?: unknown[] | null;
  allow_custom?: boolean | null;
  min_irr?: unknown;
  max_irr?: unknown;
}

/** Paid renewal whose period has not started yet must NOT look already active. */
function activationDate(inv: Pick<InvoiceDbRow, 'status' | 'period_start'>): string | null {
  if (inv.status !== 'paid' || !inv.period_start) return null;
  return new Date(inv.period_start).getTime() > Date.now() ? inv.period_start : null;
}

export function toInvoiceSummary(inv: InvoiceDbRow): InvoiceSummary {
  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    invoiceType: inv.invoice_type,
    status: inv.status,
    planName: inv.plan_name_snapshot ?? null,
    interval: inv.billing_interval ?? null,
    periodStart: inv.period_start ?? null,
    periodEnd: inv.period_end ?? null,
    currency: invoiceCurrency(inv),
    totalIrr: num(inv.total_irr),
    amountPaidIrr: num(inv.amount_paid_irr),
    amountDueIrr: num(inv.amount_due_irr),
    issuedAt: inv.issued_at ?? null,
    dueAt: inv.due_at ?? null,
    paidAt: inv.paid_at ?? null,
    activatesAt: activationDate(inv),
  };
}

export async function buildBillingOverview(
  config: ServerConfig,
  workspaceId: string,
  opts: { manage: boolean },
): Promise<BillingOverview> {
  const sb = getServiceClient(config);
  const rolloutState = await getRolloutState(config, workspaceId);

  const [subRes, periodRes, walletRes, cycleRes, lotsRes, policyRes] = await Promise.all([
    sb
      .from('workspace_subscriptions')
      .select(
        'status, plan_id, billing_interval, current_period_start, current_period_end, next_invoice_at, next_plan_id, pending_change_type, cancel_at_period_end, trial_end',
      )
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    sb
      .from('billing_subscription_periods')
      .select('id, period_start, period_end, billing_interval, source')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .maybeSingle(),
    sb
      .from('billing_wallet_accounts')
      .select('available_balance_irr, frozen, auto_pay_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    sb.rpc('billing_v2_current_entitlement_cycle', { p_workspace_id: workspaceId }),
    sb
      .from('workspace_ai_balance_lots')
      .select('source_type, remaining_amount, state')
      .eq('workspace_id', workspaceId)
      .in('state', ['ACTIVE', 'EXPIRING']),
    sb.from('billing_v2_policy').select('wallet_auto_pay_default').maybeSingle(),
  ]);

  // Subscription identity is financial truth. Never turn a failed read into a
  // synthetic free plan: PostgREST relation/schema-cache failures previously
  // made `data` null and the UI quietly rendered "Free".
  if (subRes.error) throw new Error(`billing subscription read failed: ${subRes.error.message}`);

  const sub = (subRes.data ?? null) as SubscriptionDbRow | null;
  const period = (periodRes.data ?? null) as PeriodDbRow | null;
  const wallet = (walletRes.data ?? null) as WalletDbRow | null;
  const cycle = ((cycleRes as { data?: unknown }).data ?? null) as EntitlementCycleDbRow | null;

  const purchasedRemaining = ((lotsRes.data || []) as AiLotDbRow[])
    .filter((l) => l.source_type !== 'PLAN_ALLOWANCE')
    .reduce((s, l) => s + num(l.remaining_amount), 0);

  // The next invoice the customer will actually see. Only SERVICE invoices
  // belong here — a wallet top-up or an AI credit purchase is a one-off
  // document, not the subscription's next bill.
  const SERVICE_INVOICE_TYPES = ['new_subscription', 'subscription_renewal', 'plan_upgrade'];
  const { data: upcoming } = await sb
    .from('billing_invoices')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('invoice_type', SERVICE_INVOICE_TYPES)
    .in('status', ['open', 'partially_paid', 'past_due', 'paid'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(25);

  // Dunning policy decides WHEN an unpaid invoice starts being shown: not the
  // moment it is issued (that is only a pre-bill), but when its due window
  // opens — the first reminder offset before `due_at`.
  const { data: policyJson } = await sb.rpc('billing_v2_policy_for', { p_workspace_id: workspaceId });
  const policy = (policyJson ?? {}) as BillingPolicyRow;
  const reminderOffsets: number[] = Array.isArray(policy.reminder_days_before_due)
    ? policy.reminder_days_before_due.map((d: unknown) => Number(d)).filter((d: number) => Number.isFinite(d))
    : [5, 1];
  const graceDays = Number.isFinite(Number(policy.grace_period_days)) ? Number(policy.grace_period_days) : 3;
  const leadMs = (reminderOffsets.length ? Math.max(...reminderOffsets) : 5) * 86_400_000;

  // An invoice without a due date is a checkout document the customer just
  // generated (first purchase / manual upgrade). It is not a due bill and
  // belongs to the Invoices tab, not to "next due date".
  const dueWindowOpen = (i: InvoiceDbRow): boolean => {
    if (!i.due_at) return false;
    return new Date(i.due_at).getTime() - leadMs <= Date.now();
  };

  // Renewal dues only make sense once a service actually runs.
  const hasService = Boolean(sub || period);

  const candidates = ((upcoming || []) as InvoiceDbRow[]).filter((i) =>
    i.status === 'paid' ? activationDate(i) !== null : hasService && dueWindowOpen(i),
  );

  candidates.sort((a, b) => {
    const rank = (i: InvoiceDbRow) => (i.status === 'paid' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const at = new Date(a.due_at || a.period_start || a.created_at).getTime();
    const bt = new Date(b.due_at || b.period_start || b.created_at).getTime();
    return at - bt;
  });

  const headInvoice: InvoiceDbRow | null = candidates[0] ?? null;
  let upcomingInvoiceAlert: BillingOverview['upcomingInvoiceAlert'] = null;
  if (headInvoice && headInvoice.status !== 'paid') {
    const { count } = await sb
      .from('billing_notification_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', headInvoice.id)
      .eq('notification_type', 'invoice_reminder')
      .eq('status', 'sent');
    const remindersSent = Number(count ?? 0);
    const remindersTotal = Math.max(1, reminderOffsets.length);
    const pastDue = headInvoice.status === 'past_due';
    const suspendAt = headInvoice.due_at
      ? new Date(new Date(headInvoice.due_at).getTime() + graceDays * 86_400_000).toISOString()
      : null;
    const daysToSuspend = suspendAt
      ? Math.max(0, Math.ceil((new Date(suspendAt).getTime() - Date.now()) / 86_400_000))
      : null;
    const stage: 0 | 1 | 2 | 3 = pastDue
      ? 3
      : remindersSent >= remindersTotal
        ? 2
        : remindersSent > 0
          ? 1
          : 0;
    upcomingInvoiceAlert = { remindersSent, remindersTotal, stage, pastDue, suspendAt, daysToSuspend };
  }


  let pendingPlanName: string | null = null;
  if (sub?.next_plan_id) {
    const { data: nextPlan } = await sb
      .from('billing_plans')
      .select('name')
      .eq('id', sub.next_plan_id)
      .maybeSingle();
    pendingPlanName = (nextPlan as { name?: string | null } | null)?.name ?? null;
  }

  // Cancelling a scheduled change is only safe while nothing has been paid
  // for it: an unpaid (or not yet issued) renewal invoice.
  let pendingCancelable = false;
  if (sub?.pending_change_type) {
    const { data: paidFuture } = await sb
      .from('billing_invoices')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('invoice_type', 'subscription_renewal')
      .eq('status', 'paid')
      .gte('period_start', new Date().toISOString())
      .limit(1);
    pendingCancelable = (paidFuture || []).length === 0;
  }

  const interval = (sub?.billing_interval as 'monthly' | 'yearly' | null) ?? null;
  const allowanceIrr = num(cycle?.allowance_irr);
  const remainingIrr = num(cycle?.remaining_irr);

  // Resolve the plan explicitly by its canonical id. workspace_subscriptions
  // has both plan_id and next_plan_id pointing at billing_plans, so embedded
  // relationship discovery is needlessly fragile and must not decide whether
  // a paying customer appears to be free.
  let plan: PlanDbRow | null = null;
  if (sub?.plan_id) {
    const { data: planRow, error: planError } = await sb
      .from('billing_plans')
      .select('name, prices, limits')
      .eq('id', sub.plan_id)
      .maybeSingle();
    if (planError) throw new Error(`billing plan read failed: ${planError.message}`);
    if (!planRow) throw new Error(`billing plan ${sub.plan_id} was not found`);
    plan = (planRow as PlanDbRow | null) ?? null;
  }

  const planName = plan?.name ?? null;
  // Free means free in every currency: a plan sold only in USD has no IRR
  // price and must not be shown to its paying customer as "Free".
  const planIsFree = !planHasPaidPrice(plan);


  return {
    engine: rolloutState === 'v2_active' ? 'v2' : 'v1',
    rolloutState,
    permissions: { manage: opts.manage },
    subscription: {
      status: sub?.status ?? null,
      planId: sub?.plan_id ?? null,
      planName,
      interval,
      isFree: planIsFree,
      isTrial: sub?.status === 'trialing',
      trialEndsAt: sub?.trial_end ?? null,
      cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
    },
    servicePeriod: period
      ? {
          id: period.id,
          start: period.period_start,
          end: period.period_end,
          interval: period.billing_interval,
          source: period.source,
        }
      : sub?.current_period_start && sub?.current_period_end
        ? {
            id: 'legacy',
            start: sub.current_period_start,
            end: sub.current_period_end,
            interval: interval ?? 'monthly',
            source: 'legacy',
          }
        : null,
    nextInvoiceAt: sub?.next_invoice_at ?? sub?.current_period_end ?? null,
    pendingPlanChange: sub?.pending_change_type
      ? {
          type: sub.pending_change_type,
          planId: sub.next_plan_id ?? null,
          planName: pendingPlanName,
          effectiveAt: period?.period_end ?? sub?.current_period_end ?? null,
          cancelable: pendingCancelable,
        }
      : null,
    aiCycle: cycle?.cycle_id
      ? {
          id: cycle.cycle_id,
          index: Number(cycle.cycle_index ?? 0),
          start: cycle.start,
          end: cycle.end,
          allowanceIrr,
          usedIrr: Math.max(0, allowanceIrr - remainingIrr),
          remainingIrr,
          state: String(cycle.allowance_state ?? 'pending'),
        }
      : null,
    aiPurchasedRemainingIrr: purchasedRemaining,
    aiMonthlyOnAnnual: interval === 'yearly',
    wallet: {
      balanceIrr: num(wallet?.available_balance_irr),
      frozen: Boolean(wallet?.frozen),
      autoPayEnabled:
        wallet?.auto_pay_enabled === null || wallet?.auto_pay_enabled === undefined
          ? Boolean((policyRes.data as BillingPolicyRow | null)?.wallet_auto_pay_default ?? true)
          : Boolean(wallet.auto_pay_enabled),
    },
    upcomingInvoice: headInvoice ? toInvoiceSummary(headInvoice) : null,
    upcomingInvoiceAlert,

  };
}

// ─── Invoice list ──────────────────────────────────────────────────────────

export const INVOICE_FILTERS = ['all', 'open', 'paid', 'past_due', 'void', 'expired'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

const FILTER_STATUSES: Record<InvoiceFilter, string[] | null> = {
  all: null,
  open: ['open', 'partially_paid'],
  paid: ['paid'],
  past_due: ['past_due'],
  void: ['void'],
  expired: ['expired'],
};

export async function listInvoices(
  config: ServerConfig,
  workspaceId: string,
  opts: { filter?: InvoiceFilter; page?: number; pageSize?: number },
): Promise<{ invoices: InvoiceSummary[]; page: number; pageSize: number; total: number }> {
  const sb = getServiceClient(config);
  const page = Math.max(1, Math.floor(opts.page || 1));
  const pageSize = Math.min(50, Math.max(5, Math.floor(opts.pageSize || 10)));
  const filter: InvoiceFilter = (opts.filter && FILTER_STATUSES[opts.filter] !== undefined
    ? opts.filter
    : 'all') as InvoiceFilter;

  let query = sb
    .from('billing_invoices')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .neq('status', 'draft');

  const statuses = FILTER_STATUSES[filter];
  if (statuses) query = query.in('status', statuses);

  const { data, count } = await query
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  return {
    invoices: (data || []).map(toInvoiceSummary),
    page,
    pageSize,
    total: count ?? 0,
  };
}

// ─── Invoice detail ────────────────────────────────────────────────────────

export interface InvoiceDetail {
  invoice: InvoiceSummary & { workspaceName: string | null; createdAt: string };
  lines: Array<{
    id: string;
    lineType: string;
    description: string;
    quantity: number;
    unitAmountIrr: number;
    amountIrr: number;
  }>;
  totals: {
    subtotalIrr: number;
    discountIrr: number;
    taxIrr: number;
    totalIrr: number;
    paidIrr: number;
    dueIrr: number;
  };
  /** Server-decided. The UI renders these, it does not compute them. */
  actions: {
    payable: boolean;
    canPayWallet: boolean;
    canPayGateway: boolean;
    walletBalanceIrr: number;
    walletShortfallIrr: number;
    blockedReason: string | null;
  };
  collection: { active: boolean; channel: string | null; expiresAt: string | null };
}

export async function getInvoiceDetail(
  config: ServerConfig,
  workspaceId: string,
  invoiceId: string,
  opts: { manage: boolean },
): Promise<InvoiceDetail | null> {
  const sb = getServiceClient(config);

  // Ownership is part of the query: a cross-workspace id simply does not exist.
  const { data: invRow } = await sb
    .from('billing_invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const inv = invRow as InvoiceDbRow | null;
  if (!inv) return null;

  const [linesRes, walletRes, collectionRes, wsRes] = await Promise.all([
    sb.from('billing_invoice_lines').select('*').eq('invoice_id', invoiceId).order('sort_order'),
    sb
      .from('billing_wallet_accounts')
      .select('available_balance_irr, frozen')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    sb
      .from('billing_invoice_collections')
      .select('channel, expires_at, status')
      .eq('invoice_id', invoiceId)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle(),
    sb.from('workspaces').select('name').eq('id', workspaceId).maybeSingle(),
  ]);

  const wallet = walletRes.data as WalletDbRow | null;
  const due = num(inv.amount_due_irr);
  const balance = num(wallet?.available_balance_irr);
  const frozen = Boolean(wallet?.frozen);
  const collection = (collectionRes.data ?? null) as CollectionDbRow | null;
  const payableStatus = ['open', 'partially_paid', 'past_due'].includes(inv.status);

  let blockedReason: string | null = null;
  if (!payableStatus) blockedReason = 'not_payable';
  else if (!opts.manage) blockedReason = 'no_permission';
  else if (collection) blockedReason = 'collection_in_progress';
  const walletCurrency = invoiceCurrency(inv) === WALLET_CURRENCY;

  return {
    invoice: {
      ...toInvoiceSummary(inv),
      workspaceName: (wsRes.data as { name?: string | null } | null)?.name ?? null,
      createdAt: inv.created_at,
    },
    lines: ((linesRes.data || []) as InvoiceLineDbRow[]).map((l) => ({
      id: l.id,
      lineType: l.line_type,
      description: l.description,
      quantity: Number(l.quantity ?? 1),
      unitAmountIrr: num(l.unit_amount_irr),
      amountIrr: num(l.amount_irr),
    })),
    totals: {
      subtotalIrr: num(inv.subtotal_irr),
      discountIrr: num(inv.discount_irr),
      taxIrr: num(inv.tax_irr),
      totalIrr: num(inv.total_irr),
      paidIrr: num(inv.amount_paid_irr),
      dueIrr: due,
    },
    actions: {
      payable: payableStatus,
      canPayWallet: !blockedReason && walletCurrency && !frozen && balance >= due && due > 0,
      canPayGateway: !blockedReason && due > 0,
      walletBalanceIrr: balance,
      walletShortfallIrr: walletCurrency ? Math.max(0, due - balance) : 0,
      blockedReason,
    },
    collection: {
      active: Boolean(collection),
      channel: collection?.channel ?? null,
      expiresAt: collection?.expires_at ?? null,
    },
  };
}

// ─── Wallet ────────────────────────────────────────────────────────────────

export interface WalletView {
  balanceIrr: number;
  frozen: boolean;
  autoPayEnabled: boolean;
  deposit: { presetsIrr: number[]; allowCustom: boolean; minIrr: number; maxIrr: number };
  ledger: {
    entries: Array<{
      id: string;
      entryType: string;
      direction: 'credit' | 'debit';
      amountIrr: number;
      balanceAfterIrr: number;
      createdAt: string;
      /** Customer-readable reference — never a raw internal id. */
      reference: string | null;
      referenceKind: 'invoice' | 'deposit' | null;
    }>;
    page: number;
    pageSize: number;
    total: number;
  };
}

export async function buildWalletView(
  config: ServerConfig,
  workspaceId: string,
  opts: { page?: number; pageSize?: number },
): Promise<WalletView> {
  const sb = getServiceClient(config);
  const page = Math.max(1, Math.floor(opts.page || 1));
  const pageSize = Math.min(50, Math.max(5, Math.floor(opts.pageSize || 10)));

  const [accountRes, policyRes, ledgerRes] = await Promise.all([
    sb
      .from('billing_wallet_accounts')
      .select('available_balance_irr, frozen, auto_pay_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    sb.rpc('billing_v2_wallet_deposit_config'),
    sb
      .from('billing_wallet_ledger')
      .select(
        'id, entry_type, amount_irr, balance_after_irr, created_at, invoice_id, wallet_deposit_id, billing_invoices:invoice_id(invoice_number), billing_wallet_deposits:wallet_deposit_id(document_number)',
        { count: 'exact' },
      )
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1),
  ]);

  const account = (accountRes.data ?? null) as WalletDbRow | null;
  const cfgRow = ((policyRes as { data?: unknown }).data ?? {}) as DepositConfigRow;

  const { data: policyDefault } = await sb
    .from('billing_v2_policy')
    .select('wallet_auto_pay_default')
    .maybeSingle();

  return {
    balanceIrr: num(account?.available_balance_irr),
    frozen: Boolean(account?.frozen),
    autoPayEnabled:
      account?.auto_pay_enabled === null || account?.auto_pay_enabled === undefined
        ? Boolean((policyDefault as BillingPolicyRow | null)?.wallet_auto_pay_default ?? true)
        : Boolean(account.auto_pay_enabled),
    deposit: {
      presetsIrr: (cfgRow?.presets_irr || []).map((v: unknown) => num(v)),
      allowCustom: Boolean(cfgRow?.allow_custom ?? true),
      minIrr: num(cfgRow?.min_irr) || 500_000,
      maxIrr: num(cfgRow?.max_irr) || 5_000_000_000,
    },
    ledger: {
      entries: ((ledgerRes.data || []) as WalletLedgerDbRow[]).map((e) => ({
        id: e.id,
        entryType: e.entry_type,
        direction: num(e.amount_irr) >= 0 ? 'credit' : 'debit',
        amountIrr: Math.abs(num(e.amount_irr)),
        balanceAfterIrr: num(e.balance_after_irr),
        createdAt: e.created_at,
        reference:
          e.billing_invoices?.invoice_number ?? e.billing_wallet_deposits?.document_number ?? null,
        referenceKind: e.billing_invoices?.invoice_number
          ? 'invoice'
          : e.billing_wallet_deposits?.document_number
            ? 'deposit'
            : null,
      })),
      page,
      pageSize,
      total: ledgerRes.count ?? 0,
    },
  };
}

// ─── Transactions (money movement, NOT obligations) ────────────────────────

export async function listTransactions(
  config: ServerConfig,
  workspaceId: string,
  opts: { page?: number; pageSize?: number },
): Promise<{ transactions: CustomerTransaction[]; page: number; pageSize: number; total: number }> {
  const sb = getServiceClient(config);
  const page = Math.max(1, Math.floor(opts.page || 1));
  const pageSize = Math.min(50, Math.max(5, Math.floor(opts.pageSize || 10)));

  // Attempts drive the page window: every settled payment has an intent in the
  // Iranian flow, and `buildTransactionHistory` collapses the pair into one row.
  const { data: intents, count } = await sb
    .from('billing_payment_intents')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const intentRows = (intents || []) as IntentRowInput[];
  const intentIds = intentRows.map((i) => i.id);
  const { data: paymentData } = intentIds.length
    ? await sb.from('billing_payments').select('*').in('payment_intent_id', intentIds)
    : { data: [] as unknown[] };
  const payments = (paymentData || []) as Array<PaymentRowInput & { reconciliation_state?: string | null }>;

  // Money that really arrived but could not be applied is customer-facing as
  // "under review" — never as a failure, and never as a raw internal enum.
  const underReview = new Set(
    payments
      // `settled` is the canonical successful invoice allocation state.
      // Only verified money explicitly parked by the settlement pipeline is
      // awaiting reconciliation; older code compared against a nonexistent
      // `applied` state and consequently labelled every healthy payment as
      // "under review".
      .filter((p) => p.reconciliation_state === 'unapplied')
      .map((p) => p.id),
  );
  const transactions = buildTransactionHistory(payments, intentRows).map(
    (t) => (underReview.has(t.id) ? { ...t, needsReview: true } : t),
  );

  return {
    transactions,
    page,
    pageSize,
    total: count ?? 0,
  };
}
