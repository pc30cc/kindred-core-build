/**
 * SIMPLE BILLING — the hourly job (docs/billing/SIMPLE_BILLING.md,
 * Background work). It replaces billing v2's 5-minute ticker:
 *
 *   1. paid periods that ended: a prepaid next period starts, auto-renew pays
 *      from the balance, otherwise the workspace moves to Free at once (this
 *      step also runs every 5 minutes on its own, so the due moment is never
 *      more than a few minutes late; the billing page processes its own
 *      workspace at once);
 *   2. the month's AI credit of every running period (and trial);
 *   3. renewal reminders 7, 3 and 1 days before the due date;
 *   4. trials: a reminder 3 and 1 days before the end, then the end;
 *   5. gateway attempts that never finished, deleted after 30 days.
 *
 * Every step is idempotent in SQL (and each mail is recorded before it is
 * sent), so a second replica or a rerun does no harm; the ticker lease only
 * saves the double work.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { acquireTickerLease, releaseTickerLease } from '../../observability/tickerLease.js';
import { handleWorkspaceEntitlementChanged } from '../entitlementChange.js';
import { SHORT_LIVED_CHECKOUT_PROVIDERS } from './index.js';
import { billingIntervalLabel, localizedPlanName, planNamesFor, sendBillingEmail } from './notify.js';
import { afterPlanChange } from './plans.js';

const LEASE_NAME = 'simple_billing';
const DUE_LEASE_NAME = 'simple_billing_due';
const TICK_MS = 60 * 60 * 1000;
const DUE_TICK_MS = 5 * 60 * 1000;
/** Late enough that the app is serving before it starts. */
const FIRST_RUN_MS = 2 * 60 * 1000;
const DAY_MS = 86_400_000;

let timer: ReturnType<typeof setInterval> | null = null;
let dueTimer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dueRunning = false;

export function startSimpleBillingJob(config: ServerConfig): void {
  if (timer) return;
  first = setTimeout(() => void runSimpleBillingJob(config), FIRST_RUN_MS);
  timer = setInterval(() => void runSimpleBillingJob(config), TICK_MS);
  dueTimer = setInterval(() => void runSimpleBillingDue(config), DUE_TICK_MS);
  for (const t of [first, timer, dueTimer] as Array<{ unref?: () => void } | null>) t?.unref?.();
}

export function stopSimpleBillingJob(): void {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  if (dueTimer) clearInterval(dueTimer);
  first = null;
  timer = null;
  dueTimer = null;
}

export interface SimpleBillingJobReport {
  skipped?: boolean;
  due: { renewed: number; expired: number; failed: number };
  allowances: number;
  reminders: number;
  trials: { reminded: number; ended: number };
  pruned: number;
  errors: string[];
}

/** The renewal reminder due now for a period ending in `daysLeft` days (and the larger ones it supersedes). */
export function reminderNotice(daysLeft: number): string[] | null {
  if (daysLeft <= 1) return ['1', '3', '7'];
  if (daysLeft <= 3) return ['3', '7'];
  if (daysLeft <= 7) return ['7'];
  return null;
}

export function trialNotice(daysLeft: number): string[] | null {
  if (daysLeft <= 1) return ['1', '3'];
  if (daysLeft <= 3) return ['3'];
  return null;
}

const periodKey = (prefix: string, iso: string) => `${prefix}:${new Date(iso).toISOString()}`;

type DueReport = SimpleBillingJobReport['due'];

/** Paid periods that ended, one workspace at a time (each its own transaction). */
async function processDueWorkspaces(config: ServerConfig, due: DueReport, errors: string[]): Promise<void> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_account_due_workspaces', { p_limit: 500 });
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<string | { billing_account_due_workspaces?: string }>) {
    const workspaceId = typeof row === 'string' ? row : String(row.billing_account_due_workspaces ?? '');
    if (!workspaceId) continue;
    const { data: result, error: dueError } = await sb.rpc('billing_account_process_due', { p_workspace_id: workspaceId });
    if (dueError) {
      due.failed += 1;
      errors.push(`due ${workspaceId}: ${dueError.message}`);
      continue;
    }
    const r = (result ?? {}) as Record<string, unknown>;
    if (r.action === 'renewed') due.renewed += 1;
    else if (r.action === 'expired') due.expired += 1;
    if (r.action && r.action !== 'none') await afterPlanChange(config, workspaceId, r);
  }
}

