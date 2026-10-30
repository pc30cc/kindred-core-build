/**
 * THE ONE PLACE A QUEUED JOB BECOMES MAIL.
 *
 * Producers decide there is something to say. This decides whether to say it
 * — and it asks the same questions the producer asked, again, because time
 * has passed: a digest queued at 2am for 8am must not go if the platform
 * switched the type off at 7, if the operator did, or if the operator was
 * suspended in between.
 *
 * Quiet hours move a job rather than dropping it, and moving it is not an
 * attempt. None of these are urgent — urgent is what push is for — so an
 * operator whose night is 22:00–08:00 gets their digest at breakfast rather
 * than not at all. The window is read from the operator's BROWSER
 * preferences, which is where quiet hours are set for the person rather than
 * for a device.
 *
 * What a template prints is never taken as HTML from a payload: every value
 * reaches the HTML part escaped (htmlData), and the subject and the text
 * part get it as it was typed. A visitor writes a conversation's subject and
 * their own name, an admin the workspace's name, an operator their own
 * name, and none of them may put a link or a picture into a genuine,
 * DKIM-signed mail from the platform.
 *
 * Every mail carries its unsubscribe (unsubscribe.ts): the one-click header
 * and a visible line under the template's own text, added here in code.
 *
 * A send that fails in a way that can pass is tried again on the email
 * outbox's schedule (email/outbox.ts emailRetryDelayMs: 1, 5, 15 and 60
 * minutes, then every 3 hours), up to MAX_ATTEMPTS; one that cannot (a
 * refused or suppressed address, no provider) is final at once; an error of
 * our own is tried again like a provider's. A job cut off mid-send (a
 * deploy) is taken back after STUCK_SENDING_MS, and one nobody could deliver
 * within STALE_AFTER_MS of being queued is dropped as old news.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail } from '../email/index.js';
import { emailRetryDelayMs } from '../email/outbox.js';
import { readEmailProviderConfig } from '../email/providerConfigStore.js';
import { emailProviderReadiness } from '../email/providers/index.js';
import { isWithinQuietHours } from '../push/recipients.js';
import {
  isTypeEnabled,
  loadNotificationEmailSettings,
  type NotificationEmailSettings,
} from './settings.js';
import { operatorWants } from './queue.js';
import { NOTIFICATION_EMAILS, isNotificationEmailType, type NotificationEmailDefinition, type NotificationEmailType } from './types.js';
import { escapeHtml, notificationFooter, unsubscribeBaseUrl, unsubscribeUrl } from './unsubscribe.js';
import { resolveLockState } from '../billing/locks/state.js';
import { isMemberLocked } from '../billing/locks/predicates.js';
import { operatorLocaleFrom } from '../operatorLocale.js';
import { resolveWorkspaceAppUrl } from '../auth-email.js';
import { canUseInbox } from '../../../shared/chatRoles.js';

/** Where an override provider's config lives, when one is chosen. */
export const OVERRIDE_PROVIDER_KEY = 'notification_email_provider';

/** How many jobs one pass will send. Bounded so a backlog drains steadily. */
const BATCH = 25;
/**
 * Attempts at most: what the email outbox's schedule fits in its 24 hours
 * (at 0, 1, 6, 21 and 81 minutes, then every 3 hours).
 */
export const MAX_ATTEMPTS = 12;
/** A job nobody could deliver within this of being queued is no longer news (24 h of retries after up to a day of quiet hours). */
export const STALE_AFTER_MS = 48 * 60 * 60_000;
/** Longer than the slowest send (SMTP: DNS, connect, greeting and socket timeouts): a job 'sending' this long was cut off. */
export const STUCK_SENDING_MS = 10 * 60_000;
/** A pass starts no send after this, well inside the ticker's lease (120 s). */
const PASS_BUDGET_MS = 60_000;
/** Finished jobs are kept this long (the dedupe keys' memory: one transcript per conversation, one digest per new thing), then deleted. */
export const KEEP_FINISHED_MS = 30 * 24 * 60 * 60_000;

const FINISHED = ['sent', 'skipped', 'failed'];

export interface DispatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
}

export interface DispatchOptions {
  /** Stop starting sends (the process is shutting down). */
  shouldStop?: () => boolean;
  /** The pass's time budget (default PASS_BUDGET_MS). */
  budgetMs?: number;
}

interface JobRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  locale: string | null;
  attempts: number;
  created_at?: string | null;
}

/** What the whole pass shares: read once, not once a job. */
interface PassContext {
  now: Date;
  providerConfigKey: string | undefined;
  linkBase: string | null;
}

/**
 * One pass.
 *
 * Never throws: it is called from a ticker, and a ticker that dies on a bad
 * row stops sending everything else too.
 */
