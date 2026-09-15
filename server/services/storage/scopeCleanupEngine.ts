/**
 * Shared physical-scope cleanup walker — the core "list, delete, dedup,
 * verify, detect drift" algorithm used by BOTH server/services/
 * workspaceDeletion/worker.ts (workspace/<id>/... across attachment/
 * privacy_export/livekit_recording scopes) and server/services/
 * userDeletion/worker.ts (users/<id>/... across default/privacy_export
 * scopes). Factored out so this intricate logic — which now has to get
 * dedup, resumability, late-write verification, AND storage-config-drift
 * detection all correct together — exists in exactly one place instead of
 * two near-identical, independently-bug-prone copies.
 *
 * Each caller supplies its own scope list, prefix, persisted state, and
 * (job-table-specific) heartbeat/persist callbacks; this module owns the
 * walking algorithm only, never talks to a specific jobs table directly.
 *
 * Algorithm per tick (processes ONE unit of work — one listing page, one
 * verification pass, or one dedup — never drains everything in one call,
 * so a huge workspace/user never monopolizes a tick):
 *
 *   For each scope, in order:
 *     - a scope already 'skipped_not_configured' or 'failed' is permanently
 *       settled — skip.
 *     - a scope whose progress is `dedup_of` another scope defers entirely
 *       to that target scope's own verified state — it never does its own
 *       listing/verification (same physical location, so the target's pass
 *       already covers it).
 *     - a scope 'done' AND verified is settled — skip.
 *     - a scope 'done' but NOT YET verified: re-resolve its config. If the
 *       fingerprint no longer matches the one recorded when the scope
 *       finished, this is CONFIG DRIFT — never silently restart against
 *       the new location (the old one might still hold data); surface an
 *       error instead. If it matches, do ONE fresh listing pass (cursor
 *       reset to null) — if it finds objects, a late write slipped past
 *       the deletion write barrier; delete them and reopen the scope
 *       (`in_progress`, verified stays false) so a later tick re-verifies;
 *       if it finds nothing, mark `verified: true`.
 *     - a scope 'in_progress' (mid-listing, cursor stored): re-resolve;
 *       fingerprint drift is checked the same way before the stored cursor
 *       is ever reused against what might now be a different physical
 *       location. If it matches, continue listing/deleting from the
 *       stored cursor.
 *     - a scope never touched before: resolve; if unconfigured, mark
 *       `skipped_not_configured` immediately (never retried). If
 *       configured and another already-'done' scope shares its
 *       StorageConfig fingerprint, dedup (`dedup_of`) instead of listing
 *       it at all. Otherwise start a fresh listing pass.
 *
 *   Once every scope in the list is settled (skipped_not_configured,
 *   failed, done+verified, or dedup_of a settled target), returns
 *   `{kind:'advance'}` — the caller moves its job to the next status.
 */
import { listWithConfig, deleteWithConfig, type StorageConfig } from './index.js';
import { storageConfigFingerprint } from './workspaceScopes.js';

export type ScopeProgressStatus = 'pending' | 'in_progress' | 'done' | 'skipped_not_configured' | 'failed';

export interface ScopeProgress {
  status: ScopeProgressStatus;
  cursor: string | null;
  objects_found: number;
  objects_deleted: number;
  error: string | null;
  /** Set once the scope's config is resolved — lets a later scope dedupe against it, and lets a resumed/verified scope detect drift. */
  fingerprint: string | null;
  /** Set when this scope was skipped because another scope with the same fingerprint already covers it. */
  dedup_of: string | null;
  /**
   * True once a from-scratch re-listing pass has found the scope
   * genuinely empty. A scope reaching `status:'done'` only means "the
   * last listing pass exhausted its cursor" — NOT that nothing has been
   * written there since (a late write from an in-flight producer that
   * started before the deletion write barrier engaged). `db_cleanup`
   * must never begin until every scope is done AND verified.
   */
  verified: boolean;
}

export type ScopeCleanupState = Record<string, ScopeProgress>;

export interface CleanupScope {
  name: string;
  resolve(): Promise<{ configured: true; config: StorageConfig } | { configured: false; reason: string }>;
}