/** Only the due step (every 5 minutes). */
export async function runSimpleBillingDue(config: ServerConfig): Promise<DueReport & { skipped?: boolean; errors: string[] }> {
  const due: DueReport = { renewed: 0, expired: 0, failed: 0 };
  const errors: string[] = [];
  if (dueRunning || running) return { ...due, errors, skipped: true };
  let leased = false;
  try {
    leased = await acquireTickerLease(config, DUE_LEASE_NAME);
  } catch {
    return { ...due, errors, skipped: true };
  }
  if (!leased) return { ...due, errors, skipped: true };
  dueRunning = true;
  try {
    await processDueWorkspaces(config, due, errors);
  } catch (e) {
    errors.push(`due: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    dueRunning = false;
    await releaseTickerLease(config, DUE_LEASE_NAME).catch(() => {});
  }
  if (errors.length) console.error('[simple-billing] due step failed', errors.slice(0, 5).join('; '));
  if (due.renewed || due.expired) console.log('[simple-billing] due', JSON.stringify({ ...due, errors: errors.length }));
  return { ...due, errors };
}

export async function runSimpleBillingJob(config: ServerConfig, now: Date = new Date()): Promise<SimpleBillingJobReport> {
  const report: SimpleBillingJobReport = {
    due: { renewed: 0, expired: 0, failed: 0 },
    allowances: 0,
    reminders: 0,
    trials: { reminded: 0, ended: 0 },
    pruned: 0,
    errors: [],
  };
  if (running) return { ...report, skipped: true };
  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch {
    return { ...report, skipped: true }; // a database blip: the next hour runs it
  }
  if (!leased) return { ...report, skipped: true };
  running = true;
  const sb = getServiceClient(config);
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      const message = `${name}: ${e instanceof Error ? e.message : String(e)}`;
      report.errors.push(message);
      console.error('[simple-billing] job step failed', message);
    }
  };
  try {
    // 1. Due periods.
    await step('due', () => processDueWorkspaces(config, report.due, report.errors));

    // 2. The month's AI credit.
    await step('allowances', async () => {
      const { data, error } = await sb.rpc('billing_account_grant_due_allowances');
      if (error) throw new Error(error.message);
      report.allowances = Number(data ?? 0);
    });

    // 3. Renewal reminders.
    await step('reminders', async () => {
      const { data, error } = await sb.rpc('billing_account_reminder_candidates', { p_days: 7 });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{
        workspace_id: string; plan_id: string; target_plan_id: string; billing_interval: string; period_end: string;
        currency: string; balance_minor: number; price_minor: number | null;
      }>;
      const plans = await planNamesFor(config, rows.flatMap((r) => [r.plan_id, r.target_plan_id]));
      for (const row of rows) {
        const daysLeft = Math.max(Math.ceil((Date.parse(row.period_end) - now.getTime()) / DAY_MS), 0);
        const notices = reminderNotice(daysLeft);
        if (!notices) continue;
        const key = periodKey('renewal', row.period_end);
        const { data: marked, error: markError } = await sb.rpc('billing_account_mark_notice', {
          p_workspace_id: row.workspace_id, p_key: key, p_notices: notices,
        });
        if (markError) throw new Error(markError.message);
        if (marked !== true) continue;
        const sent = await sendBillingEmail(config, row.workspace_id, 'billing_renewal_reminder', (ctx) => ({
          // The plan that ends, and what the renewal buys (a scheduled change's plan and interval).
          plan_name: localizedPlanName(plans.get(row.plan_id), ctx.locale),
          new_plan_name: `${localizedPlanName(plans.get(row.target_plan_id), ctx.locale)} (${billingIntervalLabel(row.billing_interval, ctx.locale)})`,
          amount: row.price_minor === null ? '' : ctx.money(Number(row.price_minor), row.currency),
          balance: ctx.money(Number(row.balance_minor), row.currency),
          period_end: ctx.date(row.period_end),
          days_left: ctx.number(daysLeft),
        }));
        if (sent.sent) report.reminders += 1;
        else await sb.rpc('billing_account_unmark_notice', { p_workspace_id: row.workspace_id, p_key: key, p_notice: notices[0] });
      }
    });

    // 4. Trials.
    await step('trials', async () => {
      const { data, error } = await sb.rpc('billing_account_trial_candidates', { p_days: 3 });
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{ workspace_id: string; trial_end: string; ended: boolean }>) {
        if (row.ended) {
          const { data: ended, error: endError } = await sb.rpc('billing_account_end_trial', { p_workspace_id: row.workspace_id });
          if (endError) throw new Error(endError.message);
          if (ended !== true) continue;
          report.trials.ended += 1;
          await handleWorkspaceEntitlementChanged(config, { workspaceId: row.workspace_id, source: 'trial_expired' });
          await sendBillingEmail(config, row.workspace_id, 'billing_trial_ended', () => ({}));
          continue;
        }
        const daysLeft = Math.max(Math.ceil((Date.parse(row.trial_end) - now.getTime()) / DAY_MS), 0);
        const notices = trialNotice(daysLeft);
        if (!notices) continue;
        const key = periodKey('trial', row.trial_end);
        const { data: marked, error: markError } = await sb.rpc('billing_account_mark_notice', {
          p_workspace_id: row.workspace_id, p_key: key, p_notices: notices,
        });
        if (markError) throw new Error(markError.message);
        if (marked !== true) continue;
        const sent = await sendBillingEmail(config, row.workspace_id, 'billing_trial_ending', (ctx) => ({
          trial_end: ctx.date(row.trial_end),
          days_left: ctx.number(daysLeft),
        }));
        if (sent.sent) report.trials.reminded += 1;
        else await sb.rpc('billing_account_unmark_notice', { p_workspace_id: row.workspace_id, p_key: key, p_notice: notices[0] });
      }
    });

    // 5. Attempts that never finished.
    await step('prune', async () => {
      const { data, error } = await sb.rpc('billing_account_prune_payments', {
        p_days: 30,
        p_short_lived: [...SHORT_LIVED_CHECKOUT_PROVIDERS],
      });
      if (error) throw new Error(error.message);
      report.pruned = Number(data ?? 0);
    });
  } finally {
    running = false;
    await releaseTickerLease(config, LEASE_NAME).catch(() => {});
  }
  if (report.due.renewed || report.due.expired || report.allowances || report.reminders || report.trials.ended) {
    console.log('[simple-billing] job', JSON.stringify({ ...report, errors: report.errors.length }));
  }
  return report;
}
