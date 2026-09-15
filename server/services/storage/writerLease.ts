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
 * Usage: a producer acquires a lease BEFORE acting on a positive
 * writability result, holds it for the entire duration of the external
 * write (renewing/heartbeating if it might run long), and releases it —
 * in a `finally`, unconditionally — only once that write has definitively
 * completed (success OR failure; either way the external side effect, if
 * any, has already happened by the time we release). Deletion workers
 * (workspaceDeletion/worker.ts, userDeletion/worker.ts) query this table
 * directly and refuse to trust ANY storage listing for an owner while an
 * unexpired lease still exists for it — see those modules' own doc
 * comments.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type OwnerKind = 'workspace' | 'user';

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
 * True iff at least one UNEXPIRED write lease exists for this owner right
 * now. Deletion workers call this before trusting any storage listing —
 * a `true` result means a producer is somewhere between its writability
 * check and the completion of its actual write, and any listing taken
 * right now could miss the object it's about to create. Fails OPEN to
 * "still leases outstanding" (`true`) on a query error — the caller's
 * response to `true` is always "wait, don't touch storage yet", so a
 * transient DB error here must never be mistaken for "clear to proceed".
 */
export async function hasActiveOwnerWriteLeases(
  serverConfig: ServerConfig,
  ownerKind: OwnerKind,
  ownerId: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { data, error } = await sb
      .from('owner_write_leases')
      .select('id')
      .eq('owner_kind', ownerKind)
      .eq('owner_id', ownerId)
      .gt('lease_expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (error) return true; // fail toward "wait" — see doc comment above
    return !!data;
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
 * `fn` at all. On success, returns `{ ok: true, result }`.
 */
export async function withOwnerWriteLease<T>(
  serverConfig: ServerConfig,
  ownerKind: OwnerKind,
  ownerId: string,
  purpose: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const lease = await acquireOwnerWriteLease(serverConfig, ownerKind, ownerId, purpose);
  if (!lease.ok || !lease.leaseId || !lease.leaseToken) {
    return { ok: false, error: lease.error || 'lease_acquisition_failed' };
  }
  const leaseId = lease.leaseId;
  const leaseToken = lease.leaseToken;

  const heartbeat = setInterval(() => {
    void renewOwnerWriteLease(serverConfig, leaseId, leaseToken);
  }, HEARTBEAT_INTERVAL_MS);
  // Never let the heartbeat timer itself keep the process alive.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    const result = await fn();
    return { ok: true, result };
  } finally {
    clearInterval(heartbeat);
    await releaseOwnerWriteLease(serverConfig, leaseId, leaseToken);
  }
}
