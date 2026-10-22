/**
 * Visitor tracking data retention (P-01, migration 281).
 *
 * The visitor tracking tables — visitor_sessions, visitor_page_views,
 * web_analytics_events, widget_smart_events and widget_ai_nudges — each have
 * a rolling, workspace-overridable policy in data_retention_policies (13
 * months by default; a workspace's own period in
 * widget_settings.visitor_data_retention_days, Settings → Privacy requests).
 * This runs them through the retention engine every six hours, so a period
 * holds without anyone pressing "Run" in Super Admin → Data retention, which
 * still shows, previews, tunes and disables them (a disabled policy is
 * skipped by the engine). Page views go before their sessions, whose delete
 * would take them along anyway (ON DELETE CASCADE).
 *
 * Best-effort, in-process, never throws. Before migration 281 the policies
 * do not exist: that is logged once and the sweep keeps trying.
 */
import type { ServerConfig } from '../../config.js';
import { runPolicy, RetentionError } from '../retention/retentionService.js';

export const VISITOR_RETENTION_POLICY_KEYS = [
  'visitor_page_views',
  'web_analytics_events',
  'widget_smart_events',
  'widget_ai_nudges',
  'visitor_sessions',
] as const;

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const BOOT_DELAY_MS = 10 * 60 * 1000;        // 10 minutes after boot

let started = false;
let missingLogged = false;

/** One pass over the visitor policies; what each did, by key. */
export async function sweepVisitorDataRetention(config: ServerConfig): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of VISITOR_RETENTION_POLICY_KEYS) {
    try {
      const outcome = await runPolicy(config, key, { triggeredBy: 'visitor_retention' });
      out[key] = outcome.status;
      if (outcome.status === 'failed') console.warn(`[visitorRetention] ${key} failed:`, outcome.error);
    } catch (err) {
      if (err instanceof RetentionError && err.code === 'policy_not_found') {
        out[key] = 'missing';
        if (!missingLogged) {
          missingLogged = true;
          console.warn('[visitorRetention] the visitor retention policies are missing (migration 281 not applied yet)');
        }
        continue;
      }
      out[key] = 'error';
      console.warn(`[visitorRetention] ${key}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

export function startVisitorDataRetention(config: ServerConfig): void {
  if (started) return;
  started = true;
  const run = () => { void sweepVisitorDataRetention(config).catch(() => undefined); };
  const boot = setTimeout(() => {
    run();
    const id = setInterval(run, RUN_INTERVAL_MS);
    id.unref?.();
  }, BOOT_DELAY_MS);
  boot.unref?.();
}
