// ============================================================================
// SIMPLE BILLING — Super Admin reads and the manual credit/debit (phase 6,
// migration 266; docs/billing/SIMPLE_BILLING.md).
//
// Every read here only reads: it never processes a due period, creates an
// account, syncs a card or asks Paddle (an admin looking at an account must
// not change it). The reports are thin wrappers over migration 266's STABLE
// functions; the one write is billing_account_admin_adjust, whose SQL
// exceptions are mapped to the route's error codes.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getProvider, resolveNamedBillingConfig } from '../index.js';
import { listGateways } from '../config/index.js';
import { getBillingRegion } from '../edition.js';
import { cardAutoRenewEnabled } from '../providers/paddleSubscriptions.js';
import { AccountBillingError, currentPlanView, getBillingSettings, getReceipt, listLedger, readAccount, type LedgerRow } from './index.js';
import { readLiveCard } from './card.js';
import { gatewayListing, gatewayNeedsConfig } from './gateways.js';
import { isProviderAllowedInEdition, isRialCurrency, type Edition } from '../../../../shared/edition.js';
import { isPaddleProvider, isTestPaymentProvider } from '../../../../shared/testGateways.js';
import { vatPercentFor } from '../../../../shared/simpleBilling.js';
import {
  ACCOUNT_CURRENCIES,
  bucketRevenue,
  localDayOf,
  revenueCalendarOf,
  revenueWindowDays,
  type AdjustCategory,
  type AdminAccountDetail,
  type AdminAccountRow,
  type AdminLedgerEntry,
  type AdminLedgerPage,
  type AdminPaymentRefund,
  type AdminPaymentRow,
  type AdminPaymentsPage,
  type GatewayReadiness,
  type GatewayReadinessReport,
  type LedgerDayRow,
  type LiabilityRow,
  type RevenueDayRow,
  type RevenueReport,
} from '../../../../shared/simpleBillingAdmin.js';

/** A workspace id no row has: resolves a gateway's platform-wide settings (no workspace override). */
const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function dbError(e: { message?: string } | null | undefined, fallback: string): never {
  throw new Error(e?.message || fallback);
}

function clampPage(page: { page?: number; pageSize?: number }, defaultSize = 25): { page: number; pageSize: number; offset: number } {
  const pageSize = Math.min(Math.max(Math.trunc(Number(page.pageSize)) || defaultSize, 1), 100);
  const current = Math.max(Math.trunc(Number(page.page)) || 1, 1);
  return { page: current, pageSize, offset: (current - 1) * pageSize };
}

// ─── Accounts list ─────────────────────────────────────────────────────────

function toAccountRow(row: Record<string, unknown>): AdminAccountRow {
  const card = row.card_status === 'active' || row.card_status === 'past_due' ? row.card_status : null;
  return {
    workspace_id: String(row.workspace_id),
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    workspace_status: strOrNull(row.workspace_status),
    owner_id: strOrNull(row.owner_id),
    owner_email: strOrNull(row.owner_email),
    has_account: row.has_account === true,
    currency: strOrNull(row.currency),
    balance_minor: num(row.balance_minor),
    auto_renew: row.auto_renew === true,
    next_period_prepaid_minor: numOrNull(row.next_period_prepaid_minor),
    next_period_start: strOrNull(row.next_period_start),
    scheduled_plan_id: strOrNull(row.scheduled_plan_id),
    scheduled_interval: strOrNull(row.scheduled_interval),
    plan_id: strOrNull(row.plan_id),
    plan_name: strOrNull(row.plan_name),
    plan_localized: row.plan_localized && typeof row.plan_localized === 'object' ? asRecord(row.plan_localized) : null,
    is_free: row.is_free === true,
    status: strOrNull(row.status),
    billing_interval: strOrNull(row.billing_interval),
    current_period_end: strOrNull(row.current_period_end),
    trial_end: strOrNull(row.trial_end),
    card_status: card,
    last_payment_at: strOrNull(row.last_payment_at),
    ledger_count: num(row.ledger_count),
    account_created_at: strOrNull(row.account_created_at),
  };
}

export interface AccountsQuery {
  q: string;
  filter: string;
  currency: string | null;
  sort: string;
  page: number;
  pageSize: number;
}

