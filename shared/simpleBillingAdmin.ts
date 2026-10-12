/**
 * Super Admin billing screens of the simple billing (phase 6, migration 266;
 * docs/billing/SIMPLE_BILLING.md): the rules and response shapes shared by
 * the server (server/routes/adminSimpleBilling.ts) and the browser
 * (src/lib/adminSimpleBillingApi.ts). Pure: no I/O.
 *
 * Amounts are integers in the minor units of their own currency (Rial for
 * IRR, cents, kuruş). Nothing here ever adds amounts of two currencies.
 */

import { TOPUP_LIMITS } from './simpleBilling.js';
import { EDITION_PROFILE, editionDefaultTimeZone, type Edition } from './edition.js';

// ─── Manual credit and debit ───────────────────────────────────────────────

/** Why Super Admin moved a balance; stored as `description.category` on the ledger row. */
export const ADJUST_CATEGORIES = ['goodwill', 'compensation', 'correction', 'migration', 'test', 'other'] as const;
export type AdjustCategory = (typeof ADJUST_CATEGORIES)[number];

export function isAdjustCategory(value: unknown): value is AdjustCategory {
  return typeof value === 'string' && (ADJUST_CATEGORIES as readonly string[]).includes(value);
}

/** The reason is required: 3 to 500 characters after trimming (the SQL checks the same). */
export const ADJUST_REASON_MIN = 3;
export const ADJUST_REASON_MAX = 500;

export function adjustReasonValid(reason: unknown): reason is string {
  if (typeof reason !== 'string') return false;
  const length = reason.trim().length;
  return length >= ADJUST_REASON_MIN && length <= ADJUST_REASON_MAX;
}

export type AdjustAmountProblem = 'ADJUST_AMOUNT_INVALID' | 'ADJUST_TOO_LARGE' | 'CURRENCY_NOT_SUPPORTED';

/**
 * Why a credit or debit of `minor` (its size, always positive) cannot be
 * booked in `currency`, or null when it can. The cap is the largest top-up
 * of the currency (TOPUP_LIMITS.max), the same one the SQL enforces.
 */
export function adjustAmountProblem(minor: unknown, currency: string): AdjustAmountProblem | null {
  const limits = TOPUP_LIMITS[(currency || '').toUpperCase()];
  if (!limits) return 'CURRENCY_NOT_SUPPORTED';
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor <= 0) return 'ADJUST_AMOUNT_INVALID';
  if (minor > limits.max) return 'ADJUST_TOO_LARGE';
  return null;
}

/** At most this many credits and debits per Super Admin per window, per server process. */
export const ADJUST_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 } as const;

/** The error codes POST .../adjust answers with (besides INVALID_REQUEST and NOT_FOUND). */
export const ADJUST_ERROR_CODES = [
  'BALANCE_CHANGED',
  'CURRENCY_CHANGED',
  'INSUFFICIENT_BALANCE',
  'ADJUST_TOO_LARGE',
  'KEY_REUSED',
  'TOO_MANY_ADJUSTMENTS',
] as const;
export type AdjustErrorCode = (typeof ADJUST_ERROR_CODES)[number];

export interface AdjustRequest {
  direction: 'credit' | 'debit';
  /** The size of the movement, in minor units of `currency` (always > 0). */
  amountMinor: number;
  /** The currency the dialog showed; the server answers 409 CURRENCY_CHANGED when the account's differs. */
  currency: string;
  reason: string;
  category: AdjustCategory;
  /** The balance the dialog showed; 409 BALANCE_CHANGED when it moved since. */
  expectedBalanceMinor: number;
  /** A uuid made when the dialog opened; a retry with it replays instead of booking twice. */
  commandKey: string;
}

export interface AdjustResult {
  replayed: boolean;
  ledger_id: string;
  balance_minor: number;
  account: AdminAccountDetail;
}

// ─── Accounts list ─────────────────────────────────────────────────────────

/** The currencies an account can have in each edition: Toman (IRR) in Iran; USD (Multi Region, Global) and TRY (Turkey) abroad. */
export const ACCOUNT_CURRENCIES: Readonly<Record<Edition, readonly string[]>> = {
  iran: ['IRR'],
  international: ['USD', 'TRY'],
};

/** `owner:<uuid>` is accepted besides these (the Users page's card). */
export const ACCOUNT_FILTERS = ['with_account', 'all', 'positive_balance', 'auto_renew', 'card', 'prepaid', 'due_7d'] as const;
export type AccountFilter = (typeof ACCOUNT_FILTERS)[number];

