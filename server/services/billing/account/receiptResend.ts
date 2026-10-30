// ============================================================================
// SIMPLE BILLING — re-sending the payment receipts a provider failure lost.
//
// RESPOK's Resend account refused every send (HTTP 403) from 2026-10-09 to
// 2026-10-15, and a receipt mail had one attempt then (it is queued and
// retried since 289b), so those receipts never went out. A receipt can be
// rebuilt exactly from the billing records, never from the failed log row's
// own text: the ledger row its number names (receipt numbers are unique),
// the payment that row was for (the amount paid), and the balance the
// settlement left (the purpose's result, else the ledger row's own balance).
//
// planReceiptResend finds the failed receipt mails in a window and decides,
// for each, whether it can be re-sent: its number names a ledger row of the
// same workspace, no receipt mail with that number has gone out since (a
// re-run of this, or a send by hand), it is the first failure of that number
// in the list, and the workspace has a billing recipient today (the current
// one, not the address of then). applyReceiptResend queues each of those
// through the email outbox, once (its dedupe key names the ledger row).
// Nothing is written by the plan.
//
// The other billing mails of the window (plan activated, renewed, expired, a
// trial or a pack) are only counted: each described the account as it stood
// then, which has moved on since, so re-sending them is the owner's call,
// not this tool's. Invitations are re-sent from the members page.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { billingRecipient, sendBillingEmail } from './notify.js';

const RECEIPT_SLUG = 'billing_payment_receipt';
/** A window holds at most this many failed billing mails; anything past it is reported, not read. */
const MAX_ROWS = 2_000;

export type ReceiptResendSkip =
  | 'no_receipt_number'
  | 'receipt_not_found'
  | 'workspace_mismatch'
  | 'already_sent'
  | 'repeat'
  | 'no_recipient';

export interface ReceiptResendItem {
  logId: string;
  failedAt: string | null;
  workspaceId: string;
  receiptNumber: string | null;
  ledgerId: string | null;
  /** The billing recipient it would go to now. */
  recipient: string | null;
  skip: ReceiptResendSkip | null;
}

export interface ReceiptResendPlan {
  since: string;
  until: string;
  items: ReceiptResendItem[];
  /** Failed billing mails of the window that are not receipts, by template. */
  otherFailures: Record<string, number>;
  /** True when the window held more failed billing mails than were read. */
  truncated: boolean;
}

interface LogRow {
  id: string;
  workspace_id: string;
  template_slug: string | null;
  metadata: unknown;
  created_at: string | null;
}

interface LedgerRow {
  id: string;
  workspace_id: string;
  payment_id: string | null;
  receipt_number: string;
  currency: string;
  balance_after: number | string;
}

function receiptNumberOf(metadata: unknown): string | null {
  const data = (metadata as { templateData?: Record<string, unknown> } | null)?.templateData;
  const value = data && typeof data === 'object' ? data.receipt_number : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readLedger(config: ServerConfig, receiptNumber: string): Promise<LedgerRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_ledger')
    .select('id, workspace_id, payment_id, receipt_number, currency, balance_after')
    .eq('receipt_number', receiptNumber)
    .maybeSingle();
  if (error) throw new Error(`billing_account_ledger: ${error.message}`);
  return (data as LedgerRow | null) ?? null;
}

/** The receipt numbers whose mail went out for this workspace, at any time. */
async function sentReceiptNumbers(config: ServerConfig, workspaceId: string): Promise<Set<string>> {
  const { data, error } = await getServiceClient(config)
    .from('email_logs')
    .select('metadata')
    .eq('workspace_id', workspaceId)
    .eq('template_slug', RECEIPT_SLUG)
    .eq('status', 'sent')
    .limit(MAX_ROWS);
  if (error) throw new Error(`email_logs: ${error.message}`);
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{ metadata: unknown }>) {
    const number = receiptNumberOf(row.metadata);
    if (number) out.add(number);
  }
  return out;
}

