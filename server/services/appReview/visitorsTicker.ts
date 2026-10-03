/**
 * Keeps the App Review demo's visitors on the Visitors tab (migration 248).
 *
 * A seeded visitor has no browser behind it, so its presence goes stale
 * within minutes and the tab empties before a reviewer ever opens it. Once
 * a minute this marks them seen a minute ago; the database does nothing
 * while the review account is blocked or missing, so on a platform without
 * one this is a single cheap call.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const TICK_MS = 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

export async function keepAppReviewVisitorsLive(config: ServerConfig): Promise<void> {
  try {
    await getServiceClient(config).rpc('app_review_keep_visitors_live');
  } catch {
    // A database blip, or a platform without migration 248: next minute.
  }
}

export function startAppReviewVisitorsTicker(config: ServerConfig): void {
  if (timer) return;
  timer = setInterval(() => void keepAppReviewVisitorsLive(config), TICK_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function stopAppReviewVisitorsTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
