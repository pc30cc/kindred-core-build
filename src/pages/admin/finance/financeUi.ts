/**
 * Presentation helpers shared by the Super Admin billing screens (phase 6:
 * Revenue, Accounts, account detail). Nothing here computes money: amounts
 * come from the server in minor units of their own currency, and these
 * helpers only turn them, month keys and enums into what an admin reads.
 */
import type { TranslationKey } from '@/i18n';
import { parsePlanPriceInput, planPriceDecimals, planPriceToDisplay } from '@/lib/planPrice';
import { adjustAmountProblem, type AdminAccountRow, type RevenueReport, type RevenueRow } from '@/lib/adminSimpleBillingApi';
import { toMinorAmount } from '@/pages/app/billing/account/accountUi';

export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** The `Intl` tag of an app locale. */
export function intlTag(locale: string): string {
  if (locale === 'fa') return 'fa-IR';
  if (locale === 'tr') return 'tr-TR';
  return 'en-US';
}

/** `admin.simpleBilling.<path>`, or `fallback` (default: the last segment) when the key is missing. */
export function sbLabel(t: Translate, path: string, fallback?: string): string {
  const key = `admin.simpleBilling.${path}` as TranslationKey;
  const text = t(key);
  return text === key ? (fallback ?? path.split('.').pop() ?? path) : text;
}

/** A number in this locale without grouping (years, counts in labels). */
function plainNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(intlTag(locale), { useGrouping: false }).format(n);
}

/**
 * A month key of the report (`YYYY-MM` of its calendar) as people read it:
 * "Mehr 1405" / "مهر ۱۴۰۵" in the Jalali calendar, "October 2026" in the
 * Gregorian one. Jalali month names come from the translations so English
 * and Turkish read them too.
 */
export function monthLabel(key: string, calendar: RevenueReport['calendar'], locale: string, t: Translate): string {
  const [y, m] = key.split('-').map((part) => Number(part));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return key;
  if (calendar === 'jalali') {
    return `${sbLabel(t, `jalaliMonths.${m}`, String(m))} ${plainNumber(y, locale)}`;
  }
  return new Intl.DateTimeFormat(intlTag(locale), { month: 'long', year: 'numeric', timeZone: 'UTC', calendar: 'gregory' })
    .format(new Date(Date.UTC(y, m - 1, 15)));
}

/** A short month label for chart axes ("Mehr" / "Oct 26"). */
export function shortMonthLabel(key: string, calendar: RevenueReport['calendar'], locale: string, t: Translate): string {
  const [y, m] = key.split('-').map((part) => Number(part));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return key;
  if (calendar === 'jalali') return sbLabel(t, `jalaliMonths.${m}`, String(m));
  return new Intl.DateTimeFormat(intlTag(locale), { month: 'short', year: '2-digit', timeZone: 'UTC', calendar: 'gregory' })
    .format(new Date(Date.UTC(y, m - 1, 15)));
}

/** A stored amount in the unit people read (Toman for IRR, major units elsewhere), for charts and CSV. */
export function displayUnits(minor: number, currency: string): number {
  const value = planPriceToDisplay(minor, currency);
  const decimals = planPriceDecimals(currency);
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

/** The unit a CSV column of `currency` is in: Toman for IRR, else the code. */
export function csvUnit(currency: string): string {
  return currency.toUpperCase() === 'IRR' ? 'Toman' : currency.toUpperCase();
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV text (CRLF rows). Cells that start like a formula are quoted with a leading apostrophe. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (typeof cell === 'string' && /^[=+\-@\t\r]/.test(cell) && !/^-?\d/.test(cell) ? csvCell(`'${cell}`) : csvCell(cell)))
        .join(','),
    )
    .join('\r\n');
}

