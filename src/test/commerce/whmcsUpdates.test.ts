import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../server/services/plugins/state.js', () => ({ getPlatformState: vi.fn() }));
import { getPlatformState } from '../../../server/services/plugins/state.js';
import { whmcsUpdatesRouter } from '../../../server/routes/whmcsUpdates.js';

const state = vi.mocked(getPlatformState);
const app = express();
app.use('/updates', whmcsUpdatesRouter);
describe('WHMCS release policy', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([
    [true, false, {}, true],
    [true, false, { autoUpdateEnabled: false }, false],
    [false, false, {}, false],
    [true, true, {}, false],
    [true, false, { aiEnabled: false }, true],
  ])('respects platform update policy', async (enabled, maintenance_mode, policy, expected) => {
    state.mockResolvedValue({ enabled, maintenance_mode, policy } as Awaited<ReturnType<typeof getPlatformState>>);
    const response = await request(app).get('/updates');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: expected });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('fails closed on database errors', async () => {
    state.mockRejectedValue(new Error('private database details'));
    const response = await request(app).get('/updates');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ enabled: false });
  });
});
