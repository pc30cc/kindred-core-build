import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

/**
 * useEffectivePolicy polls /api/realtime/operator-connect every 30s. Its last
 * seen failover epoch used to live in state AND in the effect's dependencies,
 * so the first answer (a new epoch, compared with '') restarted the effect,
 * which polled again at once: two requests on every mount.
 */
const invalidate = vi.fn();
vi.mock('@/realtime/resolveClientRealtimeProvider', () => ({
  invalidateClientRealtimeCache: (ws: string) => invalidate(ws),
}));
vi.mock('@/realtime/policySnapshot', () => ({ setEffectivePolicySnapshot: () => undefined }));

const { useEffectivePolicy } = await import('@/hooks/useEffectivePolicy');

let epoch = 'epoch-1';
const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ effective_policy: { failover_epoch: epoch } }),
}));

function Host({ ws }: { ws: string }) {
  useEffectivePolicy(ws);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  epoch = 'epoch-1';
  fetchMock.mockClear();
  invalidate.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useEffectivePolicy', () => {
  it('polls once on mount, then once per 30s', async () => {
    render(<Host ws="ws-1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops the cached realtime provider when the epoch changes, and only then', async () => {
    render(<Host ws="ws-1" />);
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(1); // first sighting, as before

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(1); // same epoch: nothing to do

    epoch = 'epoch-2';
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
