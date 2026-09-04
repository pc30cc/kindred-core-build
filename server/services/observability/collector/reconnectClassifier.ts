/**
 * Reconnect-labeling fix — see server/routes/realtime.ts's `intent` field.
 *
 * The client (widget runtime / src/realtime/providers/centrifugo.ts) is the
 * source of truth for whether a given connect call is an `initial` connect,
 * a proactive `refresh` (socket still healthy, re-negotiating ahead of
 * token expiry), a genuine `reconnect` (the socket actually closed and the
 * client is retrying), or a `policy_poll` heartbeat unrelated to the
 * connection lifecycle. Only `intent: 'reconnect'` increments
 * `realtime.reconnect_attempt` — this module no longer decides that.
 *
 * What remains here is bounded bookkeeping in support of that decision:
 *   • recordGrant() — tracks the last time a subject was actually granted a
 *     token, purely for the `hadPriorGrant` sanity flag below.
 *   • validateReconnect() — called only for an explicitly-declared
 *     `intent: 'reconnect'`, to (a) deduplicate near-simultaneous reconnect
 *     reports for the same subject (e.g. multiple tabs racing the same
 *     disconnect, or a client retry racing itself) so the dashboard doesn't
 *     double count a single real event, and (b) flag whether a prior grant
 *     even exists, for diagnostics. Neither check gates or overrides the
 *     client's declared intent — it is validation/dedup only, not
 *     classification.
 */
import { RECONNECT_TTL_MAP_MAX } from './constants.js';

/** Reconnect reports for the same (workspace, subject) within this window are deduped. */
const DEDUP_WINDOW_MS = 2_000;

export interface ReconnectValidation {
  /** True if an earlier reconnect report for the same subject landed within DEDUP_WINDOW_MS. */
  duplicate: boolean;
  /** True if a token grant is on record for this subject (diagnostic only). */
  hadPriorGrant: boolean;
}

interface GrantRecord {
  lastGrantAt: number;
  tokenTtlMs: number;
}

export class ReconnectClassifier {
  private readonly grants = new Map<string, GrantRecord>();
  private readonly lastReconnectAt = new Map<string, number>();

  private key(workspaceId: string, subjectId: string): string {
    return `${workspaceId}:${subjectId}`;
  }

  /** Call AFTER a token is successfully issued (any non-policy_poll intent). */
  recordGrant(workspaceId: string, subjectId: string, tokenTtlMs: number): void {
    const k = this.key(workspaceId, subjectId);
    if (!this.grants.has(k) && this.grants.size >= RECONNECT_TTL_MAP_MAX) {
      const oldest = this.grants.keys().next().value; // Map preserves insertion order
      if (oldest !== undefined) this.grants.delete(oldest);
    }
    this.grants.delete(k); // re-insert to refresh insertion-order position (poor-man's LRU)
    this.grants.set(k, { lastGrantAt: Date.now(), tokenTtlMs });
  }

  /**
   * Call only when intent === 'reconnect'. Does NOT decide whether this is
   * "really" a reconnect — the client already declared that. Only dedupes
   * near-simultaneous reports and flags whether any prior grant exists.
   */
  validateReconnect(workspaceId: string, subjectId: string): ReconnectValidation {
    const k = this.key(workspaceId, subjectId);
    const now = Date.now();
    const lastAt = this.lastReconnectAt.get(k);
    const duplicate = lastAt !== undefined && now - lastAt < DEDUP_WINDOW_MS;
    if (!duplicate) {
      if (!this.lastReconnectAt.has(k) && this.lastReconnectAt.size >= RECONNECT_TTL_MAP_MAX) {
        const oldest = this.lastReconnectAt.keys().next().value;
        if (oldest !== undefined) this.lastReconnectAt.delete(oldest);
      }
      this.lastReconnectAt.delete(k);
      this.lastReconnectAt.set(k, now);
    }
    return { duplicate, hadPriorGrant: this.grants.has(k) };
  }

  size(): number {
    return this.grants.size;
  }
}