export async function listAdminAccounts(
  config: ServerConfig,
  query: AccountsQuery,
): Promise<{ total: number; page: number; pageSize: number; items: AdminAccountRow[] }> {
  const paging = clampPage(query);
  const { data, error } = await getServiceClient(config).rpc('billing_admin_accounts', {
    p_search: query.q.trim() || null,
    p_filter: query.filter,
    p_currency: query.currency,
    p_sort: query.sort,
    p_limit: paging.pageSize,
    p_offset: paging.offset,
  });
  if (error) {
    // The route validates first; the SQL's own guards still answer as a bad request.
    if (/billing_admin_bad_(filter|sort|currency)/.test(error.message || '')) throw new AccountBillingError('INVALID_REQUEST', 400);
    dbError(error, 'accounts read failed');
  }
  const body = asRecord(data);
  const items = Array.isArray(body.items) ? (body.items as unknown[]).map((r) => toAccountRow(asRecord(r))) : [];
  return { total: num(body.total), page: paging.page, pageSize: paging.pageSize, items };
}

// ─── Account detail ────────────────────────────────────────────────────────

async function readWorkspace(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('workspaces').select('id, name, slug, owner_id').eq('id', workspaceId).maybeSingle();
  if (error) dbError(error, 'workspace read failed');
  if (!data) return null;
  const ws = asRecord(data);
  const ownerId = strOrNull(ws.owner_id);
  let ownerEmail: string | null = null;
  if (ownerId) {
    const { data: owner } = await sb.from('profiles').select('email').eq('id', ownerId).maybeSingle();
    ownerEmail = strOrNull(asRecord(owner).email);
  }
  return { id: String(ws.id), name: String(ws.name ?? ''), slug: String(ws.slug ?? ''), owner: { id: ownerId, email: ownerEmail } };
}

async function planName(config: ServerConfig, planId: string | null): Promise<string | null> {
  if (!planId) return null;
  const { data } = await getServiceClient(config).from('billing_plans').select('name').eq('id', planId).maybeSingle();
  return strOrNull(asRecord(data).name);
}

/**
 * The account as Super Admin sees it, or null when the workspace does not
 * exist. Read only (decision D4): a workspace with no account shows the
 * region's currency and a zero balance, and nothing is created.
 */
export async function adminAccountDetail(config: ServerConfig, workspaceId: string, now = Date.now()): Promise<AdminAccountDetail | null> {
  const [workspace, account, plan, card, region] = await Promise.all([
    readWorkspace(config, workspaceId),
    readAccount(config, workspaceId),
    currentPlanView(config, workspaceId),
    readLiveCard(config, workspaceId),
    getBillingRegion(config),
  ]);
  if (!workspace) return null;
  const currency = account?.currency ?? region.currency;
  const [settings, scheduledName] = await Promise.all([
    getBillingSettings(config, region.edition),
    planName(config, account?.scheduled_plan_id ?? null),
  ]);
  const end = plan.current_period_end ? Date.parse(plan.current_period_end) : NaN;
  const dueUnprocessed = !plan.is_free
    && (plan.status === 'active' || plan.status === 'past_due')
    && Number.isFinite(end)
    && end <= now;
  return {
    workspace,
    has_account: Boolean(account),
    edition: region.edition,
    currency,
    balance_minor: account?.balance_minor ?? 0,
    auto_renew: account?.auto_renew ?? false,
    next_period_prepaid_minor: account?.next_period_prepaid_minor ?? null,
    next_period_start: account?.next_period_start ?? null,
    scheduled: account?.scheduled_plan_id
      ? { plan_id: account.scheduled_plan_id, plan_name: scheduledName, interval: account.scheduled_interval }
      : null,
    plan,
    due_unprocessed: dueUnprocessed,
    card: card
      ? {
          status: card.status === 'past_due' ? 'past_due' : 'active',
          provider: card.provider,
          brand: card.brand,
          last4: card.last4,
          paddle_next_billed_at: card.paddle_next_billed_at,
          cancel_intent: card.cancel_intent,
        }
      : null,
    billing_profile: (account?.billing_profile ?? {}) as Record<string, string>,
    vat_percent: vatPercentFor(settings.vat_percent, currency),
    account_created_at: account?.created_at || null,
  };
}

