/**
 * The plans' SEO cooldowns (`seo_crawl_frequency_hours`,
 * `seo_backlinks_scan_frequency_hours`, `seo_keywords_lookup_frequency_hours`,
 * `seo_performance_audit_frequency_hours`, `brand_radar_check_frequency_hours`):
 * how long a new run must wait after the last one started. Their helpers
 * existed but no create path called them (audit ai-3, 2026-11-04), so a
 * manager could script runs back to back and the platform's provider spend
 * had no bound.
 *
 * A cooldown of 0 or less (-1 is "unlimited" in the plan editor) waits for
 * nothing, and no earlier run waits for nothing.
 */

/** Seconds still to wait before another run may start, or 0 when it may start now. */
export function cooldownRetryAfterSeconds(
  lastStartedAt: string | null | undefined,
  cooldownHours: number,
  now: number = Date.now(),
): number {
  if (!lastStartedAt || !Number.isFinite(cooldownHours) || cooldownHours <= 0) return 0;
  const last = new Date(lastStartedAt).getTime();
  if (!Number.isFinite(last)) return 0;
  const elapsedHours = (now - last) / 3_600_000;
  if (elapsedHours >= cooldownHours) return 0;
  return Math.max(1, Math.ceil((cooldownHours - Math.max(0, elapsedHours)) * 3600));
}