export type ScopeCleanupOutcome =
  | { kind: 'advance' }
  | { kind: 'progress' }
  | { kind: 'error'; message: string };

export interface ScopeCleanupContext {
  scopes: CleanupScope[];
  prefix: string;
  state: ScopeCleanupState;
  maxDeleteAttemptsPerKey: number;
  /**
   * Renew the caller's lease. Called periodically during a long per-key
   * delete loop (never only between ticks) so a slow page of deletes
   * doesn't silently run past lease expiry without giving the caller a
   * chance to detect it lost the lease. Must return false the instant the
   * lease is no longer held (another worker reclaimed it) — the walker
   * aborts immediately without doing (or persisting) any further work.
   */
  heartbeat(): Promise<boolean>;
  /** Persist the (mutated in place) state after each unit of work. Implementations must throw if the write is fenced out (lease no longer held). */
  persist(state: ScopeCleanupState): Promise<void>;
  /** Renew-lease cadence during a delete loop, in ms. Exposed for tests; production callers use the default. */
  heartbeatIntervalMs?: number;
}

export function emptyScopeProgress(status: ScopeProgressStatus): ScopeProgress {
  return { status, cursor: null, objects_found: 0, objects_deleted: 0, error: null, fingerprint: null, dedup_of: null, verified: false };
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function findDoneScopeWithFingerprint(state: ScopeCleanupState, fingerprint: string): string | null {
  for (const [name, progress] of Object.entries(state)) {
    if (progress?.status === 'done' && progress.fingerprint === fingerprint && !progress.dedup_of) return name;
  }
  return null;
}

async function deleteKeysWithRetry(
  config: StorageConfig,
  keys: string[],
  maxAttemptsPerKey: number,
  heartbeat: () => Promise<boolean>,
  heartbeatIntervalMs: number,
): Promise<{ deleted: number; failedKey?: string; failedError?: string; fencedOut?: boolean }> {
  let deleted = 0;
  let lastHeartbeat = Date.now();
  for (const key of keys) {
    if (Date.now() - lastHeartbeat > heartbeatIntervalMs) {
      const stillHeld = await heartbeat();
      if (!stillHeld) return { deleted, fencedOut: true };
      lastHeartbeat = Date.now();
    }
    let ok = false;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttemptsPerKey && !ok; attempt++) {
      const del = await deleteWithConfig(config, key);
      ok = del.success;
      lastError = del.error;
    }
    if (!ok) return { deleted, failedKey: key, failedError: lastError };
    deleted++;
  }
  return { deleted };
}

/** Re-resolves a scope's config and checks it against a previously-recorded fingerprint. Returns the mismatch message, or null if it matches (or there was nothing to compare against yet). */
function driftMessage(scopeName: string, recordedFingerprint: string | null, freshFingerprint: string): string | null {
  if (recordedFingerprint && recordedFingerprint !== freshFingerprint) {
    return `scope ${scopeName}: storage_config_changed — this scope's physical provider changed since cleanup began; refusing to continue the old cursor or mark it verified against a different location. An operator must reconcile the original location (${recordedFingerprint}) before this can proceed.`;
  }
  return null;
}

