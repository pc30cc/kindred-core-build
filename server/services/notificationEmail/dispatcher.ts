/**
 * THE ONE PLACE A QUEUED JOB BECOMES MAIL.
 *
 * Producers decide there is something to say. This decides whether to say it
 * — and it asks the same two questions the producer asked, again, because
 * time has passed: a digest queued at 2am for 8am must not go if the
 * platform switched the type off at 7, or if the operator did.
 *
 * Quiet hours move a job rather than dropping it. None of these are urgent —
 * urgent is what push is for — so an operator whose night is 22:00–08:00
 * gets their digest at breakfast rather than not at all. The window is read
 * from the operator's BROWSER preferences, which is where quiet hours are
 * set for the person rather than for a device.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail } from '../email/index.js';
import { isWithinQuietHours } from '../push/recipients.js';
import {
  isTypeEnabled,
  loadNotificationEmailSettings,
  type NotificationEmailSettings,
} from './settings.js';
import { operatorWants } from './queue.js';
import { NOTIFICATION_EMAILS, isNotificationEmailType, type NotificationEmailType } from './types.js';

/** Where an override provider's config lives, when one is chosen. */
export const OVERRIDE_PROVIDER_KEY = 'notification_email_provider';

/** How many jobs one pass will send. Bounded so a backlog drains steadily. */
const BATCH = 25;
/** After this many tries a job is a failure rather than a retry. */
const MAX_ATTEMPTS = 3;

export interface DispatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
}

interface JobRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  locale: string | null;
  attempts: number;
}

/**
 * One pass.
 *
 * Never throws: it is called from a ticker, and a ticker that dies on a bad
 * row stops sending everything else too.
 */
