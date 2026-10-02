import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../config.js';

/**
 * "Sign out of every other device" (DELETE /api/account/security/sessions/:id?all=1
 * with `keep_device`): the phones signed out stop receiving notifications too.
 */
interface Device {
  id: string;
  user_id: string;
  device_id: string;
  enabled: boolean;
  disabled_reason?: string | null;
}

let devices: Device[] = [];

vi.mock('../../supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      expect(table).toBe('mobile_push_devices');
      return {
        update: (patch: Partial<Device>) => {
          const filters: Array<(d: Device) => boolean> = [];
          const builder = {
            eq: (column: keyof Device, value: unknown) => {
              filters.push((d) => d[column] === value);
              return builder;
            },
            neq: (column: keyof Device, value: unknown) => {
              filters.push((d) => d[column] !== value);
              return builder;
            },
            select: async () => {
              const matched = devices.filter((d) => filters.every((f) => f(d)));
              for (const d of matched) Object.assign(d, patch);
              return { data: matched.map((d) => ({ id: d.id })), error: null };
            },
          };
          return builder;
        },
      };
    },
  }),
}));

const { disableOtherDevices } = await import('./devices.js');
const config = {} as ServerConfig;

describe('disableOtherDevices', () => {
  beforeEach(() => {
    devices = [
      { id: 'p1', user_id: 'sara', device_id: 'this-phone', enabled: true },
      { id: 'p2', user_id: 'sara', device_id: 'old-phone', enabled: true },
      { id: 'p3', user_id: 'sara', device_id: 'tablet', enabled: false, disabled_reason: 'user_logout' },
      { id: 'p4', user_id: 'ali', device_id: 'old-phone', enabled: true },
    ];
  });

  it('turns off every other phone of the account and keeps the one that asked', async () => {
    expect(await disableOtherDevices(config, 'sara', 'this-phone')).toBe(1);
    const byId = (id: string) => devices.find((d) => d.id === id)!;
    expect(byId('p1').enabled).toBe(true);
    expect(byId('p2')).toMatchObject({ enabled: false, disabled_reason: 'signed_out_elsewhere' });
    // Already off for its own reason: left with that reason.
    expect(byId('p3').disabled_reason).toBe('user_logout');
    // Never another account's, whatever its device is called.
    expect(byId('p4').enabled).toBe(true);
  });

  it('counts nothing when no other phone is on', async () => {
    devices = devices.filter((d) => d.id !== 'p2');
    expect(await disableOtherDevices(config, 'sara', 'this-phone')).toBe(0);
  });
});