export async function dispatchNotificationEmails(
  config: ServerConfig,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const deadline = Date.now() + (opts.budgetMs ?? PASS_BUDGET_MS);

  try {
    const settings = await loadNotificationEmailSettings(config);
    if (!settings.enabled) return result;

    const now = new Date();
    await reclaimStuckJobs(config, now);

    const { data: due, error } = await sb(config)
      .from('notification_email_jobs')
      .select('id, user_id, workspace_id, type, payload, locale, attempts, created_at')
      .eq('status', 'pending')
      .lte('scheduled_for', now.toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH);
    if (error) throw new Error(error.message);

    const jobs = (due ?? []) as JobRow[];
    if (!jobs.length) return result;

    const ctx: PassContext = {
      now,
      providerConfigKey: await notificationProviderKey(config, settings),
      linkBase: await unsubscribeBaseUrl(config),
    };

    for (const job of jobs) {
      if (opts.shouldStop?.() || Date.now() > deadline) break;
      // Claim first. Two instances running the same pass is ordinary, and
      // the loser of this update simply finds nothing to do. The attempt is
      // counted when a send is made, not here: a job moved by quiet hours
      // has not been tried.
      const { data: claimed } = await sb(config)
        .from('notification_email_jobs')
        .update({ status: 'sending', claimed_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();
      if (!claimed) continue;
      result.claimed += 1;

      let outcome: Outcome;
      try {
        outcome = await deliver(config, settings, job, ctx);
      } catch (err) {
        // Our own fault (a database read, say), not the mail's: tried again
        // later like a provider's, never failed at once.
        outcome = await retryOrFail(config, job, job.attempts + 1, `dispatch_error: ${shortMessage(err)}`).catch(() => ({ kind: 'deferred' as const }));
      }
      if (outcome.kind === 'sent') result.sent += 1;
      else if (outcome.kind === 'skipped') result.skipped += 1;
      else if (outcome.kind === 'deferred') result.deferred += 1;
      else result.failed += 1;
    }
  } catch (err) {
    console.error('[notification-email] dispatch pass failed', { message: shortMessage(err) });
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
  ctx: PassContext,
): Promise<Outcome> {
  if (!isNotificationEmailType(job.type)) {
    await finish(config, job, 'skipped', `unknown type ${job.type}`);
    return { kind: 'skipped' };
  }
  const type = job.type as NotificationEmailType;
  const definition = NOTIFICATION_EMAILS[type];

  const queuedAt = job.created_at ? Date.parse(job.created_at) : NaN;
  if (Number.isFinite(queuedAt) && ctx.now.getTime() - queuedAt > STALE_AFTER_MS) {
    await finish(config, job, 'skipped', 'stale: not delivered within 48 hours of being queued');
    return { kind: 'skipped' };
  }

  // Asked again, because time has passed since the producer asked.
  if (!isTypeEnabled(settings, type)) {
    await finish(config, job, 'skipped', 'platform disabled this type');
    return { kind: 'skipped' };
  }
  if (definition.operatorOptOut && !(await operatorWants(config, job.user_id, type))) {
    await finish(config, job, 'skipped', 'operator opted out');
    return { kind: 'skipped' };
  }

  const standing = await memberStanding(config, job.user_id, job.workspace_id, definition);
  if (standing) {
    await finish(config, job, 'skipped', standing);
    return { kind: 'skipped' };
  }

  const recipient = await resolveRecipient(config, job.user_id);
  if (!recipient?.email) {
    // An account with no address on it is a state of the world, not a fault.
    await finish(config, job, 'skipped', 'no email address on the account');
    return { kind: 'skipped' };
  }

  if (definition.respectsQuietHours) {
    const until = await quietUntil(config, job.user_id, ctx.now);
    if (until) {
      await sb(config)
        .from('notification_email_jobs')
        .update({ status: 'pending', scheduled_for: until.toISOString(), claimed_at: null })
        .eq('id', job.id)
        .eq('status', 'sending');
      return { kind: 'deferred' };
    }
  }

  // The job's language (a transcript is rendered in it), else the
  // operator's own when the platform offers it, else the platform's: never
  // English by default on a Persian platform (operatorLocale.ts).
  const locale = await operatorLocaleFrom(config, job.locale || recipient.locale);
  const { templateData, htmlData } = templateValues(job.payload, recipient.name || recipient.email);

  const unsubscribe = unsubscribeUrl(ctx.linkBase, job.user_id, type);
  const settingsPage = unsubscribe ? null : await resolveWorkspaceAppUrl(config, job.workspace_id, '/settings/notifications').catch(() => null);
  const footer = notificationFooter(locale, type, { unsubscribe, settings: settingsPage });

  const send = await sendEmail(config, {
    // Platform mail (an announcement, a recipient with no workspace) goes
    // as platform mail: never in a workspace's email log it does not
    // belong to.
    workspaceId: job.workspace_id ?? null,
    to: recipient.email,
    templateSlug: definition.slug,
    templateData,
    htmlData,
    locale,
    category: definition.category,
    providerConfigKey: ctx.providerConfigKey,
    ...(unsubscribe ? { listUnsubscribe: { url: unsubscribe } } : {}),
    footer,
  });

  const attempts = job.attempts + 1;
  if (send.success) {
    await finish(config, job, 'sent', null, attempts);
    return { kind: 'sent' };
  }
  const error = send.error ?? `${send.errorCode ?? 'provider_error'}: send failed`;
  // Retrying the same message cannot succeed: a refused or suppressed
  // address, no provider. Said once, in the job.
  if (send.permanent) {
    await finish(config, job, 'failed', error, attempts);
    return { kind: 'failed' };
  }
  return retryOrFail(config, job, attempts, error);
}

/**
 * The template's values: as typed for the subject and the text part, and
 * escaped for the HTML part, every one of them. An announcement's body is
 * plain text with its line breaks kept; a transcript is its lines, a
 * paragraph each.
 */
export function templateValues(
  payload: Record<string, unknown> | null,
  name: string,
): { templateData: Record<string, string>; htmlData: Record<string, string> } {
  const templateData: Record<string, string> = { name };
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (key === 'transcript_lines') continue;
    templateData[key] = value == null ? '' : String(value);
  }
  const htmlData: Record<string, string> = {};
  for (const [key, value] of Object.entries(templateData)) htmlData[key] = escapeHtml(value);
  if ('body' in templateData) htmlData.body = escapeHtml(templateData.body).replace(/\r?\n/g, '<br>');

  const lines = payload?.transcript_lines;
  if (Array.isArray(lines)) {
    const text = lines.map((line) => String(line ?? ''));
    templateData.transcript = text.join('\n');
    htmlData.transcript = text.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  } else if (typeof payload?.transcript === 'string') {
    // A transcript queued before this release: its producer wrote it as
    // HTML, every line already escaped.
    htmlData.transcript = payload.transcript;
  }
  return { templateData, htmlData };
}

/**
 * The provider these mails go through: the separate notification provider
 * (app_runtime_config.notification_email_provider, through the config
 * store) when Super Admin chose it and it is the provider they chose, set up
 * to send; else the platform default, rather than no mail at all.
 */
async function notificationProviderKey(
  config: ServerConfig,
  settings: NotificationEmailSettings,
): Promise<string | undefined> {
  if (!settings.provider_override) return undefined;
  const provider = await readEmailProviderConfig(config, OVERRIDE_PROVIDER_KEY).catch(() => null);
  if (
    provider
    && provider.provider_name === settings.provider_override
    && emailProviderReadiness(provider) === 'configured'
  ) {
    return OVERRIDE_PROVIDER_KEY;
  }
  console.warn('[notification-email] the notification provider is not set up as chosen; the platform default carries these', {
    chosen: settings.provider_override,
    stored: provider?.provider_name ?? null,
  });
  return undefined;
}

function sb(config: ServerConfig) {
  return getServiceClient(config);
}

function shortMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/**
 * A job's end. Its payload goes with it: what the mail said is in the
 * recipient's inbox and the send in email_logs, and a transcript or a
 * visitor's name has no business staying in a queue.
 */
async function finish(
  config: ServerConfig,
  job: { id: string },
  status: 'sent' | 'skipped' | 'failed',
  error: string | null,
  attempts?: number,
): Promise<void> {
  await sb(config)
    .from('notification_email_jobs')
    .update({
      status,
      last_error: error ? error.slice(0, 500) : null,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
      payload: {},
      claimed_at: null,
      ...(attempts !== undefined ? { attempts } : {}),
    })
    .eq('id', job.id);
}

/** Tried again on the outbox's schedule, or failed once the attempts are spent. */
async function retryOrFail(
  config: ServerConfig,
  job: { id: string },
  attempts: number,
  error: string,
): Promise<Outcome> {
  if (attempts >= MAX_ATTEMPTS) {
    await finish(config, job, 'failed', error, attempts);
    return { kind: 'failed' };
  }
  // Back off in minutes, then hours: what fails here is a provider, and
  // hammering one that is rate-limiting is how an account gets suspended.
  const next = new Date(Date.now() + emailRetryDelayMs(attempts));
  await sb(config)
    .from('notification_email_jobs')
    .update({ status: 'pending', scheduled_for: next.toISOString(), claimed_at: null, attempts, last_error: error.slice(0, 500) })
    .eq('id', job.id);
  return { kind: 'deferred' };
}

/**
 * Jobs a pass claimed and never finished: the backend was replaced mid-send
 * (every push to main), or the process died. Each is given back as pending,
 * its attempt counted (the mail may have gone: delivery is at least once, as
 * for the email outbox), or failed when its attempts are spent, or dropped
 * when it is too old to be news.
 */
export async function reclaimStuckJobs(config: ServerConfig, now: Date = new Date()): Promise<number> {
  const { data, error } = await sb(config)
    .from('notification_email_jobs')
    .select('id, attempts, claimed_at, created_at')
    .eq('status', 'sending')
    .lt('claimed_at', new Date(now.getTime() - STUCK_SENDING_MS).toISOString())
    .limit(100);
  if (error) return 0;
  let reclaimed = 0;
  for (const row of (data ?? []) as Array<{ id: string; attempts: number; claimed_at: string; created_at: string | null }>) {
    const attempts = (Number(row.attempts) || 0) + 1;
    const queuedAt = row.created_at ? Date.parse(row.created_at) : NaN;
    const stale = Number.isFinite(queuedAt) && now.getTime() - queuedAt > STALE_AFTER_MS;
    const patch = stale
      ? { status: 'skipped', payload: {}, claimed_at: null, last_error: 'stale: cut off mid-send and too old to send again' }
      : attempts >= MAX_ATTEMPTS
        ? { status: 'failed', payload: {}, claimed_at: null, attempts, last_error: 'abandoned: cut off mid-send too many times' }
        : { status: 'pending', claimed_at: null, attempts, scheduled_for: now.toISOString(), last_error: 'reclaimed: cut off mid-send' };
    const { data: moved } = await sb(config)
      .from('notification_email_jobs')
      .update(patch)
      .eq('id', row.id)
      .eq('status', 'sending')
      .eq('claimed_at', row.claimed_at)
      .select('id')
      .maybeSingle();
    if (moved) reclaimed += 1;
  }
  if (reclaimed) console.warn(`[notification-email] took back ${reclaimed} job(s) cut off mid-send`);
  return reclaimed;
}

/** Finished jobs older than KEEP_FINISHED_MS go. */
export async function purgeFinishedJobs(config: ServerConfig, now: Date = new Date()): Promise<void> {
  const { error } = await sb(config)
    .from('notification_email_jobs')
    .delete()
    .in('status', FINISHED)
    .lt('created_at', new Date(now.getTime() - KEEP_FINISHED_MS).toISOString());
  if (error) console.warn('[notification-email] purge failed', { message: error.message });
}

/**
 * Why this person may not get this mail now, or null when they may.
 *
 * About a workspace: only while an active (not suspended) member of it,
 * still in the type's audience (an invoice notice to an owner or admin, a
 * digest to a role with an Inbox), whose seat the plan has not paused.
 * Platform mail (an announcement): not to someone suspended in every
 * workspace they belong to.
 */
async function memberStanding(
  config: ServerConfig,
  userId: string,
  workspaceId: string | null,
  definition: NotificationEmailDefinition,
): Promise<string | null> {
  const { data, error } = await sb(config)
    .from('workspace_members')
    .select('workspace_id, role, suspended_at')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ workspace_id: string; role: string | null; suspended_at: string | null }>;

  if (!workspaceId) {
    return rows.length && rows.every((r) => r.suspended_at) ? 'suspended in every workspace' : null;
  }
  const row = rows.find((r) => String(r.workspace_id) === workspaceId);
  if (!row) return 'no longer a member of the workspace';
  if (row.suspended_at) return 'suspended in the workspace';
  if (definition.audience === 'admins' && !['owner', 'admin'].includes(String(row.role ?? ''))) return 'no longer an owner or admin';
  if (definition.audience === 'inbox' && !canUseInbox(row.role)) return 'no longer has the Inbox';
  // A member whose seat the plan paused (simple billing phase 4) hears
  // nothing about that workspace until the seat is back; the job was queued
  // before, or the pause began after it was.
  if (await seatPaused(config, workspaceId, userId)) return 'seat paused by the plan';
  return null;
}

async function seatPaused(config: ServerConfig, workspaceId: string, userId: string): Promise<boolean> {
  const state = await resolveLockState(config, workspaceId, ['member']);
  return isMemberLocked(state, userId);
}

interface Recipient {
  email: string | null;
  name: string | null;
  locale: string | null;
}

async function resolveRecipient(config: ServerConfig, userId: string): Promise<Recipient | null> {
  const { data, error } = await sb(config)
    .from('profiles')
    .select('email, full_name, preferred_locale')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { email: string | null; full_name: string | null; preferred_locale: string | null };
  return { email: row.email, name: row.full_name, locale: row.preferred_locale };
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