/** Saves CSV text as a file in the browser (UTF-8 with BOM, so Excel reads Persian). */
export function downloadCsv(filename: string, rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): void {
  const blob = new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A ledger `kind` as a label. */
export function kindLabel(t: Translate, kind: string): string {
  return sbLabel(t, `kinds.${kind}`, kind);
}

/** A plan status (`active`, `trialing`, …) as a label; null reads as "No plan". */
export function planStatusLabel(t: Translate, status: string | null | undefined): string {
  return sbLabel(t, `status.${status || 'none'}`, status || '');
}

export function intervalLabel(t: Translate, interval: string | null | undefined): string {
  return interval ? sbLabel(t, `interval.${interval}`, interval) : '';
}

/** Today's date as `YYYY-MM-DD` for file names. */
export function fileDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Accounts ──────────────────────────────────────────────────────────────

/** The period end is within a week (or already past): shown in red. */
export function periodEndSoon(iso: string | null | undefined, now = Date.now()): boolean {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at - now <= 7 * DAY_MS;
}


/** The current page as CSV rows, amounts in the unit people read. */
export function accountsCsvRows(items: readonly AdminAccountRow[]): Array<Array<string | number | boolean | null>> {
  const rows: Array<Array<string | number | boolean | null>> = [[
    'workspace_id', 'name', 'slug', 'owner_email', 'has_account', 'currency', 'unit', 'balance', 'prepaid_next_period',
    'plan', 'interval', 'status', 'current_period_end', 'auto_renew', 'card', 'last_payment_at',
  ]];
  for (const a of items) {
    const unit = a.currency ? csvUnit(a.currency) : '';
    rows.push([
      a.workspace_id, a.name, a.slug, a.owner_email, a.has_account, a.currency, unit,
      a.currency ? displayUnits(a.balance_minor, a.currency) : 0,
      a.currency && a.next_period_prepaid_minor ? displayUnits(a.next_period_prepaid_minor, a.currency) : 0,
      a.plan_name, a.billing_interval, a.status, a.current_period_end, a.auto_renew, a.card_status, a.last_payment_at,
    ]);
  }
  return rows;
}

// ─── Credit and debit ──────────────────────────────────────────────────────

export type AdjustDirection = 'credit' | 'debit';

/** What the admin typed, as minor units of `currency`, or null when it is not an amount above zero. */
export function amountToMinor(text: string, currency: string): number | null {
  const display = parsePlanPriceInput(text);
  if (display === null || display <= 0) return null;
  return toMinorAmount(display, currency);
}


export type AdjustProblem = 'invalid' | 'tooLarge' | 'overBalance' | null;

export function adjustProblem(direction: AdjustDirection, minor: number | null, balance: number, currency: string): AdjustProblem {
  if (minor === null) return 'invalid';
  const p = adjustAmountProblem(minor, currency);
  if (p === 'ADJUST_TOO_LARGE') return 'tooLarge';
  if (p) return 'invalid';
  if (direction === 'debit' && minor > balance) return 'overBalance';
  return null;
}

// ─── Revenue ───────────────────────────────────────────────────────────────

/** The rows of the last full month and of this calendar year so far, for one currency. */
export function kpiRows(report: RevenueReport, currency: string): { lastMonth: RevenueRow | null; ytd: RevenueRow[] } {
  const rows = report.rows.filter((r) => r.currency === currency);
  const months = report.months;
  const current = months[months.length - 1] ?? '';
  const lastKey = months.length >= 2 ? months[months.length - 2] : null;
  const year = current.slice(0, 4);
  const ytd = rows.filter((r) => r.month.startsWith(`${year}-`));
  return {
    lastMonth: lastKey ? rows.find((r) => r.month === lastKey) ?? null : null,
    ytd,
  };
}


/** The report as CSV rows: one per month and currency, amounts in the unit people read. */
export function revenueCsvRows(report: RevenueReport): Array<Array<string | number>> {
  const header = [
    'month', 'currency', 'unit', 'payments', 'gross', 'tax', 'net', 'refunds', 'refund_gross', 'refund_tax', 'refund_net', 'net_after_refunds',
  ];
  const rows: Array<Array<string | number>> = [header];
  for (const r of report.rows) {
    const u = (v: number) => displayUnits(v, r.currency);
    rows.push([
      r.month, r.currency, csvUnit(r.currency), r.payments, u(r.gross_minor), u(r.tax_minor), u(r.net_minor),
      r.refunds, u(r.refund_gross_minor), u(r.refund_tax_minor), u(r.refund_net_minor), u(r.net_after_refunds_minor),
    ]);
  }
  return rows;
}
