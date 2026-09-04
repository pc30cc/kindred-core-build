/**
 * Reconnect-labeling fix — see server/routes/realtime.ts's `intent` field.
 *
 * A bounded (max RECONNECT_TTL_MAP_MAX entries, FIFO eviction) map from
 * `workspaceId:subjectId` to the last time a connection token was granted,
 * used to tell a genuine reconnect (something actually failed — network
 * drop, server restart, a tab waking from sleep with an already-invalid
 * token, or a true first connect) from a routine proactive token refresh
 * (src/realtime/providers/centrifugo.ts's scheduleTokenRefresh, which
 * re-negotiates ~2 minutes before expiry on a perfectly healthy socket).
 *
 * This is a heuristic (elapsed-time-vs-TTL threshold), not a hard protocol
 * signal — tunable, and worth validating against real traffic before being
 * trusted for alerting thresholds.
 */
import { RECONNECT_TTL_MAP_MAX } from './constants.js';

export type ReconnectClassification = 'genuine' | 'routine_refresh';

interface GrantRecord {
  lastGrantAt: number;
  tokenTtlMs: number;
}

export class ReconnectClassifier {
  private readonly grants = new Map<string, GrantRecord>();

  private key(workspaceId: string, subjectId: string): string {
    return `${workspaceId}:${subjectId}`;
  }

  /** Call BEFORE minting a new token. */
  classify(workspaceId: string, subjectId: string, tokenTtlMs: number): ReconnectClassification {
    const k = this.key(workspaceId, subjectId);
    const prev = this.grants.get(k);
    if (!prev) return 'genuine'; // never seen (or evicted) — true first connect
    const elapsed = Date.now() - prev.lastGrantAt;
    if (elapsed > prev.tokenTtlMs * 3) {
      this.grants.delete(k); // wildly stale — treat as fresh, don't let ancient state linger
      return 'genuine';
    }
    // Re-negotiating in the back half of the token's lifetime is consistent
    // with a proactive refresh cycle; sooner than that means something
    // actually interrupted the connection.
    return elapsed < prev.tokenTtlMs * 0.5 ? 'genuine' : 'routine_refresh';
  }

  /** Call AFTER a token is successfully issued. */
  recordGrant(workspaceId: string, subjectId: string, tokenTtlMs: number): void {
    const k = this.key(workspaceId, subjectId);
    if (!this.grants.has(k) && this.grants.size >= RECONNECT_TTL_MAP_MAX) {
      const oldest = this.grants.keys().next().value; // Map preserves insertion order
      if (oldest !== undefined) this.grants.delete(oldest);
    }
    this.grants.delete(k); // re-insert to refresh insertion-order position (poor-man's LRU)
    this.grants.set(k, { lastGrantAt: Date.now(), tokenTtlMs });
  }

  size(): number {
    return this.grants.size;
  }
}
