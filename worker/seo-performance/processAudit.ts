/**
 * SEO performance audit processing — calls the pluggable performance
 * provider (server/services/seo/performance/) once per pending
 * `seo_performance_results` row belonging to this audit, normalizes each
 * result, and finalizes the `seo_performance_audits` row.
 *
 * Pure processing logic, no polling loop: this runs inside the SAME worker
 * process/container as the SEO crawler (worker/seo-crawler/index.ts claims
 * all four SEO job types from one poller and dispatches here) — mirrors
 * worker/seo-backlinks/processScan.ts exactly, just iterating N pages
 * instead of one target.
 *
 * SECRETS: needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same as the
 * crawler) to read the platform performance-provider config from
 * `platform_performance_provider_config` via the service client — it never
 * receives the vendor credential through any other channel.
 */
import type { loadConfig } from '../../server/config.js';
import { heartbeatJob, completeJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { auditUrlPerformance } from '../../server/services/seo/performance/index.js';
import { isPerformanceError } from '../../server/services/seo/performance/types.js';
import type { SeoPerformanceAuditRow } from '../../server/services/seo/performanceAuditService.js';

const AUDIT_STRATEGY = 'mobile' as const;

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[seo-performance] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[seo-performance] ${event}`); }
}

export function classifyPerformanceAuditError(err: unknown): { category: string; message: string; retryable: boolean } {
  const message = (err as Error)?.message || String(err) || 'unknown_error';
  if (isPerformanceError(err)) {
    const retryable = err.code === 'performance_timeout' || err.code === 'performance_network_error' || err.code === 'performance_rate_limited';
    return { category: err.code, message, retryable };
  }
  return { category: 'internal_error', message, retryable: true };
}

interface PendingResultRow {
  id: string;
  url: string;
}

export async function processPerformanceAudit(
  config: ReturnType<typeof loadConfig>,
  jobId: string,
  audit: SeoPerformanceAuditRow,
  workerId: string,
  lockTtlSeconds: number,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('seo_performance_audits').update({ status: 'running', started_at: new Date().toISOString(), progress_stage: 'auditing' }).eq('id', audit.id);

  const { data: pendingRows } = await sb
    .from('seo_performance_results')
    .select('id, url')
    .eq('audit_id', audit.id)
    .eq('status', 'pending');
  const pending = (pendingRows || []) as PendingResultRow[];

  let audited = 0;
  let unavailable = 0;

  for (let i = 0; i < pending.length; i++) {
    const hb = await heartbeatJob(config, {
      jobId, workerId, lockTtlSeconds,
      progress: pending.length > 0 ? Math.round((i / pending.length) * 90) : 50,
      progressStage: 'auditing',
      status: 'processing',
    });
    if (hb.cancelRequested) {
      await sb.from('seo_performance_audits').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress_stage: 'cancelled' }).eq('id', audit.id);
      await sb.from('seo_performance_results').update({ status: 'unavailable' }).eq('audit_id', audit.id).eq('status', 'pending');
      await acknowledgeJobCancel(config, jobId);
      log('audit cancelled', { auditId: audit.id, jobId });
      return;
    }

    const row = pending[i];
    try {
      const { result } = await auditUrlPerformance(config, row.url, AUDIT_STRATEGY);
      const { error: updateError, count } = await sb.from('seo_performance_results').update({
        status: 'completed',
        performance_score: result.performanceScore,
        accessibility_score: result.accessibilityScore,
        best_practices_score: result.bestPracticesScore,
        seo_score: result.seoScore,
        lcp_ms: result.lcpMs,
        cls: result.cls,
        inp_ms: result.inpMs,
        fcp_ms: result.fcpMs,
        tbt_ms: result.tbtMs,
        raw_summary: result.rawSummary,
      }, { count: 'exact' }).eq('id', row.id);
      // The Supabase client resolves query errors on the object rather than
      // throwing — without this check a rejected write (e.g. a value that
      // doesn't fit the column type) would silently leave the row 'pending'
      // while still being counted here as a success.
      if (updateError || !count) {
        throw new Error(`seo_performance_results_update_failed: ${updateError?.message || 'no rows matched'}`);
      }
      audited++;
    } catch (err) {
      const { category, message } = classifyPerformanceAuditError(err);
      // The provider itself being unconfigured/disabled applies to every
      // remaining page identically — bail the whole audit instead of
      // burning through the rest of the list one failure at a time.
      if (category === 'performance_provider_not_configured' || category === 'performance_provider_disabled') {
        throw err;
      }
      log('page audit failed', { auditId: audit.id, url: row.url, category, message });
      await sb.from('seo_performance_results').update({ status: 'unavailable' }).eq('id', row.id);
      unavailable++;
    }
  }

  await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 95, progressStage: 'saving', status: 'processing' });

  await sb.from('seo_performance_audits').update({
    status: 'completed',
    progress: 100,
    progress_stage: 'completed',
    pages_audited: audited,
    finished_at: new Date().toISOString(),
  }).eq('id', audit.id);

  await completeJob(config, { jobId });
  log('audit completed', { auditId: audit.id, jobId, audited, unavailable, total: pending.length });
}
