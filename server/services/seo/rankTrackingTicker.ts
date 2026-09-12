/**
 * SEO Rank Tracking ticker — in-process scheduler, same pattern as
 * server/services/observability/alertingTicker.ts (no pg_cron dependency,
 * cluster-wide lease so N API replicas never double-check the same
 * keyword — each check costs the platform real money via the configured
 * rank-tracking vendor).
 *
 * Runs every TICK_MS, finds `seo_tracked_keywords` rows due for a check
 * (`is_active = true AND next_check_at <= now()`), calls the resolved
 * rank-tracking provider for each (bounded per tick — BATCH_SIZE), records
 * a `seo_rank_checks` row, and reschedules `next_check_at` using the
 * keyword's workspace plan's `seo_rank_tracking_check_frequency_hours`.
 *
 * Started from server/index.ts alongside every other ticker — this is
 * deliberately NOT a worker/background_jobs job type: a rank check is a
 * scheduled background refresh, not a user-triggered run the UI polls for
 * completion (see docs/SEO_AUDIT.md's Rank Tracking section).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from '../observability/metrics.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';
import { getRankTrackingProviderInfo, checkKeywordRank } from './rankTracking/index.js';
import { resolveRankTrackingLimits } from './rankTrackingLimits.js';
import { normalizeHost } from '../ai-agent/crawler/urlRules.js';

const LEASE_NAME = 'seo_rank_tracking';
const TICK_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE = 20;
const RETRY_AFTER_HOURS_ON_ERROR = 1;

let timer: ReturnType<typeof setInterval> | null = null;

export function startRankTrackingTicker(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => runOnce(config), 60_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

export function __stopRankTrackingTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface DueKeywordRow {
  id: string;
  workspace_id: string;
  website_id: string;
  keyword: string;
  device: 'desktop' | 'mobile';
  location_code: number | null;
}

async function runOnce(config: ServerConfig): Promise<void> {
  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch (err: any) {
    emitLog(config, 'warn', 'seo_rank_ticker_lease_unavailable', { error: err?.message || 'unknown' });
    return;
  }
  if (!leased) return;

  try {
    const providerInfo = await getRankTrackingProviderInfo(config);
    if (!providerInfo.enabled) return; // nothing configured platform-wide — nothing to do this cycle

    const sb = getServiceClient(config);
    const nowIso = new Date().toISOString();
    const { data: due, error } = await sb
      .from('seo_tracked_keywords')
      .select('id, workspace_id, website_id, keyword, device, location_code')
      .eq('is_active', true)
      .lte('next_check_at', nowIso)
      .order('next_check_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (error) {
      emitLog(config, 'warn', 'seo_rank_ticker_query_failed', { error: error.message });
      return;
    }
    const rows = (due || []) as DueKeywordRow[];
    if (rows.length === 0) return;

    let checked = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await checkOneKeyword(config, row);
        checked++;
      } catch (err: any) {
        failed++;
        emitLog(config, 'warn', 'seo_rank_check_failed', { trackedKeywordId: row.id, error: err?.message || 'unknown' });
        await sb
          .from('seo_tracked_keywords')
          .update({ next_check_at: new Date(Date.now() + RETRY_AFTER_HOURS_ON_ERROR * 3_600_000).toISOString() })
          .eq('id', row.id);
      }
    }
    if (checked > 0 || failed > 0) {
      emitLog(config, 'info', 'seo_rank_ticker_cycle', { checked, failed, batchSize: rows.length });
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'seo_rank_ticker_cycle_threw', { error: err?.message || 'unknown' });
  } finally {
    await releaseTickerLease(config, LEASE_NAME);
  }
}

export async function checkOneKeyword(config: ServerConfig, row: DueKeywordRow): Promise<void> {
  const sb = getServiceClient(config);

  const { data: site } = await sb.from('workspace_domains').select('domain').eq('id', row.website_id).maybeSingle();
  const domain = (site as { domain: string } | null)?.domain;
  if (!domain) throw new Error('site_not_found');
  const targetHost = normalizeHost(domain);

  const { limits } = await resolveRankTrackingLimits(config, row.workspace_id);

  const { provider, result } = await checkKeywordRank(config, {
    keyword: row.keyword,
    targetHost,
    device: row.device,
    locationCode: row.location_code,
  });

  const { data: insertedCheck, error: insertError } = await sb
    .from('seo_rank_checks')
    .insert({
      tracked_keyword_id: row.id,
      workspace_id: row.workspace_id,
      website_id: row.website_id,
      position: result.position,
      ranking_url: result.rankingUrl,
      provider,
    })
    .select('id')
    .single();
  if (insertError) throw new Error(`seo_rank_check_insert_failed: ${insertError.message}`);

  if (result.competitors.length > 0) {
    const rankCheckId = (insertedCheck as { id: string }).id;
    await sb.from('seo_rank_check_competitors').insert(
      result.competitors.map((c) => ({
        rank_check_id: rankCheckId,
        tracked_keyword_id: row.id,
        workspace_id: row.workspace_id,
        website_id: row.website_id,
        domain: c.domain,
        url: c.url,
        position: c.position,
      })),
    );
  }

  await sb
    .from('seo_tracked_keywords')
    .update({
      last_position: result.position,
      last_ranking_url: result.rankingUrl,
      last_checked_at: new Date().toISOString(),
      next_check_at: new Date(Date.now() + limits.seo_rank_tracking_check_frequency_hours * 3_600_000).toISOString(),
    })
    .eq('id', row.id);
}
