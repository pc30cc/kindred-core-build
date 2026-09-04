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
import { buildTransactionHistory, type CustomerTransaction } from '../transactionHistory.js';

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
   * Dunning state, reported only. `serverTime` travels with the deadlines so
   * the countdown in the UI is measured against the server's clock and a
   * customer with a skewed device never sees a wrong grace deadline.
   */
  dunning: {
    pastDue: boolean;
    pastDueSince: string | null;
    gracePeriodEndsAt: string | null;
    freeFallbackAt: string | null;
    serverTime: string;
  };
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Paid renewal whose period has not started yet must NOT look already active. */
function activationDate(inv: any): string | null {
  if (inv.status !== 'paid' || !inv.period_start) return null;
  return new Date(inv.period_start).getTime() > Date.now() ? (inv.period_start as string) : null;
}

export function toInvoiceSummary(inv: any): InvoiceSummary {
  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    invoiceType: inv.invoice_type,
    status: inv.status,
    planName: inv.plan_name_snapshot ?? null,
    interval: inv.billing_interval ?? null,
    periodStart: inv.period_start ?? null,
    periodEnd: inv.period_end ?? null,
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
        'status, plan_id, billing_interval, current_period_start, current_period_end, next_invoice_at, next_plan_id, pending_change_type, cancel_at_period_end, trial_ends_at, past_due_since, grace_period_ends_at, free_fallback_at, billing_plans:plan_id(name, prices, limits)',
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

  const sub: any = subRes.data ?? null;
  const period: any = periodRes.data ?? null;
  const wallet: any = walletRes.data ?? null;
  const cycle: any = (cycleRes as any).data ?? null;

  const purchasedRemaining = (lotsRes.data || [])
    .filter((l: any) => l.source_type !== 'PLAN_ALLOWANCE')
    .reduce((s: number, l: any) => s + num(l.remaining_amount), 0);

  // The next invoice the customer will actually see. Unpaid comes first
  // (it needs an action), otherwise a paid-but-not-yet-active renewal.
  const { data: upcoming } = await sb
    .from('billing_invoices')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('status', ['open', 'partially_paid', 'past_due', 'paid'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(25);

  const candidates = (upcoming || []).filter(
    (i: any) => i.status !== 'paid' || activationDate(i) !== null,
  );
  candidates.sort((a: any, b: any) => {
    const rank = (i: any) => (i.status === 'paid' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const at = new Date(a.due_at || a.period_start || a.created_at).getTime();
    const bt = new Date(b.due_at || b.period_start || b.created_at).getTime();
    return at - bt;
  });

  let pendingPlanName: string | null = null;
  if (sub?.next_plan_id) {
    const { data: nextPlan } = await sb
      .from('billing_plans')
      .select('name')
      .eq('id', sub.next_plan_id)
      .maybeSingle();
    pendingPlanName = (nextPlan as any)?.name ?? null;
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
  const planName = (sub?.billing_plans as any)?.name ?? null;
  const planPrices = ((sub?.billing_plans as any)?.prices ?? {}) as Record<string, any>;
  const monthlyPrice = num(planPrices?.IRR?.monthly);
  const yearlyPrice = num(planPrices?.IRR?.yearly);

  return {
    engine: rolloutState === 'v2_active' ? 'v2' : 'v1',
    rolloutState,
    permissions: { manage: opts.manage },
    subscription: {
      status: sub?.status ?? null,
      planId: sub?.plan_id ?? null,
      planName,
      interval,
      isFree: monthlyPrice <= 0 && yearlyPrice <= 0,
      isTrial: sub?.status === 'trialing',
      trialEndsAt: sub?.trial_ends_at ?? null,
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
    dunning: {
      pastDue: sub?.status === 'past_due',
      pastDueSince: sub?.past_due_since ?? null,
      gracePeriodEndsAt: sub?.grace_period_ends_at ?? null,
      freeFallbackAt: sub?.free_fallback_at ?? null,
      serverTime: new Date().toISOString(),
    },
    wallet: {
      balanceIrr: num(wallet?.available_balance_irr),
      frozen: Boolean(wallet?.frozen),
      autoPayEnabled:
        wallet?.auto_pay_enabled === null || wallet?.auto_pay_enabled === undefined
          ? Boolean((policyRes.data as any)?.wallet_auto_pay_default ?? true)
          : Boolean(wallet.auto_pay_enabled),
    },
    upcomingInvoice: candidates.length ? toInvoiceSummary(candidates[0]) : null,
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
  const { data: inv } = await sb
    .from('billing_invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
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

  const due = num((inv as any).amount_due_irr);
  const balance = num((walletRes.data as any)?.available_balance_irr);
  const frozen = Boolean((walletRes.data as any)?.frozen);
  const collection: any = collectionRes.data ?? null;
  const payableStatus = ['open', 'partially_paid', 'past_due'].includes((inv as any).status);

  let blockedReason: string | null = null;
  if (!payableStatus) blockedReason = 'not_payable';
  else if (!opts.manage) blockedReason = 'no_permission';
  else if (collection) blockedReason = 'collection_in_progress';

  return {
    invoice: {
      ...toInvoiceSummary(inv),
      workspaceName: (wsRes.data as any)?.name ?? null,
      createdAt: (inv as any).created_at,
    },
    lines: (linesRes.data || []).map((l: any) => ({
      id: l.id,
      lineType: l.line_type,
      description: l.description,
      quantity: Number(l.quantity ?? 1),
      unitAmountIrr: num(l.unit_amount_irr),
      amountIrr: num(l.amount_irr),
    })),
    totals: {
      subtotalIrr: num((inv as any).subtotal_irr),
      discountIrr: num((inv as any).discount_irr),
      taxIrr: num((inv as any).tax_irr),
      totalIrr: num((inv as any).total_irr),
      paidIrr: num((inv as any).amount_paid_irr),
      dueIrr: due,
    },
    actions: {
      payable: payableStatus,
      canPayWallet: !blockedReason && !frozen && balance >= due && due > 0,
      canPayGateway: !blockedReason && due > 0,
      walletBalanceIrr: balance,
      walletShortfallIrr: Math.max(0, due - balance),
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

  const account: any = accountRes.data ?? null;
  const cfgRow: any = (policyRes as any).data ?? {};

  const { data: policyDefault } = await sb
    .from('billing_v2_policy')
    .select('wallet_auto_pay_default')
    .maybeSingle();

  return {
    balanceIrr: num(account?.available_balance_irr),
    frozen: Boolean(account?.frozen),
    autoPayEnabled:
      account?.auto_pay_enabled === null || account?.auto_pay_enabled === undefined
        ? Boolean((policyDefault as any)?.wallet_auto_pay_default ?? true)
        : Boolean(account.auto_pay_enabled),
    deposit: {
      presetsIrr: (cfgRow?.presets_irr || []).map((v: unknown) => num(v)),
      allowCustom: Boolean(cfgRow?.allow_custom ?? true),
      minIrr: num(cfgRow?.min_irr) || 500_000,
      maxIrr: num(cfgRow?.max_irr) || 5_000_000_000,
    },
    ledger: {
      entries: (ledgerRes.data || []).map((e: any) => ({
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

  const intentIds = (intents || []).map((i: any) => i.id);
  const { data: payments } = intentIds.length
    ? await sb.from('billing_payments').select('*').in('payment_intent_id', intentIds)
    : { data: [] as any[] };

  // Money that really arrived but could not be applied is customer-facing as
  // "under review" — never as a failure, and never as a raw internal enum.
  const underReview = new Set(
    (payments || [])
      .filter((p: any) => p.reconciliation_state && p.reconciliation_state !== 'applied')
      .map((p: any) => p.id as string),
  );
  const transactions = buildTransactionHistory((payments || []) as any, (intents || []) as any).map(
    (t) => (underReview.has(t.id) ? { ...t, needsReview: true } : t),
  );

  return {
    transactions,
    page,
    pageSize,
    total: count ?? 0,
  };
}
