/**
 * Owner write leases — closes the TOCTOU gap between a point-in-time
 * writability check (isWorkspaceWritable/isUserWritable) and the actual
 * external write it was meant to gate.
 *
 * Fourth corrective pass, P0: a point-in-time check is not a write
 * barrier. `isWorkspaceWritable()` returning `true` only proves the
 * workspace was active at the instant of that read — nothing stops
 * deletion from starting a moment later, before the producer's actual S3
 * PUT / LiveKit Egress start call has completed. `database/migrations/
 * 187_owner_write_leases.sql`'s `acquire_owner_write_lease()` RPC closes
 * this by making the writability check and the lease's creation a single
 * atomic operation, row-locked against the SAME workspace/profile row
 * `enqueue_workspace_deletion()`/`enqueue_user_deletion()` lock when they
 * flip an owner into its deletion lifecycle — see that migration's header
 * comment for the full argument and a live-Postgres proof of the
 * serialization in both directions.
 *
 * Fifth corrective pass, P0: closing acquisition's TOCTOU gap wasn't
 * enough on its own — the lease's own EXPIRY was a second one.
 * `renew_owner_write_lease()` (188_owner_write_lease_hardening.sql) can
 * no longer resurrect an already-expired lease (a delayed heartbeat
 * arriving after `lease_expires_at` gets `lease_expired`, never a fresh
 * extension). And a lease going quiet (DB connectivity lost, the process
 * crashed, a GC pause) does NOT mean the external write it was covering
 * has actually stopped — that write is independent of the lease's DB-side
 * bookkeeping and could still be landing bytes. `hasActiveOwnerWriteLeases`
 * therefore no longer treats "past nominal expiry" as "safe to ignore":
 * it calls `has_active_owner_write_leases()`, which keeps a lease
 * counting as active for a RECONCILIATION GRACE PERIOD past its nominal
 * expiry (`RECONCILIATION_GRACE_SECONDS`, default matches the DB
 * function's own default) — long enough to guarantee any write that
 * lease could have covered has either completed or been aborted by its
 * own hard timeout (`PROVIDER_UPLOAD_TIMEOUT_MS` in
 * server/services/storage/index.ts — see that constant's doc comment for
 * why the grace period is provably sufficient, not just generous). The
 * comparison itself runs entirely in Postgres, using `now()` — never an
 * application-server wall clock — so this safety decision cannot be
 * skewed by app-server/DB clock drift.
 *
 * Usage: a producer acquires a lease BEFORE acting on a positive
 * writability result, holds it for the entire duration of the external
 * write (renewing/heartbeating if it might run long), and releases it —
 * in a `finally`, unconditionally — only once that write has definitively
 * completed (success OR failure; either way the external side effect, if
 * any, has already happened by the time we release). `withOwnerWriteLease`
 * additionally tracks whether every heartbeat renewal succeeded and, if
 * any failed, downgrades an otherwise-successful `fn()` result to a
 * failure — a producer must not report its write as safely committed
 * when it can no longer prove it held the lease the entire time; see that
 * function's own doc comment. Deletion workers (workspaceDeletion/
 * worker.ts, userDeletion/worker.ts) call `hasActiveOwnerWriteLeases` and
 * refuse to trust ANY storage listing for an owner while it reports
 * `true` — see those modules' own doc comments.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type OwnerKind = 'workspace' | 'user';

/**
 * How long a lease keeps counting as "must still wait on this" past its
 * own nominal `lease_expires_at`. MUST exceed the longest a provider
 * write call can still be in flight after its last successful heartbeat
 * — server/services/storage/index.ts's PROVIDER_UPLOAD_TIMEOUT_MS (2 min)
 * plus the heartbeat interval below (30s) plus a comfortable margin for
 * scheduling jitter and DB round-trip latency. 600s (10 min) is that
 * bound with a wide safety margin, matching 188's own DB-side default —
 * passed explicitly here (rather than relying on the RPC's default) so
 * the two stay visibly in sync if either is ever tuned.
 */
const RECONCILIATION_GRACE_SECONDS = 600;

/**
 * Deliberately a single flat shape (not a discriminated union) — this
 * project's tsconfig.server.json runs with strictNullChecks: false, under
 * which `if (!x.ok) return x.error` control-flow narrowing across a
 * union return type is unreliable. `leaseId`/`leaseToken` are only ever
 * populated together with `ok: true`; `error` only with `ok: false` — a
 * caller checks `.ok` first, exactly as it would with a real discriminated
 * union, just without relying on the compiler to enforce it.
 */
