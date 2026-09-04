// ============================================================
// BILLING V2 — customer notification worker.
//
// The queue is in the database (`billing_notification_jobs`, migration 121):
// claiming, deduplication, retry backoff and the attempt cap all live in SQL,
// so a crashed process loses nothing and two replicas can never send the same
// message twice. This module is only the delivery arm.
//
// Two rules dominate the design:
//   1. A notification failure must NEVER roll back money. Settlement, past-due
//      and fallback already committed before a job is ever claimed; the worst a
//      delivery error can do is mark its own row failed.
//   2. A missing address is a SKIP, not a failure — a customer without a phone
//      still gets the email, and neither one blocks the lifecycle.
//
// Runs in the project's own Express backend. No edge function, no pg_cron.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { sendEmail } from '../../email/index.js';
import { sendSms } from '../../sms/index.js';
import {
  normalizeLocale,
  renderNotification,
  type Channel,
  type NotificationType,
} from './templates.js';

export interface NotificationBatchResult {
  sent: number;
  skipped: number;
  failed: number;
  claimed: number;
}

interface JobRow {
  id: string;
  workspace_id: string;
  invoice_id: string | null;
  notification_type: string;
  channel: string;
  payload: Record<string, any> | null;
}

const KNOWN_TYPES = new Set<NotificationType>([
  'invoice_issued',
  'invoice_reminder',
  'invoice_due',
  'wallet_autopay_insufficient',
  'invoice_past_due',
  'payment_succeeded',
  'subscription_restored',
  'free_fallback',
]);

function formatIrr(amount: unknown): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${new Intl.NumberFormat('en-US').format(Math.round(n))} IRR`;
}

function formatMoment(value: unknown, locale: string): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-GB', {
      dateStyle: 'medium',
      timeZone: 'Asia/Tehran',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * The ONLY link we are willing to put in a customer email: an app-owned
 * origin from configuration, never a URL read out of a database row.
 */
function billingUrl(config: ServerConfig, workspaceId: string): string {
  const base = (config as any).publicAppBaseUrl || (config as any).publicChannelsBaseUrl || '';
  if (!base) return '';
  return `${String(base).replace(/\/+$/, '')}/app/${workspaceId}/billing`;
}

export async function runNotificationWorker(
  config: ServerConfig,
  limit = 25,
): Promise<NotificationBatchResult> {
  const sb = getServiceClient(config);
  const result: NotificationBatchResult = { sent: 0, skipped: 0, failed: 0, claimed: 0 };

  const { data: claimed, error } = await sb.rpc('billing_v2_claim_notification_jobs', {
    p_limit: limit,
    p_lease_seconds: 180,
  });
  if (error) throw new Error(String(error.message || 'billing_v2_claim_notification_jobs_failed'));

  const jobs = (claimed as JobRow[] | null) ?? [];
  result.claimed = jobs.length;

  for (const job of jobs) {
    try {
      const outcome = await deliver(config, job);
      if (outcome.skipped) {
        await sb.rpc('billing_v2_skip_notification_job', {
          p_job_id: job.id,
          p_reason: outcome.reason ?? 'skipped',
        });
        result.skipped += 1;
      } else if (outcome.sent) {
        await sb.rpc('billing_v2_complete_notification_job', {
          p_job_id: job.id,
          p_detail: { provider: outcome.provider ?? null },
        });
        result.sent += 1;
      } else {
        await sb.rpc('billing_v2_fail_notification_job', {
          p_job_id: job.id,
          p_error: outcome.reason ?? 'delivery_failed',
        });
        result.failed += 1;
      }
    } catch (err: any) {
      // A thrown delivery error is contained here: the money is already
      // committed and only this row is marked.
      try {
        await sb.rpc('billing_v2_fail_notification_job', {
          p_job_id: job.id,
          p_error: String(err?.message || err).slice(0, 500),
        });
      } catch {
        // The marking itself failing must not escape: the lease expires and
        // the bounded retry policy picks the row up again.
      }
      result.failed += 1;
    }
  }

  return result;
}

interface DeliveryOutcome {
  sent?: boolean;
  skipped?: boolean;
  reason?: string;
  provider?: string;
}

async function deliver(config: ServerConfig, job: JobRow): Promise<DeliveryOutcome> {
  const sb = getServiceClient(config);
  const type = job.notification_type as NotificationType;
  const channel = job.channel as Channel;

  if (!KNOWN_TYPES.has(type)) return { skipped: true, reason: 'unknown_notification_type' };

  const { data: recipient } = await sb.rpc('billing_v2_billing_recipient', {
    p_workspace_id: job.workspace_id,
  });
  const target = channel === 'email' ? (recipient as any)?.email : (recipient as any)?.phone;
  if (!target) return { skipped: true, reason: 'skipped_no_recipient' };

  const locale = normalizeLocale((recipient as any)?.locale);
  const payload = job.payload ?? {};

  const { data: workspace } = await sb
    .from('workspaces')
    .select('name')
    .eq('id', job.workspace_id)
    .maybeSingle();

  const message = renderNotification(type, channel, locale, {
    workspaceName: String(workspace?.name || ''),
    invoiceNumber: String(payload.invoice_number || ''),
    amountLabel: formatIrr(payload.amount_irr),
    dueLabel: formatMoment(payload.due_at, locale),
    graceLabel: formatMoment(payload.grace_period_ends_at, locale),
    planName: String(payload.plan_name || ''),
    billingUrl: billingUrl(config, job.workspace_id),
  });

  if (channel === 'sms') {
    const res = await sendSms(config, { to: String(target), body: message.text });
    return res.success
      ? { sent: true, provider: res.provider }
      : { sent: false, reason: String(res.errorCode || 'sms_failed') };
  }

  const res = await sendEmail(config, {
    workspaceId: job.workspace_id,
    to: String(target),
    subject: message.subject,
    html: message.html,
    text: message.text,
    locale,
  });
  return res.success
    ? { sent: true, provider: res.provider }
    : { sent: false, reason: String(res.error || 'email_failed') };
}