export async function dispatchNotificationEmails(config: ServerConfig): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };

  try {
    const settings = await loadNotificationEmailSettings(config);
    if (!settings.enabled) return result;

    const sb = getServiceClient(config);
    const now = new Date();

    const { data: due, error } = await sb
      .from('notification_email_jobs')
      .select('id, user_id, workspace_id, type, payload, locale, attempts')
      .eq('status', 'pending')
      .lte('scheduled_for', now.toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH);
    if (error) throw new Error(error.message);

    const jobs = (due ?? []) as JobRow[];
    result.claimed = jobs.length;
    if (!jobs.length) return result;

    for (const job of jobs) {
      // Claim first. Two instances running the same pass is ordinary, and
      // the loser of this update simply finds nothing to do.
      const { data: claimed } = await sb
        .from('notification_email_jobs')
        .update({ status: 'sending', claimed_at: now.toISOString(), attempts: job.attempts + 1 })
        .eq('id', job.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      try {
        const outcome = await deliver(config, settings, job, now);
        if (outcome.kind === 'sent') result.sent += 1;
        else if (outcome.kind === 'skipped') result.skipped += 1;
        else if (outcome.kind === 'deferred') result.deferred += 1;
        else result.failed += 1;
      } catch (err) {
        result.failed += 1;
        await finish(config, job, 'failed', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error('[notification-email] dispatch pass failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

type Outcome =
  | { kind: 'sent' }
  | { kind: 'skipped' }
  | { kind: 'deferred' }
  | { kind: 'failed' };

async function deliver(
  config: ServerConfig,
  settings: NotificationEmailSettings,
  job: JobRow,
  now: Date,
): Promise<Outcome> {
  if (!isNotificationEmailType(job.type)) {
    await finish(config, job, 'skipped', `unknown type ${job.type}`);
    return { kind: 'skipped' };
  }
  const type = job.type as NotificationEmailType;
  const definition = NOTIFICATION_EMAILS[type];

  // Asked again, because time has passed since the producer asked.
  if (!isTypeEnabled(settings, type)) {
    await finish(config, job, 'skipped', 'platform disabled this type');
    return { kind: 'skipped' };
  }
  if (definition.operatorOptOut && !(await operatorWants(config, job.user_id, type))) {
    await finish(config, job, 'skipped', 'operator opted out');
    return { kind: 'skipped' };
  }

  const recipient = await resolveRecipient(config, job.user_id);
  if (!recipient?.email) {
    // An account with no address on it is a state of the world, not a fault.
    await finish(config, job, 'skipped', 'no email address on the account');
    return { kind: 'skipped' };
  }

  if (definition.respectsQuietHours) {
    const until = await quietUntil(config, job.user_id, now);
    if (until) {
      await sb(config)
        .from('notification_email_jobs')
        .update({ status: 'pending', scheduled_for: until.toISOString(), claimed_at: null })
        .eq('id', job.id);
      return { kind: 'deferred' };
    }
  }

  const locale = job.locale || recipient.locale || 'en';
  const data: Record<string, string> = { name: recipient.name || recipient.email };
  for (const [key, value] of Object.entries(job.payload ?? {})) {
    data[key] = value == null ? '' : String(value);
  }

  const send = await sendEmail(config, {
    // `workspaceId` is what the email service uses for entitlement and
    // logging. A platform announcement has no workspace of its own, so it
    // borrows the recipient's first one rather than inventing a blank.
    workspaceId: job.workspace_id || recipient.workspaceId || '',
    to: recipient.email,
    templateSlug: definition.slug,
    templateData: data,
    locale,
    providerConfigKey: settings.provider_override ? OVERRIDE_PROVIDER_KEY : undefined,
  });

  if (send.success) {
    await finish(config, job, 'sent', null);
    return { kind: 'sent' };
  }

  const retriable = job.attempts + 1 < MAX_ATTEMPTS;
  if (retriable) {
    // Back off in minutes, not seconds: what fails here is a provider, and
    // hammering one that is rate-limiting is how an account gets suspended.
    const next = new Date(now.getTime() + (job.attempts + 1) * 5 * 60_000);
    await sb(config)
      .from('notification_email_jobs')
      .update({ status: 'pending', scheduled_for: next.toISOString(), claimed_at: null, last_error: send.error ?? 'send failed' })
      .eq('id', job.id);
    return { kind: 'deferred' };
  }

  await finish(config, job, 'failed', send.error ?? 'send failed');
  return { kind: 'failed' };
}

function sb(config: ServerConfig) {
  return getServiceClient(config);
}

async function finish(
  config: ServerConfig,
  job: { id: string },
  status: 'sent' | 'skipped' | 'failed',
  error: string | null,
): Promise<void> {
  await sb(config)
    .from('notification_email_jobs')
    .update({
      status,
      last_error: error,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    })
    .eq('id', job.id);
}

interface Recipient {
  email: string | null;
  name: string | null;
  locale: string | null;
  workspaceId: string | null;
}

async function resolveRecipient(config: ServerConfig, userId: string): Promise<Recipient | null> {
  const { data } = await sb(config)
    .from('profiles')
    .select('email, full_name, preferred_locale')
    .eq('id', userId)
    .maybeSingle();
  if (!data) return null;

  const { data: member } = await sb(config)
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId)
    .is('suspended_at', null)
    .limit(1)
    .maybeSingle();

  const row = data as { email: string | null; full_name: string | null; preferred_locale: string | null };
  return {
    email: row.email,
    name: row.full_name,
    locale: row.preferred_locale,
    workspaceId: (member as { workspace_id?: string } | null)?.workspace_id ?? null,
  };
}

/**
 * When the operator's quiet hours end, or null if they are not in them.
 *
 * Read from the BROWSER row: quiet hours are a fact about the person's day,
 * and the phone's row carries the same window for the same reason. Either
 * would do; one has to be chosen, and the browser is the surface an operator
 * sets first.
 */
export async function quietUntil(
  config: ServerConfig,
  userId: string,
  now: Date,
): Promise<Date | null> {
  const { data } = await sb(config)
    .from('user_notification_prefs')
    .select('quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone')
    .eq('user_id', userId)
    .eq('platform', 'web')
    .is('workspace_id', null)
    .maybeSingle();
  if (!data) return null;

  const prefs = data as {
    quiet_hours_enabled: boolean | null;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    quiet_hours_timezone: string | null;
  };
  if (!isWithinQuietHours(prefs, now)) return null;

  // The end of the window, in the operator's own zone. Computed by walking
  // forward rather than by arithmetic on a timezone offset, because an
  // offset changes under daylight saving and a digest arriving an hour early
  // on one Sunday a year is not worth the cleverness.
  for (let minutes = 15; minutes <= 24 * 60; minutes += 15) {
    const candidate = new Date(now.getTime() + minutes * 60_000);
    if (!isWithinQuietHours(prefs, candidate)) return candidate;
  }
  // A window that never ends is a broken window; send rather than hold.
  return null;
}