/** The account's ledger, newest first, with the email of the Super Admin behind each manual row. */
export async function listAdminLedger(
  config: ServerConfig,
  workspaceId: string,
  page: { page?: number; pageSize?: number },
): Promise<AdminLedgerPage> {
  const paging = clampPage(page, 20);
  const result = await listLedger(config, workspaceId, { page: paging.page, pageSize: paging.pageSize });
  const items = result.items.map((row) => {
    const { idempotency_key: _key, ...rest } = row as LedgerRow & { idempotency_key?: unknown; actor_id?: string | null };
    return rest as AdminLedgerEntry;
  });
  const actorIds = [...new Set(items.map((i) => i.actor_id).filter((id): id is string => Boolean(id)))];
  if (actorIds.length) {
    const { data } = await getServiceClient(config).from('profiles').select('id, email').in('id', actorIds);
    const emails = new Map(((data as Record<string, unknown>[] | null) ?? []).map((p) => [String(p.id), strOrNull(p.email)]));
    for (const item of items) item.actor_email = item.actor_id ? emails.get(item.actor_id) ?? null : null;
  }
  return { items, total: result.total, page: result.page, pageSize: result.pageSize };
}

export async function getAdminReceipt(config: ServerConfig, workspaceId: string, ledgerId: string): Promise<LedgerRow | null> {
  return getReceipt(config, workspaceId, ledgerId);
}

function toRefund(raw: unknown): AdminPaymentRefund {
  const r = asRecord(raw);
  return {
    refund_id: String(r.refund_id ?? ''),
    amount_minor: num(r.amount_minor),
    credit_minor: num(r.credit_minor),
    shortfall_minor: num(r.shortfall_minor),
    released_prepaid_minor: num(r.released_prepaid_minor),
    pack_returned_minor: num(r.pack_returned_minor),
    refunded_at: strOrNull(r.refunded_at),
  };
}

function toPaymentRow(raw: unknown): AdminPaymentRow {
  const r = asRecord(raw);
  const provider = String(r.provider ?? '');
  return {
    id: String(r.id),
    provider,
    is_test: isTestPaymentProvider(provider),
    source: String(r.source ?? 'checkout'),
    purpose: String(r.purpose ?? 'topup'),
    purpose_result: r.purpose_result && typeof r.purpose_result === 'object' ? asRecord(r.purpose_result) : null,
    status: String(r.status ?? ''),
    currency: String(r.currency ?? ''),
    amount_minor: num(r.amount_minor),
    net_minor: num(r.net_minor),
    tax_minor: num(r.tax_minor),
    tax_percent: numOrNull(r.tax_percent),
    refunded_minor: num(r.refunded_minor),
    refunds: Array.isArray(r.refunds) ? (r.refunds as unknown[]).map(toRefund) : [],
    failure_reason: strOrNull(r.failure_reason),
    provider_ref: strOrNull(r.provider_ref),
    provider_payment_id: strOrNull(r.provider_payment_id),
    ledger_id: strOrNull(r.ledger_id),
    card_id: strOrNull(r.card_id),
    review: strOrNull(r.review),
    created_at: String(r.created_at ?? ''),
    completed_at: strOrNull(r.completed_at),
  };
}

/** Every gateway attempt of the workspace, newest first, with its refunds. */
export async function listAdminPayments(
  config: ServerConfig,
  workspaceId: string,
  page: { page?: number; pageSize?: number },
): Promise<AdminPaymentsPage> {
  const paging = clampPage(page, 20);
  const { data, error } = await getServiceClient(config).rpc('billing_admin_account_payments', {
    p_workspace_id: workspaceId,
    p_limit: paging.pageSize,
    p_offset: paging.offset,
  });
  if (error) dbError(error, 'payments read failed');
  const body = asRecord(data);
  return {
    total: num(body.total),
    page: paging.page,
    pageSize: paging.pageSize,
    items: Array.isArray(body.items) ? (body.items as unknown[]).map(toPaymentRow) : [],
  };
}

// ─── Monthly revenue ───────────────────────────────────────────────────────