export const ACCOUNT_SORTS = ['balance_desc', 'period_end_asc', 'last_payment_desc', 'created_desc', 'name_asc'] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The filter as the SQL takes it, or null when it is not one. An empty value is the default. */
export function parseAccountFilter(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return 'with_account';
  if (typeof raw !== 'string') return null;
  if ((ACCOUNT_FILTERS as readonly string[]).includes(raw)) return raw;
  const owner = /^owner:(.+)$/.exec(raw);
  return owner && isUuid(owner[1]) ? `owner:${owner[1].toLowerCase()}` : null;
}

export interface AdminAccountRow {
  workspace_id: string;
  name: string;
  slug: string;
  /** `active`, or `deleting` while a deletion job runs. */
  workspace_status: string | null;
  owner_id: string | null;
  owner_email: string | null;
  has_account: boolean;
  currency: string | null;
  balance_minor: number;
  auto_renew: boolean;
  next_period_prepaid_minor: number | null;
  next_period_start: string | null;
  scheduled_plan_id: string | null;
  scheduled_interval: string | null;
  plan_id: string | null;
  plan_name: string | null;
  plan_localized: Record<string, unknown> | null;
  is_free: boolean;
  status: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  /** The live saved card, else null. */
  card_status: 'active' | 'past_due' | null;
  last_payment_at: string | null;
  ledger_count: number;
  account_created_at: string | null;
}

export interface AdminAccountsPage {
  edition: Edition;
  /** The account currencies this edition can have (the filter's choices). */
  currencies: string[];
  total: number;
  page: number;
  pageSize: number;
  items: AdminAccountRow[];
}

// ─── Account detail ────────────────────────────────────────────────────────

/** The plan the workspace is on now (the same view the workspace's billing page reads). */
export interface AdminPlanView {
  plan_id: string | null;
  slug: string | null;
  name: string | null;
  localized: Record<string, unknown>;
  is_free: boolean;
  status: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
}

export interface AdminCardSummary {
  status: 'active' | 'past_due';
  provider: string;
  brand: string | null;
  last4: string | null;
  paddle_next_billed_at: string | null;
  cancel_intent: 'period_end' | 'now' | null;
}

export interface AdminAccountDetail {
  workspace: { id: string; name: string; slug: string; owner: { id: string | null; email: string | null } };
  has_account: boolean;
  edition: Edition;
  /** The account's currency, else the region's (what a credit would be booked in). */
  currency: string;
  balance_minor: number;
  auto_renew: boolean;
  next_period_prepaid_minor: number | null;
  next_period_start: string | null;
  scheduled: { plan_id: string; plan_name: string | null; interval: string | null } | null;
  plan: AdminPlanView;
  /** The period has ended but the job has not processed it yet ("Due, waits for the job"). */
  due_unprocessed: boolean;
  card: AdminCardSummary | null;
  billing_profile: Record<string, string>;
  vat_percent: number | null;
  account_created_at: string | null;
}

export interface AdminLedgerEntry {
  id: string;
  kind: string;
  amount_minor: number;
  balance_after: number;
  currency: string;
  plan_id: string | null;
  billing_interval: string | null;
  period_start: string | null;
  period_end: string | null;
  payment_id: string | null;
  receipt_number: string | null;
  net_minor: number | null;
  tax_minor: number | null;
  tax_percent: number | null;
  buyer: Record<string, string> | null;
  seller: Record<string, string> | null;
  description: Record<string, unknown>;
  created_at: string;
  plan_name?: string | null;
  plan_localized?: Record<string, unknown> | null;
  actor_id?: string | null;
  /** The Super Admin who booked an admin_credit / admin_debit row. */
  actor_email?: string | null;
}

