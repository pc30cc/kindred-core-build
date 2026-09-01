/**
 * AI billing — automatic recovery scheduler behaviour.
 *
 * The scheduler must never let two passes overlap in one process, must record
 * the last report/error for the Super Admin health view, and must survive a
 * failing pass without stopping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runRecovery = vi.fn();

vi.mock('../../../server/services/ai-billing/recovery', () => ({
  runAiBillingRecovery: (...args: unknown[]) => runRecovery(...args),
}));

const config = {} as any;

describe('AI billing recovery scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    runRecovery.mockReset();
  });

  afterEach(async () => {
    const mod = await import('../../../server/services/ai-billing/recoveryTicker');
    mod.stopAiBillingRecovery();
  });

  it('skips an overlapping tick instead of running recovery twice in parallel', async () => {
    let release!: () => void;
    runRecovery.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ releasedReservations: 0 }); }),
    );
    const { tick } = await import('../../../server/services/ai-billing/recoveryTicker');

    const first = tick(config);
    const second = await tick(config); // while the first is still in flight
    expect(second).toBeNull();
    expect(runRecovery).toHaveBeenCalledTimes(1);

    release();
    await first;
    runRecovery.mockResolvedValueOnce({ releasedReservations: 0 });
    await tick(config);
    expect(runRecovery).toHaveBeenCalledTimes(2);
  });

  it('records the last report and clears the previous error', async () => {
    const { tick, getAiBillingRecoveryStatus } = await import(
      '../../../server/services/ai-billing/recoveryTicker'
    );
    runRecovery.mockRejectedValueOnce(new Error('db down'));
    await tick(config);
    expect(getAiBillingRecoveryStatus().lastError?.message).toContain('db down');

    runRecovery.mockResolvedValueOnce({ releasedReservations: 3 });
    await tick(config);
    const status = getAiBillingRecoveryStatus();
    expect(status.lastError).toBeNull();
    expect(status.lastReport?.releasedReservations).toBe(3);
    expect(status.running).toBe(false);
  });

  it('keeps ticking after a failed pass', async () => {
    const { tick } = await import('../../../server/services/ai-billing/recoveryTicker');
    runRecovery.mockRejectedValueOnce(new Error('boom'));
    await expect(tick(config)).resolves.toBeNull();
    runRecovery.mockResolvedValueOnce({ releasedReservations: 0 });
    await expect(tick(config)).resolves.toBeTruthy();
  });
});