function rowsOf(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as unknown[]).map(asRecord) : [];
}

const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);

async function readLiability(config: ServerConfig): Promise<LiabilityRow[]> {
  const { data, error } = await getServiceClient(config).rpc('billing_admin_liability');
  if (error) dbError(error, 'liability read failed');
  return rowsOf(data).map((r) => ({
    currency: String(r.currency ?? '').toUpperCase(),
    accounts: num(r.accounts),
    positive_accounts: num(r.positive_accounts),
    balance_minor: num(r.balance_minor),
    prepaid_minor: num(r.prepaid_minor),
  }));
}

/**
 * Revenue per month and currency of the edition's calendar: the last
 * `months` (the current one to date). The SQL returns local days; the months
 * are made here (decision D12).
 */
export async function revenueReport(
  config: ServerConfig,
  options: { months: number; includeTest: boolean; now?: Date },
): Promise<RevenueReport> {
  const now = options.now ?? new Date();
  const region = await getBillingRegion(config);
  const { timeZone } = revenueCalendarOf(region.edition);
  const from = new Date(now.getTime() - revenueWindowDays(options.months) * 24 * 60 * 60 * 1000);
  const range = { p_from: from.toISOString(), p_to: now.toISOString(), p_time_zone: timeZone };
  const sb = getServiceClient(config);
  const [days, ledgerDays, liability] = await Promise.all([
    sb.rpc('billing_admin_revenue_days', range),
    sb.rpc('billing_admin_ledger_days', range),
    readLiability(config),
  ]);
  if (days.error) dbError(days.error, 'revenue read failed');
  if (ledgerDays.error) dbError(ledgerDays.error, 'ledger read failed');
  const dayRows: RevenueDayRow[] = rowsOf(days.data).map((r) => ({
    day: dayOf(r.day),
    metric: r.metric === 'refund' ? 'refund' : 'payment',
    currency: String(r.currency ?? ''),
    provider: String(r.provider ?? ''),
    source: String(r.source ?? 'checkout'),
    purpose: String(r.purpose ?? 'topup'),
    count: num(r.count),
    gross_minor: num(r.gross_minor),
    tax_minor: num(r.tax_minor),
    net_minor: num(r.net_minor),
  }));
  const ledgerRows: LedgerDayRow[] = rowsOf(ledgerDays.data).map((r) => ({
    day: dayOf(r.day),
    currency: String(r.currency ?? ''),
    kind: String(r.kind ?? ''),
    count: num(r.count),
    in_minor: num(r.in_minor),
    out_minor: num(r.out_minor),
  }));
  return bucketRevenue({
    edition: region.edition,
    today: localDayOf(now, timeZone),
    months: options.months,
    includeTest: options.includeTest,
    isTest: isTestPaymentProvider,
    days: dayRows,
    ledgerDays: ledgerRows,
    liability,
    currencies: ACCOUNT_CURRENCIES[region.edition],
  });
}

// ─── Gateway readiness ─────────────────────────────────────────────────────

/** The currencies a readiness card covers: the edition's, plus those of existing accounts (allowed in the edition). */
async function readinessCurrencies(config: ServerConfig, edition: Edition): Promise<string[]> {
  const out = [...ACCOUNT_CURRENCIES[edition]];
  for (const row of await readLiability(config).catch(() => [] as LiabilityRow[])) {
    if (edition !== 'iran' && isRialCurrency(row.currency)) continue;
    if (row.currency && !out.includes(row.currency)) out.push(row.currency);
  }
  return out;
}

/**
 * For every gateway of the edition and every account currency: is it listed
 * to customers, and if not, why (the same rule accountGateways applies, from
 * gatewayListing). Read only; a gateway's platform-wide settings are read
 * when the rule needs them, and Paddle's for its card renewal switch.
 */
