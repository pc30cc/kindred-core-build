// ============================================================
// BILLING NOTIFICATION DISPATCHER — Phase E.
//
// Drains `billing_notification_jobs`, which the SQL lifecycle fills. The
// division of responsibility is deliberate and absolute:
//
//   SQL decides WHETHER a customer must be told and writes ONE durable row
//   with a UNIQUE idempotency key. This module only delivers that row.
//
// Consequences that are load-bearing:
//   * A delivery failure never rolls back a settlement, a past-due transition
//     or a fallback — the money already moved, the message retries on its own.
//   * A replayed tick re-delivers nothing: the key was already consumed.
//   * A missing address or phone is a SKIP, not a failure. A workspace with no
//     verified phone still receives every email.
//
// Runs in the project's own Express backend. No edge function.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { bumpMetric } from '../rollout.js';
import { sendEmail } from '../../email/index.js';
import { sendSms } from '../../sms/index.js';
import { renderBillingNotification, buildBillingTemplateData, type BillingNotificationType } from './messages.js';

export interface NotificationBatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface NotificationJob {
  id: string;
  workspace_id: string;
  invoice_id: string | null;
  notification_type: BillingNotificationType;
  channel: 'email' | 'sms';
  locale: string | null;
  payload: Record<string, unknown>;
}

interface Recipient {
  email: string | null;
  phone: string | null;
  locale: string | null;
}

async function resolveRecipient(config: ServerConfig, workspaceId: string): Promise<Recipient> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_resolve_billing_recipient', {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(String(error.message || 'recipient_resolution_failed'));
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    locale: (r.locale as string | null) ?? null,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function dispatchBillingNotifications(
  config: ServerConfig,
  limit = 25,
): Promise<NotificationBatchResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_claim_notification_jobs', {
    p_limit: limit,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(String(error.message || 'billing_v2_claim_notification_jobs_failed'));

  const jobs = (data ?? []) as NotificationJob[];
  const result: NotificationBatchResult = { claimed: jobs.length, sent: 0, skipped: 0, failed: 0 };

  for (const job of jobs) {
    try {
      const rcpt = await resolveRecipient(config, job.workspace_id);
      const locale = job.locale || rcpt.locale;
      const msg = renderBillingNotification(job.notification_type, locale, job.payload || {});

      const target = job.channel === 'email' ? rcpt.email : rcpt.phone;
      if (!target) {
        // No address is a state of the world, not an error: it must never
        // burn retries and never block the other channel.
        result.skipped += 1;
        await sb.rpc('billing_v2_complete_notification_job', {
          p_job_id: job.id,
          p_status: 'skipped_no_recipient',
          p_error: `no_${job.channel}_on_file`,
        });
        continue;
      }

      const delivery =
        job.channel === 'email'
          ? await sendEmail(config, {
              workspaceId: job.workspace_id,
              to: target,
              // The branded copy lives in `email_templates` under a slug equal
              // to the notification type, edited in Branding → Email templates.
              // The rendered fallback below is used verbatim when an admin has
              // not authored a template for this slug/locale yet.
              templateSlug: job.notification_type,
              templateData: buildBillingTemplateData(locale, job.payload || {}),
              subject: msg.subject,
              text: msg.text,
              html: `<p>${escapeHtml(msg.text).replace(/\n/g, '<br />')}</p>`,
              locale: locale ?? undefined,
            })
          : await sendSms(config, { to: target, body: `${msg.subject}\n${msg.text}` });

      if (delivery.success) {
        result.sent += 1;
        bumpMetric('billing_v2_notifications_sent');
        await sb.rpc('billing_v2_complete_notification_job', {
          p_job_id: job.id,
          p_status: 'sent',
          p_error: null,
        });
      } else {
        result.failed += 1;
        bumpMetric('billing_v2_notification_failures');
        await sb.rpc('billing_v2_fail_notification_job', {
          p_job_id: job.id,
          p_error: String((delivery as { error?: string }).error || 'delivery_failed'),
        });
      }
    } catch (err: unknown) {
      // A thrown provider error is bounded-retry work, never a financial
      // rollback: the lifecycle that created this job already committed.
      result.failed += 1;
      bumpMetric('billing_v2_notification_failures');
      await sb.rpc('billing_v2_fail_notification_job', {
        p_job_id: job.id,
        p_error: String((err as Error)?.message || err),
      });
    }
  }

  return result;
}