export interface LeaseAcquisitionResult {
  ok: boolean;
  leaseId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  error?: string;
}

const DEFAULT_LEASE_SECONDS = 120;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The only way a write lease is created — atomically checks the owner is
 * currently writable AND creates the lease row, in the same DB
 * transaction, row-locked against enqueue_workspace_deletion()/
 * enqueue_user_deletion() (see 187's header comment). A `false` result
 * here means exactly what isWorkspaceWritable()/isUserWritable() already
 * meant — never write — this just also guarantees no deletion can start
 * in the gap between this check and the caller's next line of code.
 */
export async function acquireOwnerWriteLease(
  serverConfig: ServerConfig,
  ownerKind: OwnerKind,
  ownerId: string,
  purpose: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<LeaseAcquisitionResult> {
  try {
    const sb = getServiceClient(serverConfig);
    const { data, error } = await sb.rpc('acquire_owner_write_lease', {
      _owner_kind: ownerKind,
      _owner_id: ownerId,
      _purpose: purpose,
      _lease_seconds: leaseSeconds,
    });
    if (error || !data?.ok) {
      return { ok: false, error: (data && data.error) || error?.message || 'lease_acquisition_failed' };
    }
    return { ok: true, leaseId: data.lease_id, leaseToken: data.lease_token, leaseExpiresAt: data.lease_expires_at };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Heartbeat: extends the lease without changing its token. Returns false the instant it's no longer held (expired/released/never existed). */
export async function renewOwnerWriteLease(
  serverConfig: ServerConfig,
  leaseId: string,
  leaseToken: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { data, error } = await sb.rpc('renew_owner_write_lease', {
      _lease_id: leaseId,
      _lease_token: leaseToken,
      _lease_seconds: leaseSeconds,
    });
    return !error && !!data?.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort, idempotent. A release that fails (network blip, or the
 * lease already expired and was swept) is never fatal to the caller's own
 * operation — the lease will simply expire on its own, which is exactly
 * the crash-safety property that makes deletion never wedge forever.
 * Never throws.
 */
export async function releaseOwnerWriteLease(
  serverConfig: ServerConfig,
  leaseId: string,
  leaseToken: string,
): Promise<void> {
  try {
    const sb = getServiceClient(serverConfig);
    await sb.rpc('release_owner_write_lease', { _lease_id: leaseId, _lease_token: leaseToken });
  } catch {
    // Best-effort — see doc comment above.
  }
}

/**
 * True iff at least one write lease for this owner is still within its
 * reconciliation window (unexpired, OR expired less than
 * RECONCILIATION_GRACE_SECONDS ago — see this module's doc comment for
 * why an expired-but-recent lease must still block). Deletion workers
 * call this before trusting any storage listing — `true` means a
 * producer is somewhere between its writability check and the PROVABLE
 * completion of its actual write, and any listing taken right now could
 * miss the object it's about to create. The active/expired-but-in-grace
 * comparison runs entirely in Postgres via `now()` — never an
 * application-server wall clock, so this can never be skewed by
 * app-server/DB clock drift. Fails OPEN to "still active" (`true`) on an
 * RPC error — the caller's response to `true` is always "wait, don't
 * touch storage yet", so a transient DB error here must never be
 * mistaken for "clear to proceed".
 */
export async function hasActiveOwnerWriteLeases(
  serverConfig: ServerConfig,
  ownerKind: OwnerKind,
  ownerId: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { data, error } = await sb.rpc('has_active_owner_write_leases', {
      _owner_kind: ownerKind,
      _owner_id: ownerId,
      _reconciliation_grace_seconds: RECONCILIATION_GRACE_SECONDS,
    });
    if (error || !data?.ok) return true; // fail toward "wait" — see doc comment above
    return !!data.active;
  } catch {
    return true;
  }
}

/**
 * Acquires a write lease, runs `fn` while heartbeating it periodically,
 * and releases it in a `finally` — the standard shape every owner-scoped
 * write barrier consumer (uploadForOwner, uploadWithConfigForOwner,
 * livekitProvider.startRecording) uses so the lease lifecycle logic lives
 * in exactly one place. `fn` receives nothing; if the caller needs the
 * lease id/token itself (e.g. to hold it across a callback the caller
 * controls, like livekitProvider's onStarted), acquire directly instead —
 * this wrapper is for the common "acquire, do one write, release" case.
 *
 * On acquisition failure, returns `{ ok: false, error }` without calling
 * `fn` at all.
 *
 * Fifth corrective pass, P0: heartbeat renewal is no longer
 * fire-and-forget. Every renewal's result is tracked; if ANY renewal
 * fails while `fn` is running, the lease is no longer provably held, and
 * `fn`'s eventual result — even a successful one — is downgraded to
 * `{ ok: false, error: 'lease_lost_during_write' }`. This is deliberate:
 * a producer that lost its lease mid-write cannot prove the write is
 * safe to trust (the underlying provider call is independent of the
 * lease's DB bookkeeping and may still be landing bytes after this
 * function returns), so it must never report success to its own caller.
 * A single trailing renewal, issued right after `fn()` resolves, is the
 * authoritative final check — it also catches the case where `fn()` ran
 * long enough to approach or pass the lease's expiry without a heartbeat
 * tick ever having fired.
 *
 * Sixth corrective pass, P0: the fifth pass's downgrade only affected the
 * RETURN VALUE — the `finally` block still released (deleted) the lease
 * row unconditionally, including in every case above. That destroys the
 * exact evidence `hasActiveOwnerWriteLeases`'s reconciliation grace
 * period depends on: the instant the row is gone, deletion sees zero
 * active leases and stops waiting, even though the write it covered may
 * genuinely still be in flight. A clean release is now conditioned on
 * `provablyComplete` — true ONLY when `fn()` resolved (not threw), no
 * heartbeat ever reported the lease lost, AND the trailing renewal
 * confirms it's still held. This also protects the ambiguous case where
 * `fn()` itself THROWS (e.g. `PROVIDER_UPLOAD_TIMEOUT_MS`'s
 * AbortController firing): a client-side timeout is not proof the
 * provider never received the request — it may have already landed and
 * be completing server-side — so that case must be treated exactly like
 * a lost lease, not like "the write definitely didn't happen". Whenever
 * `provablyComplete` stays false, the row is deliberately left as-is:
 * its `lease_expires_at` (from acquisition or the last successful
 * renewal) will pass, and `has_active_owner_write_leases` keeps counting
 * it as active for `RECONCILIATION_GRACE_SECONDS` past that — the same
 * natural-expiry mechanism that already makes a crashed producer safe,
 * reused here rather than inventing a parallel "stale" state.
 */
export async function withOwnerWriteLease<T>(
  serverConfig: ServerConfig,
  ownerKind: OwnerKind,
  ownerId: string,
  purpose: string,
  fn: () => Promise<T>,
  // Flat shape (not a discriminated union) for the same
  // strictNullChecks:false narrowing-reliability reason as
  // LeaseAcquisitionResult above — a caller checks `.ok` first.
): Promise<{ ok: boolean; result?: T; error?: string }> {
  const lease = await acquireOwnerWriteLease(serverConfig, ownerKind, ownerId, purpose);
  if (!lease.ok || !lease.leaseId || !lease.leaseToken) {
    return { ok: false, error: lease.error || 'lease_acquisition_failed' };
  }
  const leaseId = lease.leaseId;
  const leaseToken = lease.leaseToken;
  let leaseLost = false;
  let provablyComplete = false;

  const heartbeat = setInterval(() => {
    void renewOwnerWriteLease(serverConfig, leaseId, leaseToken).then((stillHeld) => {
      if (!stillHeld) leaseLost = true;
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Never let the heartbeat timer itself keep the process alive.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    const result = await fn();
    const stillHeldAtCompletion = await renewOwnerWriteLease(serverConfig, leaseId, leaseToken);
    if (leaseLost || !stillHeldAtCompletion) {
      // Ownership cannot be proven continuous for the full operation —
      // leave the row for natural expiry+grace (see finally below)
      // rather than releasing it.
      return { ok: false, error: 'lease_lost_during_write' };
    }
    provablyComplete = true;
    return { ok: true, result };
  } finally {
    clearInterval(heartbeat);
    if (provablyComplete) {
      await releaseOwnerWriteLease(serverConfig, leaseId, leaseToken);
    }
    // else: deliberately not released — see this function's doc comment.
    // Covers both `fn()` throwing (ambiguous — the write may have still
    // landed on the provider side) and a lost/unconfirmed lease.
  }
}
