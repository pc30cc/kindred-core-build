/**
 * Phase 8C — Periodic queue expiry sweeper.
 * Runs in-process every 30s. Best-effort, never throws.
 */
import type { ServerConfig } from '../../config.js';
import { expireStaleEntries } from './queue.js';

const INTERVAL_MS = 30_000;

export function startCallQueueTicker(config: ServerConfig): void {
  setInterval(async () => {
    try {
      await expireStaleEntries(config);
    } catch (err: any) {
      console.warn('[callQueue] expiry sweep failed:', err?.message || err);
    }
  }, INTERVAL_MS).unref();
}