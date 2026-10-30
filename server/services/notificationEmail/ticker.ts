/**
 * The clock behind the notification emails.
 *
 * One timer, four jobs: sweep for conversations still waiting, sweep for
 * the weekly summary when its hour comes round, queue the next page of an
 * announcement, and drain whatever is queued.
 *
 * The lease is what makes a second app instance safe. The dedupe key would
 * catch a duplicate anyway — that is its whole purpose — but two replicas
 * scanning every workspace every minute is work nobody needs done twice, and
 * the lease is how every other ticker in this codebase says so. Within one
 * process, a pass still running when the next minute comes (a slow relay)
 * is let finish: the next one waits for the minute after.
 *
 * On SIGTERM (services/jobs/processShutdown.ts) the timer stops, the pass in
 * flight starts no new send and finishes the one it holds; a job cut off
 * anyway is taken back by the next pass (dispatcher.ts, reclaimStuckJobs).
 */
import type { ServerConfig } from '../../config.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';
import { onProcessShutdown } from '../jobs/processShutdown.js';
import { dispatchNotificationEmails, purgeFinishedJobs } from './dispatcher.js';
import { fanOutAnnouncements, sweepUnreadDigest, sweepWeeklySummary } from './producers.js';
import { loadNotificationEmailSettings } from './settings.js';

const LEASE_NAME = 'notification_email';

/** A minute. The digest's own interval is a setting; this is the heartbeat. */
const TICK_MS = 60 * 1000;
/** Late enough that the app is serving before it starts scanning. */
const FIRST_RUN_MS = 90 * 1000;
/** The retention purge runs this often, whether the feature is on or not. */
const PURGE_EVERY_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let stopping = false;
let lastPurgeAt = 0;

export function startNotificationEmailTicker(config: ServerConfig): void {
  if (timer) return;
  stopping = false;
  firstRun = setTimeout(() => void runOnce(config), FIRST_RUN_MS);
  timer = setInterval(() => void runOnce(config), TICK_MS);
  for (const handle of [firstRun, timer]) {
    if (typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
  }
  onProcessShutdown('notification-email', () => shutdownNotificationEmailTicker());
}

export function stopNotificationEmailTicker(): void {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = null;
  firstRun = null;
}

/** Stops the timer and waits for the pass in flight, which starts no new send. */
export async function shutdownNotificationEmailTicker(): Promise<void> {
  stopping = true;
  stopNotificationEmailTicker();
  await inFlight?.catch(() => undefined);
}

export function runOnce(config: ServerConfig): Promise<void> {
  if (inFlight || stopping) return inFlight ?? Promise.resolve();
  const pass = tick(config).finally(() => {
    inFlight = null;
  });
  inFlight = pass;
  return pass;
}

async function tick(config: ServerConfig): Promise<void> {
  // The retention purge, at most hourly: finished jobs leave after their
  // keep, whether or not the feature is still on.
  if (Date.now() - lastPurgeAt >= PURGE_EVERY_MS) {
    lastPurgeAt = Date.now();
    await purgeFinishedJobs(config).catch(() => undefined);
  }

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
    await fanOutAnnouncements(config, now);
    await dispatchNotificationEmails(config, { shouldStop: () => stopping });
  } catch (err) {
    console.error('[notification-email] ticker pass failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await releaseTickerLease(config, LEASE_NAME).catch(() => {});
  }
}
