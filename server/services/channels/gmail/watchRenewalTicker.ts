/**
 * Gmail watch renewal ticker — in-process scheduler, same pattern as
 * server/services/seo/rankTrackingTicker.ts (no pg_cron dependency,
 * cluster-wide lease so N API replicas never double-renew the same watch).
 *
 * Google's `users.watch()` subscription expires after 7 days
 * (https://developers.google.com/gmail/api/guides/push — documented, not
 * independently verified in this sandbox). Every connected Gmail integration
 * needs it re-called before then or its mailbox silently stops delivering
 * Pub/Sub push notifications with no error surfaced anywhere. This ticker
 * finds integrations whose stored `gmail_watch_expiration` is within the
 * renewal window and re-subscribes them.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { emitLog } from '../../observability/metrics.js';
import { acquireTickerLease, releaseTickerLease } from '../../observability/tickerLease.js';
import { updateIntegration, type ChannelIntegration } from '../../channels/integrations.js';
import { createGmailAdapter } from '../../../../channels/mail/gmail/client.js';
import { getGmailOAuthConfig } from './oauthConfig.js';
import { getGmailPubSubTopic, getGmailAccessToken } from './oauth.js';

const LEASE_NAME = 'gmail_watch_renewal';
const TICK_MS = 6 * 60 * 60 * 1000; // every 6 hours
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000; // renew watches expiring within 24h
const BATCH_SIZE = 50;

let timer: ReturnType<typeof setInterval> | null = null;

export function startGmailWatchRenewalTicker(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => runOnce(config), 90_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

export function __stopGmailWatchRenewalTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function runOnce(config: ServerConfig): Promise<void> {
  const gmailCfg = getGmailOAuthConfig();
  const topicName = getGmailPubSubTopic();
  if (!gmailCfg || !topicName) return; // Gmail not configured on this platform — nothing to do

  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch (err: any) {
    emitLog(config, 'warn', 'gmail_watch_ticker_lease_unavailable', { error: err?.message || 'unknown' });
    return;
  }
  if (!leased) return;

  try {
    const sb = getServiceClient(config);
    const { data: rows, error } = await sb
      .from('channel_integrations')
      .select('id, workspace_id, installation_id, provider, metadata')
      .eq('provider', 'gmail')
      .eq('status', 'connected')
      .limit(BATCH_SIZE);
    if (error) {
      emitLog(config, 'warn', 'gmail_watch_ticker_query_failed', { error: error.message });
      return;
    }

    const cutoff = Date.now() + RENEWAL_WINDOW_MS;
    const due = ((rows || []) as ChannelIntegration[]).filter((row) => {
      const expiration = (row.metadata as Record<string, unknown>)?.gmail_watch_expiration;
      if (typeof expiration !== 'string') return true; // never watched (or lost its metadata) — try now
      const expiresAt = Number(expiration);
      return !Number.isFinite(expiresAt) || expiresAt <= cutoff;
    });
    if (due.length === 0) return;

    let renewed = 0;
    let failed = 0;
    const ga = createGmailAdapter(gmailCfg);
    for (const integration of due) {
      try {
        const accessToken = await getGmailAccessToken(config, integration.installation_id);
        const watch = await ga.watchMailbox(accessToken, topicName);
        await updateIntegration(config, integration.id, {
          metadata: {
            ...integration.metadata,
            gmail_history_id: watch.historyId,
            gmail_watch_expiration: watch.expiration,
          },
          last_error_code: null,
          last_error_at: null,
        });
        renewed++;
      } catch (err: any) {
        failed++;
        emitLog(config, 'warn', 'gmail_watch_renewal_failed', { integrationId: integration.id, error: err?.message || 'unknown' });
        await updateIntegration(config, integration.id, {
          last_error_code: 'gmail_watch_renewal_failed',
          last_error_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
    if (renewed > 0 || failed > 0) {
      emitLog(config, 'info', 'gmail_watch_ticker_cycle', { renewed, failed, due: due.length });
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'gmail_watch_ticker_cycle_threw', { error: err?.message || 'unknown' });
  } finally {
    await releaseTickerLease(config, LEASE_NAME);
  }
}
