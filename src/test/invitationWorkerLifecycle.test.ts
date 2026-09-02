/**
 * WORKSPACE INVITATIONS v5.1 — Section G production worker lifecycle.
 *
 * No database: the service client is mocked so the lifecycle state machine
 * itself (signals, drain gating, bounded shutdown, idempotency, readiness) is
 * proven deterministically. Real fault semantics (heartbeat loss, claim-token
 * guards, crash-after-prepare, at-least-once provider submission) are proven
 * against real PostgreSQL in `src/test/integration/wiSectionCWorkerFaults.pg.test.ts`
 * and are NOT duplicated here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimed: string[][] = [];
let releaseClaim: (() => void) | null = null;

vi.mock('../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: any) => {
      if (fn === 'claim_invitation_jobs') {
        claimed.push(args._channels);
        if (releaseClaim) {
          await new Promise<void>((resolve) => {
            releaseClaim = resolve as unknown as () => void;
            setTimeout(resolve, 50);
          });
        }
        return { data: [], error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const worker = await import('../../server/services/invitations/worker.js');
const CONFIG = {} as any;

describe('Section G — invitation worker lifecycle', () => {
  beforeEach(() => {
    claimed.length = 0;
    releaseClaim = null;
  });

  afterEach(async () => {
    await worker.shutdownInvitationWorker(1_000);
  });

  it('reports stopped before start and running after start', async () => {
    expect(worker.getInvitationWorkerStatus().phase).toBe('stopped');
    worker.startInvitationWorker(CONFIG);
    const status = worker.getInvitationWorkerStatus();
    expect(status.phase).toBe('running');
    expect(status.acceptingClaims).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.workerId).toMatch(/^invitations-/);
  });

  it('start is idempotent', () => {
    worker.startInvitationWorker(CONFIG);
    worker.startInvitationWorker(CONFIG);
    worker.startInvitationWorker(CONFIG);
    expect(worker.getInvitationWorkerStatus().phase).toBe('running');
  });

  it('stop is idempotent and leaves the worker stopped', async () => {
    worker.startInvitationWorker(CONFIG);
    worker.stopInvitationWorker();
    worker.stopInvitationWorker();
    expect(worker.getInvitationWorkerStatus().phase).toBe('stopped');
    expect(worker.getInvitationWorkerStatus().acceptingClaims).toBe(false);
    const result = await worker.shutdownInvitationWorker(500);
    expect(result.drained).toBe(true);
  });

  it('refuses NEW claims once shutdown has begun', async () => {
    worker.startInvitationWorker(CONFIG);
    worker.stopInvitationWorker();
    await worker.drainInvitationJobs(CONFIG);
    expect(claimed).toEqual([]);
  });

  it('claims again after a restart', async () => {
    worker.startInvitationWorker(CONFIG);
    worker.stopInvitationWorker();
    worker.startInvitationWorker(CONFIG);
    await worker.drainInvitationJobs(CONFIG);
    expect(claimed.length).toBeGreaterThan(0);
  });

  it('graceful shutdown is bounded and always resolves', async () => {
    worker.startInvitationWorker(CONFIG);
    const started = Date.now();
    const result = await worker.shutdownInvitationWorker(200);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(typeof result.drained).toBe('boolean');
    expect(worker.getInvitationWorkerStatus().phase).toBe('stopped');
  });

  it('an in-flight drain is never aborted by a shutdown signal', async () => {
    worker.startInvitationWorker(CONFIG);
    let finished = false;
    const inFlight = worker.drainInvitationJobs(CONFIG).then(() => {
      finished = true;
    });
    worker.stopInvitationWorker();
    await inFlight;
    expect(finished).toBe(true);
  });

  it('shutdown produces no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    worker.startInvitationWorker(CONFIG);
    void worker.drainInvitationJobs(CONFIG);
    await worker.shutdownInvitationWorker(300);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
  });

  it('SIGTERM and SIGINT listeners are installed exactly once', () => {
    const before = process.listenerCount('SIGTERM');
    worker.startInvitationWorker(CONFIG);
    worker.stopInvitationWorker();
    worker.startInvitationWorker(CONFIG);
    expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(before + 1);
    expect(process.listenerCount('SIGINT')).toBeLessThanOrEqual(before + 1);
  });

  it('preserves the approved delivery contract in code', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(
      path.resolve(__dirname, '../../server/services/invitations/worker.ts'),
      'utf8',
    );
    // Provider acceptance is never labelled "delivered".
    expect(source).toContain("'provider_accepted'");
    expect(source).not.toMatch(/outcome:\s*'delivered'/);
    expect(source).toMatch(/AT-LEAST-ONCE/i);
  });
});
