/**
 * ENQUEUING A NOTIFICATION EMAIL.
 *
 * Producers run in two places that must not send mail themselves: a ticker,
 * which would block its own next pass on an SMTP round trip, and the middle
 * of a request somebody is waiting on. So they write a row and go.
 *
 * The dedupe key is the load-bearing part. Two app instances run the same
 * ticker minute, a producer retries, a webhook is delivered twice — each of
 * those is an ordinary Tuesday, and each would otherwise be a second copy of
 * the same mail in somebody's inbox. The key names the THING the mail is
 * about, so the second write is refused by the index rather than by a lock.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { NOTIFICATION_EMAILS, type NotificationEmailType } from './types.js';
import { isTypeEnabled, loadNotificationEmailSettings } from './settings.js';

export interface EnqueueRequest {
  userId: string;
  workspaceId?: string | null;
  type: NotificationEmailType;
  /** Already-resolved template data. The dispatcher re-reads nothing. */
  payload: Record<string, unknown>;
  locale?: string | null;
  /** Unique per thing-being-told-about. See the note above. */
  dedupeKey: string;
  /** Earliest it may go. Quiet hours move this, they do not drop the job. */
  scheduledFor?: Date;
}

export interface EnqueueResult {
  queued: boolean;
  /** Why not, when it was not. Never an error: none of these are faults. */
  reason?: 'platform_disabled' | 'operator_opted_out' | 'duplicate' | 'error';
}

/**
 * Both gates, then the row.
 *
 * The platform's switch and the operator's own are checked HERE rather than
 * at send time, so a queue full of jobs that will never be sent cannot
 * build up — and both are checked again by the dispatcher, because a
 * digest queued at 2am for 8am must respect a switch turned off at 7.
 */
export async function enqueueNotificationEmail(
  config: ServerConfig,
  request: EnqueueRequest,
): Promise<EnqueueResult> {
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, request.type)) return { queued: false, reason: 'platform_disabled' };

  const sb = getServiceClient(config);

  if (NOTIFICATION_EMAILS[request.type].operatorOptOut) {
    const wanted = await operatorWants(config, request.userId, request.type);
    if (!wanted) return { queued: false, reason: 'operator_opted_out' };
  }

  const { error } = await sb.from('notification_email_jobs').insert({
    user_id: request.userId,
    workspace_id: request.workspaceId ?? null,
    type: request.type,
    payload: request.payload,
    locale: request.locale ?? null,
    dedupe_key: request.dedupeKey,
    scheduled_for: (request.scheduledFor ?? new Date()).toISOString(),
  });

  if (error) {
    // 23505 is the dedupe index doing its job, which is a success with a
    // different name — the mail this job describes is already going out.
    if (String(error.code) === '23505') return { queued: false, reason: 'duplicate' };
    console.error('[notification-email] enqueue failed', { type: request.type, message: error.message });
    return { queued: false, reason: 'error' };
  }

  return { queued: true };
}

/**
 * Whether this operator still wants this type.
 *
 * No row means yes: the defaults are on, and the platform switch above is
 * what decides whether a type is offered at all. An operator who has never
 * opened the page gets what the platform chose.
 */
export async function operatorWants(
  config: ServerConfig,
  userId: string,
  type: NotificationEmailType,
): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('user_email_notification_prefs')
      .select(type)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return true;
    const value = (data as Record<string, unknown>)[type];
    return value !== false;
  } catch (err) {
    // Not knowing is not consent to send: an operator who turned something
    // off and then gets it anyway because a query failed has been ignored.
    console.error('[notification-email] preference lookup failed; not sending', {
      type,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The same instant, named the same way by everybody.
 *
 * A digest's key has to be stable across the instances that might produce
 * it in the same window and different between windows, so it is the window
 * itself — floor(now / interval) — rather than a timestamp.
 */
export function windowKey(now: Date, everyMinutes: number): number {
  const ms = Math.max(1, everyMinutes) * 60_000;
  return Math.floor(now.getTime() / ms);
}