export interface AdminLedgerPage {
  items: AdminLedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPaymentRefund {
  refund_id: string;
  amount_minor: number;
  credit_minor: number;
  shortfall_minor: number;
  released_prepaid_minor: number;
  /** What an AI credit pack the refund reversed returned to the balance first (phase 5). */
  pack_returned_minor: number;
  refunded_at: string | null;
}

export interface AdminPaymentRow {
  id: string;
  provider: string;
  /** A sandbox or simulator gateway (isTestPaymentProvider). */
  is_test: boolean;
  source: string;
  purpose: string;
  purpose_result: Record<string, unknown> | null;
  status: string;
  currency: string;
  amount_minor: number;
  net_minor: number;
  tax_minor: number;
  tax_percent: number | null;
  refunded_minor: number;
  refunds: AdminPaymentRefund[];
  failure_reason: string | null;
  provider_ref: string | null;
  provider_payment_id: string | null;
  ledger_id: string | null;
  card_id: string | null;
  review: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AdminPaymentsPage {
  total: number;
  page: number;
  pageSize: number;
  items: AdminPaymentRow[];
}

// ─── Monthly revenue ───────────────────────────────────────────────────────

export type RevenueCalendar = 'jalali' | 'gregorian';

/** The calendar and time zone an edition's revenue is bucketed in. */
export function revenueCalendarOf(edition: Edition): { calendar: RevenueCalendar; timeZone: string } {
  return { calendar: EDITION_PROFILE[edition].calendar, timeZone: editionDefaultTimeZone(edition) };
}

export const REVENUE_MONTHS = { min: 1, max: 36, default: 12 } as const;

const monthFormatters = new Map<RevenueCalendar, Intl.DateTimeFormat>();

function monthFormatter(calendar: RevenueCalendar): Intl.DateTimeFormat {
  let f = monthFormatters.get(calendar);
  if (!f) {
    f = new Intl.DateTimeFormat(calendar === 'jalali' ? 'en-u-ca-persian-nu-latn' : 'en-u-ca-gregory-nu-latn', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'numeric',
    });
    monthFormatters.set(calendar, f);
  }
  return f;
}

/**
 * The month a local calendar day (`YYYY-MM-DD`, already in the edition's
 * time zone) belongs to, as `YYYY-MM` of `calendar`: `1405-07` for
 * 2026-10-11 in the Jalali calendar, `2026-10` in the Gregorian one. The day
 * is formatted at noon UTC, so no time zone can move it to another day.
 */
export function monthKeyOf(day: string, calendar: RevenueCalendar): string {
  const at = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) throw new RangeError(`not a day: ${day}`);
  let year = '';
  let month = '';
  for (const part of monthFormatter(calendar).formatToParts(at)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}`;
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone`. */
export function localDayOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `YYYY-MM-DD` shifted by `days` (Gregorian arithmetic on the label itself). */
function addDays(day: string, days: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** How far back the report reads: `(months + 1) × 31` days, so every month it keeps is complete. */
export function revenueWindowDays(months: number): number {
  return (months + 1) * 31;
}

/**
 * The `months` month keys that end with the month of `today` (a local day),
 * oldest first. The current month is month-to-date; every other one is whole.
 */
export function monthKeysEnding(today: string, months: number, calendar: RevenueCalendar): string[] {
  const keys: string[] = [];
  for (let i = 0; i <= revenueWindowDays(months) && keys.length < months; i++) {
    const key = monthKeyOf(addDays(today, -i), calendar);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys.reverse();
}

/** One row of billing_admin_revenue_days. */
export interface RevenueDayRow {
  day: string;
  metric: 'payment' | 'refund';
  currency: string;
  provider: string;
  source: string;
  purpose: string;
  count: number;
  gross_minor: number;
  tax_minor: number;
  net_minor: number;
}

/** One row of billing_admin_ledger_days. */
export interface LedgerDayRow {
  day: string;
  currency: string;
  kind: string;
  count: number;
  in_minor: number;
  out_minor: number;
}

/** One row of billing_admin_liability (a snapshot of billing_accounts now). */
export interface LiabilityRow {
  currency: string;
  accounts: number;
  positive_accounts: number;
  balance_minor: number;
  prepaid_minor: number;
}

export interface RevenueSums {
  payments: number;
  gross_minor: number;
  tax_minor: number;
  net_minor: number;
  refunds: number;
  refund_gross_minor: number;
  refund_tax_minor: number;
  refund_net_minor: number;
  /** net_minor − refund_net_minor. */
  net_after_refunds_minor: number;
}

export interface RevenueSplit {
  count: number;
  gross_minor: number;
  tax_minor: number;
  net_minor: number;
}

export interface RevenueRow extends RevenueSums {
  month: string;
  currency: string;
  /** Payments only (refunds are in the refund_* fields). */
  by_purpose: Record<string, RevenueSplit>;
  by_provider: Record<string, { count: number; gross_minor: number; net_minor: number; is_test: boolean }>;
  by_source: Record<string, { count: number; gross_minor: number; net_minor: number }>;
}

export interface RevenueLedgerRow {
  month: string;
  currency: string;
  kind: string;
  count: number;
  in_minor: number;
  out_minor: number;
}

export interface RevenueReport {
  edition: Edition;
  calendar: RevenueCalendar;
  time_zone: string;
  /** Month keys (`YYYY-MM` of the calendar), oldest first; the last is the current month to date. */
  months: string[];
  currencies: string[];
  include_test: boolean;
  /** One row per month and currency, zeros included, months oldest first. */
  rows: RevenueRow[];
  /** Balance movements by kind: not revenue. */
  ledger: RevenueLedgerRow[];
  liability: LiabilityRow[];
  /** Per currency, over all `months`. */
  totals: Record<string, RevenueSums>;
}

function emptySums(): RevenueSums {
  return {
    payments: 0,
    gross_minor: 0,
    tax_minor: 0,
    net_minor: 0,
    refunds: 0,
    refund_gross_minor: 0,
    refund_tax_minor: 0,
    refund_net_minor: 0,
    net_after_refunds_minor: 0,
  };
}

function addSums(into: RevenueSums, from: RevenueSums): void {
  into.payments += from.payments;
  into.gross_minor += from.gross_minor;
  into.tax_minor += from.tax_minor;
  into.net_minor += from.net_minor;
  into.refunds += from.refunds;
  into.refund_gross_minor += from.refund_gross_minor;
  into.refund_tax_minor += from.refund_tax_minor;
  into.refund_net_minor += from.refund_net_minor;
  into.net_after_refunds_minor = into.net_minor - into.refund_net_minor;
}

export interface BucketRevenueInput {
  edition: Edition;
  /** The edition's local day today (localDayOf(now, timeZone)). */
  today: string;
  months: number;
  includeTest: boolean;
  isTest: (provider: string) => boolean;
  days: readonly RevenueDayRow[];
  ledgerDays: readonly LedgerDayRow[];
  liability: readonly LiabilityRow[];
  /** Currencies always shown (the edition's), even with no money yet. */
  currencies: readonly string[];
}

/**
 * Groups the daily rows into the edition's calendar months: the last
 * `months` of them (the current one to date), one row per month and
 * currency. Days outside those months (the partial oldest month the window
 * reaches into) are dropped. Test gateways' payments and refunds are left
 * out unless `includeTest`. Never adds two currencies together.
 */
export function bucketRevenue(input: BucketRevenueInput): RevenueReport {
  const { calendar, timeZone } = revenueCalendarOf(input.edition);
  const months = monthKeysEnding(input.today, input.months, calendar);
  const kept = new Set(months);

  const currencies: string[] = [];
  const addCurrency = (c: string) => {
    const code = (c || '').toUpperCase();
    if (code && !currencies.includes(code)) currencies.push(code);
  };
  input.currencies.forEach(addCurrency);

  const monthOf = new Map<string, string>();
  const keyOfDay = (day: string): string => {
    let key = monthOf.get(day);
    if (key === undefined) {
      key = monthKeyOf(day, calendar);
      monthOf.set(day, key);
    }
    return key;
  };

  const rows = new Map<string, RevenueRow>();
  const rowFor = (month: string, currency: string): RevenueRow => {
    const id = `${month}|${currency}`;
    let row = rows.get(id);
    if (!row) {
      row = { month, currency, ...emptySums(), by_purpose: {}, by_provider: {}, by_source: {} };
      rows.set(id, row);
    }
    return row;
  };

  for (const d of input.days) {
    const month = keyOfDay(d.day);
    if (!kept.has(month)) continue;
    const test = input.isTest(d.provider);
    if (test && !input.includeTest) continue;
    const currency = d.currency.toUpperCase();
    addCurrency(currency);
    const row = rowFor(month, currency);
    if (d.metric === 'payment') {
      row.payments += d.count;
      row.gross_minor += d.gross_minor;
      row.tax_minor += d.tax_minor;
      row.net_minor += d.net_minor;
      const purpose = (row.by_purpose[d.purpose] ??= { count: 0, gross_minor: 0, tax_minor: 0, net_minor: 0 });
      purpose.count += d.count;
      purpose.gross_minor += d.gross_minor;
      purpose.tax_minor += d.tax_minor;
      purpose.net_minor += d.net_minor;
      const provider = (row.by_provider[d.provider] ??= { count: 0, gross_minor: 0, net_minor: 0, is_test: test });
      provider.count += d.count;
      provider.gross_minor += d.gross_minor;
      provider.net_minor += d.net_minor;
      const source = (row.by_source[d.source] ??= { count: 0, gross_minor: 0, net_minor: 0 });
      source.count += d.count;
      source.gross_minor += d.gross_minor;
      source.net_minor += d.net_minor;
    } else {
      row.refunds += d.count;
      row.refund_gross_minor += d.gross_minor;
      row.refund_tax_minor += d.tax_minor;
      row.refund_net_minor += d.net_minor;
    }
    row.net_after_refunds_minor = row.net_minor - row.refund_net_minor;
  }

  const ledger = new Map<string, RevenueLedgerRow>();
  for (const l of input.ledgerDays) {
    const month = keyOfDay(l.day);
    if (!kept.has(month)) continue;
    const currency = l.currency.toUpperCase();
    addCurrency(currency);
    const id = `${month}|${currency}|${l.kind}`;
    const row = ledger.get(id) ?? { month, currency, kind: l.kind, count: 0, in_minor: 0, out_minor: 0 };
    row.count += l.count;
    row.in_minor += l.in_minor;
    row.out_minor += l.out_minor;
    ledger.set(id, row);
  }

  for (const l of input.liability) addCurrency(l.currency);

  const outRows: RevenueRow[] = [];
  const totals: Record<string, RevenueSums> = {};
  for (const currency of currencies) {
    const total = emptySums();
    for (const month of months) {
      const row = rowFor(month, currency);
      addSums(total, row);
      outRows.push(row);
    }
    totals[currency] = total;
  }

  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const outLedger = [...ledger.values()].sort(
    (a, b) =>
      (monthIndex.get(a.month) ?? 0) - (monthIndex.get(b.month) ?? 0) ||
      currencies.indexOf(a.currency) - currencies.indexOf(b.currency) ||
      a.kind.localeCompare(b.kind),
  );

  return {
    edition: input.edition,
    calendar,
    time_zone: timeZone,
    months,
    currencies,
    include_test: input.includeTest,
    rows: outRows,
    ledger: outLedger,
    liability: input.liability.map((l) => ({ ...l, currency: l.currency.toUpperCase() })),
    totals,
  };
}

// ─── Gateway readiness ─────────────────────────────────────────────────────

/**
 * Why a gateway is not listed to customers for a currency:
 * - `not_in_edition`: the gateway does not exist in this edition;
 * - `inactive`: switched off in Finance → Gateways (or no handler ships);
 * - `currency`: not set for this currency in Finance → Gateways, or it cannot charge it;
 * - `cannot_confirm`: the server cannot look its payment up (no verify path), or it has no usable settings;
 * - `test`: a sandbox shown to platform admins only;
 * - `not_configured`: its settings are missing something it needs to take a
 *   payment (ZarinPal's merchant id, Paddle's keys and webhook secret); the
 *   listing's `problem` names it.
 */
export const GATEWAY_LISTING_REASONS = ['not_in_edition', 'inactive', 'currency', 'cannot_confirm', 'test', 'not_configured'] as const;
export type GatewayListingReason = (typeof GATEWAY_LISTING_REASONS)[number];

export interface GatewayListing {
  listed: boolean;
  reasons: GatewayListingReason[];
  /** With `not_configured`: what is missing or wrong in the gateway's settings, for the Super Admin. */
  problem?: string;
}

export interface GatewayReadiness {
  provider_name: string;
  display_name: Record<string, string>;
  is_active: boolean;
  is_test: boolean;
  implemented: boolean;
  /** Finance → Gateways' currencies (empty = any). */
  currencies: string[];
  /** Per account currency of the edition. */
  listing: Record<string, GatewayListing>;
  /** Paddle only: the Super Admin's "Automatic card renewal (Multi Region)" switch. */
  card_auto_renew?: boolean;
}

export interface GatewayReadinessReport {
  edition: Edition;
  currencies: string[];
  gateways: GatewayReadiness[];
}

// ─── Plans form (server/routes/plans.ts) ───────────────────────────────────

/**
 * Locked-data retention: empty (null) = never deleted, else 1 to 36500 days
 * (phase 4's range: the plan editor and the API accept the same values).
 */
export const PLAN_RETENTION_DAYS = { min: 1, max: 36_500 } as const;
