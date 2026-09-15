/**
 * server/services/storage/scopeCleanupEngine.ts — the shared physical-scope
 * walker both workspaceDeletion/worker.ts and userDeletion/worker.ts drive.
 *
 * Second corrective pass regression coverage:
 *   - dedup by fingerprint (unchanged behavior, carried over from the
 *     first pass's per-worker implementation)
 *   - final re-verification pass: a 'done' scope is NOT settled until a
 *     fresh from-scratch listing finds it genuinely empty; a late write
 *     found during that pass is deleted and the scope is reopened rather
 *     than trusting 'done'
 *   - storage-config drift detection: a resumed 'in_progress' scope, or a
 *     'done' scope under verification, whose freshly-resolved fingerprint
 *     no longer matches the one recorded when progress began/finished is
 *     an error — the old cursor is NEVER applied against a different
 *     physical location, and the scope is never marked verified against it
 *   - heartbeat is invoked during a delete loop, and a heartbeat failure
 *     (lease lost) aborts immediately without further deletes/persists
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScopeCleanupTick, emptyScopeProgress, type ScopeCleanupState, type CleanupScope } from '../../../server/services/storage/scopeCleanupEngine';

const CFG_A = { provider: 's3' as const, bucket: 'bucket-a', accessKeyId: 'a', secretAccessKey: 'a' };
const CFG_B = { provider: 's3' as const, bucket: 'bucket-b', accessKeyId: 'b', secretAccessKey: 'b' };
const PREFIX = 'workspace/ws-1/';

const { listWithConfigMock, deleteWithConfigMock } = vi.hoisted(() => ({
  listWithConfigMock: vi.fn(),
  deleteWithConfigMock: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  listWithConfig: listWithConfigMock,
  deleteWithConfig: deleteWithConfigMock,
}));

function scope(name: string, config: typeof CFG_A | typeof CFG_B, configured = true): CleanupScope {
  return {
    name,
    resolve: async () => (configured ? { configured: true, config } : { configured: false, reason: 'not set up' }),
  };
}

let persisted: ScopeCleanupState = {};
async function persist(s: ScopeCleanupState): Promise<void> {
  persisted = JSON.parse(JSON.stringify(s));
}

beforeEach(() => {
  listWithConfigMock.mockReset();
  deleteWithConfigMock.mockReset();
  deleteWithConfigMock.mockResolvedValue({ success: true });
  persisted = {};
});

describe('runScopeCleanupTick — basic walk and dedup', () => {
  it('lists and deletes a fresh scope, marking it done (not yet verified) once the cursor is exhausted', async () => {
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`${PREFIX}a.pdf`], nextCursor: null });
    const state: ScopeCleanupState = {};

    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_A)],
      prefix: PREFIX,
      state,
      maxDeleteAttemptsPerKey: 3,
      heartbeat: async () => true,
      persist,
    });

    expect(outcome.kind).toBe('progress');
    expect(state.attachment.status).toBe('done');
    expect(state.attachment.verified).toBe(false);
    expect(deleteWithConfigMock).toHaveBeenCalledWith(CFG_A, `${PREFIX}a.pdf`);
  });

  it('dedups two scopes with the same fingerprint — only lists the physical location once', async () => {
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null }); // scope1 listing (empty, settles to done)
    const state: ScopeCleanupState = {};
    const scopes = [scope('attachment', CFG_A), scope('livekit_recording', CFG_A)]; // same config -> same fingerprint

    // Tick 1: attachment does its listing, becomes done (unverified); the
    // loop returns immediately after real listing/delete work, so
    // livekit_recording isn't touched yet this tick.
    let outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(outcome.kind).toBe('progress');
    expect(state.attachment.status).toBe('done');
    expect(listWithConfigMock).toHaveBeenCalledTimes(1);
    expect(state.livekit_recording).toBeUndefined();

    // Tick 2: attachment's verification pass (fresh empty listing) marks
    // it verified+settled (a cheap continue, not a return) — the SAME
    // tick then reaches livekit_recording, whose first-touch dedup check
    // finds attachment (already 'done' in the mutated state) sharing its
    // fingerprint, so it dedups immediately too (also a cheap continue).
    // With every scope now settled, the tick advances in one call.
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });
    outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(state.attachment.verified).toBe(true);
    expect(state.livekit_recording.dedup_of).toBe('attachment');
    expect(outcome.kind).toBe('advance');
    // The dupe never lists its own physical location — only the ONE
    // verification listing call this tick, on top of tick 1's original.
    expect(listWithConfigMock).toHaveBeenCalledTimes(2);
  });

  it('marks an unconfigured scope skipped_not_configured immediately, never listing/deleting', async () => {
    const state: ScopeCleanupState = {};
    const outcome = await runScopeCleanupTick({
      scopes: [scope('privacy_export', CFG_A, false)],
      prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist,
    });
    // The only scope in the array settles via a cheap continue (no real
    // work), so the loop falls straight through to 'advance' in one call.
    expect(outcome.kind).toBe('advance');
    expect(state.privacy_export.status).toBe('skipped_not_configured');
    expect(listWithConfigMock).not.toHaveBeenCalled();
  });

  it('advances once every scope is settled', async () => {
    const state: ScopeCleanupState = {
      attachment: { ...emptyScopeProgress('done'), verified: true, fingerprint: JSON.stringify(['s3', 'bucket-a', null, null, null, null]) },
      privacy_export: emptyScopeProgress('skipped_not_configured'),
    };
    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_A), scope('privacy_export', CFG_A, false)],
      prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist,
    });
    expect(outcome.kind).toBe('advance');
    expect(listWithConfigMock).not.toHaveBeenCalled();
  });
});

describe('runScopeCleanupTick — final verification (late-write detection)', () => {
  it('a done-but-unverified scope with nothing found on re-listing becomes verified', async () => {
    const state: ScopeCleanupState = {
      attachment: { status: 'done', cursor: null, objects_found: 1, objects_deleted: 1, error: null, fingerprint: JSON.stringify(['s3', 'bucket-a', null, null, null, null]), dedup_of: null, verified: false },
    };
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });

    const outcome = await runScopeCleanupTick({ scopes: [scope('attachment', CFG_A)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });

    // The only scope settles via a cheap continue after verification, so
    // the loop falls straight through to 'advance' in the same call.
    expect(outcome.kind).toBe('advance');
    expect(state.attachment.verified).toBe(true);
  });

  it('a late-written object found during verification is deleted and the scope is REOPENED, not advanced', async () => {
    const state: ScopeCleanupState = {
      attachment: { status: 'done', cursor: null, objects_found: 1, objects_deleted: 1, error: null, fingerprint: JSON.stringify(['s3', 'bucket-a', null, null, null, null]), dedup_of: null, verified: false },
    };
    // Verification pass finds a late write.
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`${PREFIX}late-write.zip`], nextCursor: null });

    const outcome = await runScopeCleanupTick({ scopes: [scope('attachment', CFG_A)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });

    expect(outcome.kind).toBe('progress');
    expect(deleteWithConfigMock).toHaveBeenCalledWith(CFG_A, `${PREFIX}late-write.zip`);
    expect(state.attachment.status).toBe('in_progress'); // reopened, NOT 'done'
    expect(state.attachment.verified).toBe(false);
    expect(state.attachment.objects_deleted).toBe(2); // 1 original + 1 late write

    // The job must NOT be allowed to advance to db_cleanup on this outcome.
    expect(outcome.kind).not.toBe('advance');
  });

  it('a scope reopened by a late write eventually re-settles to done+verified once truly empty', async () => {
    const state: ScopeCleanupState = {
      attachment: { status: 'done', cursor: null, objects_found: 1, objects_deleted: 1, error: null, fingerprint: JSON.stringify(['s3', 'bucket-a', null, null, null, null]), dedup_of: null, verified: false },
    };
    listWithConfigMock
      .mockResolvedValueOnce({ success: true, keys: [`${PREFIX}late.zip`], nextCursor: null }) // verification finds late write
      .mockResolvedValueOnce({ success: true, keys: [], nextCursor: null }); // resumed listing after reopen: empty -> done again
    const scopes = [scope('attachment', CFG_A)];

    let outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(state.attachment.status).toBe('in_progress');

    outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(state.attachment.status).toBe('done');
    expect(state.attachment.verified).toBe(false); // needs ANOTHER verification pass — never trusted blindly

    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });
    outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(state.attachment.verified).toBe(true);
    expect(outcome.kind).toBe('advance');
  });
});

describe('runScopeCleanupTick — storage config drift detection', () => {
  it('refuses to resume an in_progress scope whose cursor was recorded under a different physical config', async () => {
    const state: ScopeCleanupState = {
      attachment: {
        status: 'in_progress', cursor: 'tok-1', objects_found: 5, objects_deleted: 5, error: null,
        fingerprint: JSON.stringify(['s3', 'bucket-a', null, null, null, null]), // recorded under bucket-a
        dedup_of: null, verified: false,
      },
    };
    // The scope NOW resolves to bucket-b — config changed mid-cleanup.
    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_B)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist,
    });

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/storage_config_changed/);
    // The old cursor must never be applied against bucket-b.
    expect(listWithConfigMock).not.toHaveBeenCalled();
    expect(state.attachment.status).toBe('in_progress'); // NOT silently advanced or marked done
  });

  it('refuses to verify a done scope whose fingerprint no longer matches — never marks it verified against a different bucket', async () => {
    const state: ScopeCleanupState = {
      attachment: {
        status: 'done', cursor: null, objects_found: 3, objects_deleted: 3, error: null,
        fingerprint: JSON.stringify(['s3', 'bucket-a', null, null, null, null]),
        dedup_of: null, verified: false,
      },
    };
    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_B)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist,
    });

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/storage_config_changed/);
    expect(listWithConfigMock).not.toHaveBeenCalled();
    expect(state.attachment.verified).toBe(false);
  });

  it('the full drift regression scenario: bucket A -> cursor saved -> config changes to bucket B -> never applies the old cursor to B, never reports complete', async () => {
    // 1. Delete starts against bucket A.
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`${PREFIX}a1.pdf`], nextCursor: 'page-2' });
    const state: ScopeCleanupState = {};
    let scopes = [scope('attachment', CFG_A)];

    let outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(outcome.kind).toBe('progress');
    // 2. First page completes and cursor is saved.
    expect(state.attachment.cursor).toBe('page-2');
    expect(state.attachment.status).toBe('in_progress');
    const savedFingerprint = state.attachment.fingerprint;
    expect(savedFingerprint).toContain('bucket-a');

    // 3. Workspace storage config changes to bucket B.
    scopes = [scope('attachment', CFG_B)];

    // 4. Next tick runs.
    outcome = await runScopeCleanupTick({ scopes, prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });

    // 5. The old cursor ('page-2') is NEVER applied to bucket B.
    expect(listWithConfigMock).toHaveBeenCalledTimes(1); // only the original bucket-A call from step 1 — no call against bucket-B
    // 6. Deletion does not report complete while bucket A may still contain data.
    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/storage_config_changed/);
    expect(state.attachment.status).not.toBe('done');
    expect(state.attachment.verified).toBe(false);
  });
});

describe('runScopeCleanupTick — heartbeat during long delete loops', () => {
  it('calls heartbeat mid-loop once the interval elapses, and continues deleting when the lease still holds', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `${PREFIX}f${i}.pdf`);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys, nextCursor: null });
    let now = 0;
    const heartbeat = vi.fn(async () => true);
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));

    const state: ScopeCleanupState = {};
    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_A)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3,
      heartbeat, persist, heartbeatIntervalMs: 2_500,
    });

    expect(outcome.kind).toBe('progress');
    expect(deleteWithConfigMock).toHaveBeenCalledTimes(5);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(0);
    vi.spyOn(Date, 'now').mockImplementation(realNow);
  });

  it('stops immediately (no further deletes) when heartbeat reports the lease is lost mid-loop', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `${PREFIX}f${i}.pdf`);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys, nextCursor: null });
    let now = 0;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    const heartbeat = vi.fn(async () => false); // fenced out on the very first check

    const state: ScopeCleanupState = {};
    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_A)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3,
      heartbeat, persist, heartbeatIntervalMs: 500,
    });

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/lease lost/);
    // At least one delete happens before the fenced heartbeat is checked (interval-based), but not all 5.
    expect(deleteWithConfigMock.mock.calls.length).toBeLessThan(5);
    vi.spyOn(Date, 'now').mockImplementation(realNow);
  });
});

describe('runScopeCleanupTick — error paths', () => {
  it('reports an error (does not advance) when a listing fails', async () => {
    listWithConfigMock.mockResolvedValueOnce({ success: false, error: 'provider_unreachable' });
    const state: ScopeCleanupState = {};
    const outcome = await runScopeCleanupTick({ scopes: [scope('attachment', CFG_A)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(outcome.kind).toBe('error');
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
  });

  it('reports an error after exhausting per-key delete retries', async () => {
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`${PREFIX}stuck.pdf`], nextCursor: null });
    deleteWithConfigMock.mockResolvedValue({ success: false, error: 'permission_denied' });
    const state: ScopeCleanupState = {};
    const outcome = await runScopeCleanupTick({ scopes: [scope('attachment', CFG_A)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist });
    expect(outcome.kind).toBe('error');
    expect(deleteWithConfigMock).toHaveBeenCalledTimes(3); // MAX_DELETE_ATTEMPTS_PER_KEY
  });

  it('a scope that was configured earlier and becomes unconfigured mid-cleanup is an error, never silently settled', async () => {
    const state: ScopeCleanupState = {
      attachment: { status: 'in_progress', cursor: 'tok-1', objects_found: 1, objects_deleted: 1, error: null, fingerprint: 'x', dedup_of: null, verified: false },
    };
    const outcome = await runScopeCleanupTick({
      scopes: [scope('attachment', CFG_A, false)], prefix: PREFIX, state, maxDeleteAttemptsPerKey: 3, heartbeat: async () => true, persist,
    });
    expect(outcome.kind).toBe('error');
    expect(state.attachment.status).toBe('in_progress'); // untouched, not silently marked done/skipped
  });
});