/** What a re-send of the failed receipt mails in [since, until) would do. Writes nothing. */
export async function planReceiptResend(
  config: ServerConfig,
  window: { since: Date; until: Date },
): Promise<ReceiptResendPlan> {
  const since = window.since.toISOString();
  const until = window.until.toISOString();
  const { data, error } = await getServiceClient(config)
    .from('email_logs')
    .select('id, workspace_id, template_slug, metadata, created_at')
    .eq('status', 'failed')
    .like('template_slug', 'billing_*')
    .gte('created_at', since)
    .lt('created_at', until)
    .order('created_at', { ascending: true })
    .limit(MAX_ROWS + 1);
  if (error) throw new Error(`email_logs: ${error.message}`);
  const rows = (data ?? []) as LogRow[];
  const truncated = rows.length > MAX_ROWS;

  const items: ReceiptResendItem[] = [];
  const otherFailures: Record<string, number> = {};
  const sentByWorkspace = new Map<string, Set<string>>();
  const recipients = new Map<string, string | null>();
  const seen = new Set<string>();

  for (const row of rows.slice(0, MAX_ROWS)) {
    const slug = row.template_slug ?? '';
    if (slug !== RECEIPT_SLUG) {
      otherFailures[slug] = (otherFailures[slug] ?? 0) + 1;
      continue;
    }
    const item: ReceiptResendItem = {
      logId: row.id,
      failedAt: row.created_at,
      workspaceId: row.workspace_id,
      receiptNumber: receiptNumberOf(row.metadata),
      ledgerId: null,
      recipient: null,
      skip: null,
    };
    items.push(item);
    if (!item.receiptNumber) {
      item.skip = 'no_receipt_number';
      continue;
    }
    const ledger = await readLedger(config, item.receiptNumber);
    if (!ledger) {
      item.skip = 'receipt_not_found';
      continue;
    }
    item.ledgerId = ledger.id;
    if (ledger.workspace_id !== row.workspace_id) {
      item.skip = 'workspace_mismatch';
      continue;
    }
    let sent = sentByWorkspace.get(row.workspace_id);
    if (!sent) {
      sent = await sentReceiptNumbers(config, row.workspace_id);
      sentByWorkspace.set(row.workspace_id, sent);
    }
    if (sent.has(item.receiptNumber)) {
      item.skip = 'already_sent';
      continue;
    }
    if (seen.has(item.receiptNumber)) {
      item.skip = 'repeat';
      continue;
    }
    seen.add(item.receiptNumber);
    if (!recipients.has(row.workspace_id)) {
      recipients.set(row.workspace_id, (await billingRecipient(config, row.workspace_id))?.email ?? null);
    }
    item.recipient = recipients.get(row.workspace_id) ?? null;
    if (!item.recipient) item.skip = 'no_recipient';
  }

  return { since, until, items, otherFailures, truncated };
}

export interface ReceiptResendOutcome {
  queued: number;
  /** Sent at once because the outbox could not take them (before 289b). */
  sentNow: number;
  failed: Array<{ logId: string; error: string }>;
}

function finiteMinor(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Queues every receipt the plan can re-send, rebuilt from the ledger and the
 * payment: the receipt number, the amount paid, the balance the settlement
 * left. Once per ledger row, whatever is run again: the outbox's dedupe key
 * names it, and a receipt that went out is skipped by the next plan.
 */
export async function applyReceiptResend(config: ServerConfig, plan: ReceiptResendPlan): Promise<ReceiptResendOutcome> {
  const outcome: ReceiptResendOutcome = { queued: 0, sentNow: 0, failed: [] };
  const sb = getServiceClient(config);
  for (const item of plan.items) {
    if (item.skip || !item.receiptNumber) continue;
    try {
      const ledger = await readLedger(config, item.receiptNumber);
      if (!ledger || ledger.workspace_id !== item.workspaceId) throw new Error('receipt_not_found');
      const { data: payment } = ledger.payment_id
        ? await sb.from('billing_account_payments').select('amount_minor, currency, purpose_result').eq('id', ledger.payment_id).maybeSingle()
        : { data: null };
      const paid = payment as { amount_minor?: unknown; currency?: string; purpose_result?: Record<string, unknown> | null } | null;
      const amount = finiteMinor(paid?.amount_minor);
      if (amount === null) throw new Error('payment_not_found');
      const currency = paid?.currency || ledger.currency;
      const balance = finiteMinor(paid?.purpose_result?.balance_minor) ?? finiteMinor(ledger.balance_after) ?? 0;
      const result = await sendBillingEmail(
        config,
        item.workspaceId,
        'billing_payment_receipt',
        (ctx) => ({
          receipt_number: ledger.receipt_number,
          amount: ctx.money(amount, currency),
          balance: ctx.money(balance, currency),
        }),
        { receiptLedgerId: ledger.id, queue: true, dedupeKey: `billing_payment_receipt:resend:${ledger.id}` },
      );
      if (result.queued) outcome.queued += 1;
      else if (result.sent) outcome.sentNow += 1;
      else throw new Error(result.error ?? 'not_sent');
    } catch (e) {
      outcome.failed.push({ logId: item.logId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcome;
}
