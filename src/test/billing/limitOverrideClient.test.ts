/**
 * UI client helper tests — verify the Super Admin Plans console
 * uses the canonical backend endpoints for workspace limit overrides.
 *
 * These pin:
 *   - setWorkspaceLimitOverride POSTs to /api/plans/admin/overrides/limit
 *     with the exact body shape the route validates against.
 *   - deleteWorkspaceLimitOverride DELETEs by id.
 *   - fetchWorkspaceOverrides surfaces the `limits` bucket so the UI
 *     can carry override id + value into edit/clear flows.
 *   - -1 (unlimited) round-trips through the helper unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/api', () => ({ API_BASE: 'http://x' }));

import {
  setWorkspaceLimitOverride,
  deleteWorkspaceLimitOverride,
  fetchWorkspaceOverrides,
} from '../../lib/entitlements-api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, statusText: 'OK' } as any;
}

describe('limit override client helpers', () => {
  it('POSTs to canonical endpoint with the limit body', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await setWorkspaceLimitOverride({
      workspaceId: 'ws_1', limitKey: 'max_contacts', limitValue: 250, adminNotes: 'n',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://x/api/plans/admin/overrides/limit');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      workspaceId: 'ws_1', limitKey: 'max_contacts', limitValue: 250, adminNotes: 'n',
    });
  });

  it('preserves -1 unlimited semantics on submit', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await setWorkspaceLimitOverride({
      workspaceId: 'ws_1', limitKey: 'max_contacts', limitValue: -1,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.limitValue).toBe(-1);
  });

  it('DELETEs override by id at the canonical endpoint', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await deleteWorkspaceLimitOverride('ovr_42');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://x/api/plans/admin/overrides/limit/ovr_42');
    expect(init.method).toBe('DELETE');
  });

  it('fetchWorkspaceOverrides surfaces limits with id + limit_value', async () => {
    fetchMock.mockResolvedValue(ok({
      modules: [],
      channels: [],
      limits: [{ id: 'ovr_1', workspace_id: 'ws_1', limit_key: 'max_contacts', limit_value: 500 }],
    }));
    const res = await fetchWorkspaceOverrides('ws_1');
    expect(res.limits).toHaveLength(1);
    expect(res.limits[0].limit_key).toBe('max_contacts');
    expect(res.limits[0].limit_value).toBe(500);
    expect(res.limits[0].id).toBe('ovr_1');
  });

  it('rejects when backend returns non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({ error: 'limitValue must be -1 (unlimited) or >= 0' }),
    } as any);
    await expect(
      setWorkspaceLimitOverride({ workspaceId: 'ws_1', limitKey: 'max_contacts', limitValue: -2 }),
    ).rejects.toThrow(/400/);
  });
});
