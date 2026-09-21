/**
 * The clock behind the notification emails.
 *
 * One timer, three jobs: sweep for conversations still waiting, sweep for
 * the weekly summary when its hour comes round, and drain whatever is queued.
 *
 * The lease is what makes a second app instance safe. The dedupe key would
 * catch a duplicate anyway — that is its whole purpose — but two replicas
 * scanning every workspace every minute is work nobody needs done twice, and
 * the lease is how every other ticker in this codebase says so.
 */
import type { ServerConfig } from '../../config.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';
import { dispatchNotificationEmails } from './dispatcher.js';
import { sweepUnreadDigest, sweepWeeklySummary } from './producers.js';
import { loadNotificationEmailSettings } from './settings.js';

const LEASE_NAME = 'notification_email';

/** A minute. The digest's own interval is a setting; this is the heartbeat. */
const TICK_MS = 60 * 1000;
/** Late enough that the app is serving before it starts scanning. */
const FIRST_RUN_MS = 90 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startNotificationEmailTicker(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => void runOnce(config), FIRST_RUN_MS);
  timer = setInterval(() => void runOnce(config), TICK_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function stopNotificationEmailTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runOnce(config: ServerConfig): Promise<void> {
  // The cheapest possible no-op while the feature is off, which is how it
  // ships: one cached read, no lease, no scan.
  const settings = await loadNotificationEmailSettings(config);
  if (!settings.enabled) return;

  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch {
    return; // another replica, or a database blip: skip this minute
  }
  if (!leased) return;

  try {
    const now = new Date();
    // Producers first, so anything they raise can go out in the same pass.
    await sweepUnreadDigest(config, now);
    await sweepWeeklySummary(config, now);
    await dispatchNotificationEmails(config);
  } catch (err) {
    console.error('[notification-email] ticker pass failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await releaseTickerLease(config, LEASE_NAME).catch(() => {});
  }
}