export async function runScopeCleanupTick(ctx: ScopeCleanupContext): Promise<ScopeCleanupOutcome> {
  const { scopes, prefix, state, maxDeleteAttemptsPerKey, heartbeat, persist } = ctx;
  const heartbeatIntervalMs = ctx.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  for (const scope of scopes) {
    const existing = state[scope.name];

    if (existing?.dedup_of) {
      const target = state[existing.dedup_of];
      if (target?.status === 'done' && target.verified) continue; // settled via its dedup target
      continue; // target not yet verified — nothing for the dupe to do itself; wait
    }
    if (existing?.status === 'skipped_not_configured' || existing?.status === 'failed') continue;
    if (existing?.status === 'done' && existing.verified) continue;

    let resolution;
    try {
      resolution = await scope.resolve();
    } catch (err) {
      return { kind: 'error', message: `scope ${scope.name} resolve failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!resolution.configured) {
      if (!existing) {
        state[scope.name] = emptyScopeProgress('skipped_not_configured');
        await persist(state);
        continue;
      }
      // Was configured on an earlier tick, isn't now — never silently
      // declare a partially-cleaned (or unverified) scope settled.
      return { kind: 'error', message: `scope ${scope.name} became unconfigured mid-cleanup: ${resolution.reason}` };
    }

    const fingerprint = storageConfigFingerprint(resolution.config);

    // ── Verification pass on a 'done'-but-unverified scope ──
    if (existing?.status === 'done' && !existing.verified) {
      const drift = driftMessage(scope.name, existing.fingerprint, fingerprint);
      if (drift) return { kind: 'error', message: drift };

      const listing = await listWithConfig(resolution.config, prefix, undefined);
      if (!listing.success) {
        return { kind: 'error', message: `scope ${scope.name} verification listing failed: ${listing.error ?? 'unknown'}` };
      }
      const keys = listing.keys ?? [];
      if (keys.length === 0 && !listing.nextCursor) {
        existing.verified = true;
        await persist(state);
        continue;
      }
      // Late write(s) found during final verification — delete them and
      // reopen the scope instead of proceeding to db_cleanup.
      const delResult = await deleteKeysWithRetry(resolution.config, keys, maxDeleteAttemptsPerKey, heartbeat, heartbeatIntervalMs);
      if (delResult.fencedOut) return { kind: 'error', message: `scope ${scope.name}: lease lost during late-write verification cleanup` };
      existing.objects_deleted += delResult.deleted;
      if (delResult.failedKey) {
        return { kind: 'error', message: `scope ${scope.name}: failed to delete late-written object ${delResult.failedKey}: ${delResult.failedError ?? 'unknown'}` };
      }
      existing.objects_found += keys.length;
      existing.status = 'in_progress';
      existing.cursor = listing.nextCursor ?? null;
      existing.verified = false;
      await persist(state);
      return { kind: 'progress' };
    }

    // ── Resuming an in-progress scope, or starting a new one ──
    let cur: ScopeProgress;
    if (!existing) {
      const dedupTarget = findDoneScopeWithFingerprint(state, fingerprint);
      if (dedupTarget) {
        const src = state[dedupTarget]!;
        state[scope.name] = {
          status: 'done', cursor: null, objects_found: src.objects_found, objects_deleted: src.objects_deleted,
          error: null, fingerprint, dedup_of: dedupTarget, verified: src.verified,
        };
        await persist(state);
        continue;
      }
      cur = { status: 'in_progress', cursor: null, objects_found: 0, objects_deleted: 0, error: null, fingerprint, dedup_of: null, verified: false };
      state[scope.name] = cur;
    } else {
      const drift = driftMessage(scope.name, existing.fingerprint, fingerprint);
      if (drift) return { kind: 'error', message: drift };
      cur = existing;
    }

    const listing = await listWithConfig(resolution.config, prefix, cur.cursor ?? undefined);
    if (!listing.success) {
      return { kind: 'error', message: `scope ${scope.name} listing failed: ${listing.error ?? 'unknown'}` };
    }

    const keys = listing.keys ?? [];
    const delResult = await deleteKeysWithRetry(resolution.config, keys, maxDeleteAttemptsPerKey, heartbeat, heartbeatIntervalMs);
    if (delResult.fencedOut) return { kind: 'error', message: `scope ${scope.name}: lease lost mid-delete-loop` };
    cur.objects_deleted += delResult.deleted;
    if (delResult.failedKey) {
      return { kind: 'error', message: `scope ${scope.name}: failed to delete ${delResult.failedKey}: ${delResult.failedError ?? 'unknown'}` };
    }
    cur.objects_found += keys.length;
    cur.cursor = listing.nextCursor ?? null;
    if (!cur.cursor) cur.status = 'done'; // NOT verified yet — the caller's next pass over this scope runs the verification branch above

    await persist(state);
    return { kind: 'progress' };
  }

  return { kind: 'advance' };
}
