import { describe, it, expect, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config.js';
const { state } = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('../../../server/services/plugins/state.js', () => ({ getPlatformState: state }));
import { assertOpenCartPolicy, getOpenCartPolicy } from '../../../server/services/commerce/opencartPolicy.js';
describe('OpenCart platform controls', () => {
  it('blocks disabled sections and coalesces policy reads', async () => {
    state.mockResolvedValue({ enabled: true, maintenance_mode: false, policy: { opencartSections: { orders: false } } });
    const config = {} as ServerConfig;
    const before = state.mock.calls.length;
    await expect(assertOpenCartPolicy(config, 'orders')).rejects.toMatchObject({ code: 'commerce_permission_denied' });
    await expect(assertOpenCartPolicy(config, 'products')).resolves.toBeUndefined();
    expect(state.mock.calls.length - before).toBe(1);
  });
  it('fails closed on unavailable platform policy', async () => {
    state.mockRejectedValue(new Error('unavailable'));
    expect((await getOpenCartPolicy({} as ServerConfig)).enabled).toBe(false);
  });
  it.each([{ enabled: false }, { maintenance_mode: true }, { policy: { aiEnabled: false } }])('blocks platform shutdown %j', async (overrides) => {
    state.mockResolvedValue({ enabled: true, maintenance_mode: false, policy: {}, ...overrides });
    await expect(assertOpenCartPolicy({} as ServerConfig, 'products')).rejects.toMatchObject({ code: 'commerce_permission_denied' });
  });
});