export async function gatewayReadiness(config: ServerConfig): Promise<GatewayReadinessReport> {
  const region = await getBillingRegion(config);
  const edition = region.edition;
  const [currencies, gateways] = await Promise.all([readinessCurrencies(config, edition), listGateways(config)]);
  const ofEdition = gateways.filter((g) => isProviderAllowedInEdition(g.provider_name, edition));
  const out: GatewayReadiness[] = await Promise.all(
    ofEdition.map(async (g) => {
      const wantsConfig = gatewayNeedsConfig(g.provider_name) || isPaddleProvider(g.provider_name);
      const resolved = wantsConfig && getProvider(g.provider_name)
        ? await resolveNamedBillingConfig(config.supabaseUrl, config.supabaseServiceRoleKey, NO_WORKSPACE, g.provider_name).catch(() => null)
        : undefined;
      const settings = resolved === undefined ? undefined : resolved?.config ?? null;
      const listing: GatewayReadiness['listing'] = {};
      for (const currency of currencies) {
        listing[currency] = gatewayListing(g, currency, gatewayNeedsConfig(g.provider_name) ? settings ?? null : undefined, edition);
      }
      const row: GatewayReadiness = {
        provider_name: g.provider_name,
        display_name: g.display_name ?? {},
        is_active: g.is_active,
        is_test: g.is_test,
        implemented: g.implemented,
        currencies: edition === 'iran' ? g.currencies ?? [] : (g.currencies ?? []).filter((c) => !isRialCurrency(c)),
        listing,
      };
      if (isPaddleProvider(g.provider_name)) row.card_auto_renew = cardAutoRenewEnabled(settings ?? null);
      return row;
    }),
  );
  return { edition, currencies, gateways: out };
}

// ─── Manual credit and debit ───────────────────────────────────────────────

export interface AdminAdjustInput {
  workspaceId: string;
  /** Signed: + credit, − debit. */
  amountMinor: number;
  currency: string;
  reason: string;
  category: AdjustCategory;
  expectedBalanceMinor: number | null;
  commandKey: string;
  actorId: string;
}

export interface AdminAdjustOutcome {
  replayed: boolean;
  ledger_id: string;
  balance_minor: number;
}

/** SQL exception → HTTP status and code (design §3.2). Longest names first, so none hides another. */
const ADJUST_SQL_ERRORS: ReadonlyArray<[string, number, string]> = [
  ['billing_adjust_balance_changed', 409, 'BALANCE_CHANGED'],
  ['billing_account_currency_mismatch', 409, 'CURRENCY_CHANGED'],
  ['billing_insufficient_balance', 409, 'INSUFFICIENT_BALANCE'],
  ['billing_adjust_key_reused', 409, 'KEY_REUSED'],
  ['billing_adjust_too_large', 400, 'ADJUST_TOO_LARGE'],
  ['billing_adjust_reason_required', 400, 'INVALID_REQUEST'],
  ['billing_adjust_bad_category', 400, 'INVALID_REQUEST'],
  ['billing_adjust_missing_key', 400, 'INVALID_REQUEST'],
  ['billing_adjust_zero', 400, 'INVALID_REQUEST'],
];

export function adjustErrorOf(message: string | null | undefined): AccountBillingError | null {
  const text = message || '';
  for (const [sql, status, code] of ADJUST_SQL_ERRORS) {
    if (text.includes(sql)) return new AccountBillingError(code, status);
  }
  return null;
}

/**
 * Books a Super Admin credit (+) or debit (−) on the account, in one SQL
 * transaction (billing_account_admin_adjust, migration 266): the account is
 * created in `currency` when it has none, a replay of `commandKey` returns
 * the first booking, and a balance that moved since the admin looked
 * (`expectedBalanceMinor`) books nothing.
 */
export async function adminAdjust(config: ServerConfig, input: AdminAdjustInput): Promise<AdminAdjustOutcome> {
  const { data, error } = await getServiceClient(config).rpc('billing_account_admin_adjust', {
    p_workspace_id: input.workspaceId,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_reason: input.reason,
    p_actor_id: input.actorId,
    p_command_key: input.commandKey,
    p_category: input.category,
    p_expected_balance_minor: input.expectedBalanceMinor,
  });
  if (error) {
    const mapped = adjustErrorOf(error.message);
    if (mapped) throw mapped;
    dbError(error, 'admin adjust failed');
  }
  const body = asRecord(Array.isArray(data) ? data[0] : data);
  return { replayed: body.replayed === true, ledger_id: String(body.ledger_id ?? ''), balance_minor: num(body.balance_minor) };
}
