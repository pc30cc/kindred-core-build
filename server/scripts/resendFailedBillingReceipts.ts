/**
 * Re-sends the payment receipt mails a provider failure lost, rebuilt from
 * the billing records (services/billing/account/receiptResend.ts). Written
 * for RESPOK's receipts of 2026-10-09 to 2026-10-15, refused by Resend
 * (HTTP 403) and never re-sent; it works for any window on either brand.
 *
 * Dry run first, always: without --apply it only reads and prints what it
 * would send, and to whom (the workspace's billing recipient today).
 *
 * Run inside the backend container, the one that reaches the database and
 * the mail relay (the image holds server/ at /app):
 *
 *   docker exec -it <backend> npx tsx scripts/resendFailedBillingReceipts.ts --since=2026-10-09 --until=2026-10-16
 *   docker exec -it <backend> npx tsx scripts/resendFailedBillingReceipts.ts --since=2026-10-09 --until=2026-10-16 --apply
 *
 * --apply queues each receipt in the email outbox (migration 289b), which the
 * running backend sends within a minute; without the outbox it is sent at
 * once. Running it again sends nothing twice: a receipt that went out is
 * skipped, and the outbox's key names the ledger row.
 *
 * Flags:
 *   --since=<date>   Start of the window (ISO date or time, UTC). Required.
 *   --until=<date>   End of the window, exclusive (default: now).
 *   --apply          Queue the receipts. Without it, nothing is written.
 */
import { loadConfig } from '../config.js';
import { applyReceiptResend, planReceiptResend } from '../services/billing/account/receiptResend.js';
import { closeDataLayer } from '../db/index.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function parseDate(value: unknown, name: string): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    console.error(`--${name} must be a date, e.g. --${name}=2026-10-09`);
    process.exit(2);
  }
  return date;
}

/** "a***@example.com": enough to recognise an address in a terminal, not to copy it. */
function masked(address: string | null): string {
  if (!address) return '-';
  const at = address.lastIndexOf('@');
  return at > 0 ? `${address[0]}***${address.slice(at)}` : '***';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const since = parseDate(args.since, 'since');
  const until = args.until === undefined ? new Date() : parseDate(args.until, 'until');
  if (until.getTime() <= since.getTime()) {
    console.error('--until must be after --since');
    process.exit(2);
  }
  const config = loadConfig();
  const plan = await planReceiptResend(config, { since, until });

  console.log(`Failed receipt mails from ${plan.since} to ${plan.until}: ${plan.items.length}`);
  for (const item of plan.items) {
    console.log([
      item.failedAt ?? '-',
      item.workspaceId,
      item.receiptNumber ?? '-',
      masked(item.recipient),
      item.skip ? `skip: ${item.skip}` : 'resend',
    ].join('  '));
  }
  const others = Object.entries(plan.otherFailures);
  if (others.length) {
    console.log('Other failed billing mails in the window (not re-sent; they describe the account as it was then):');
    for (const [slug, count] of others) console.log(`  ${slug}: ${count}`);
  }
  if (plan.truncated) console.log('The window holds more failed billing mails than were read: narrow it and run again.');

  const due = plan.items.filter((item) => !item.skip).length;
  if (!args.apply) {
    console.log(`Dry run: ${due} receipt(s) would be re-sent. Run again with --apply to queue them.`);
    return;
  }
  const outcome = await applyReceiptResend(config, plan);
  console.log(`Queued: ${outcome.queued}. Sent at once: ${outcome.sentNow}. Failed: ${outcome.failed.length}.`);
  for (const failure of outcome.failed) console.log(`  ${failure.logId}: ${failure.error}`);
}

main()
  .catch((err) => {
    console.error('resendFailedBillingReceipts failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDataLayer().catch(() => undefined);
  });
