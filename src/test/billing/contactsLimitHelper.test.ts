/**
 * Runtime behavior tests for the contacts-limit helper.
 *
 * Covers:
 *   - single create below cap → proceeds
 *   - single create at cap → 403
 *   - bulk batch fits → proceeds
 *   - bulk batch would exceed cap → 403 with structured all-or-nothing payload
 *   - missing workspace_id → 400
 *
 * The contacts limit composition reuses the existing TypeScript stack
 * (`requireLimit` + `usageFnForLimit('max_contacts')`); no SQL-side
 * composer is introduced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const rpcMock = vi.fn();
const countMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          // resolveMaxContacts uses { count: 'exact', head: true } so the
          // chain ends at .eq() which must be awaitable returning {count}.
          then: (resolve: (value: unknown) => unknown) => resolve(countMock()),
        }),
      }),
    }),
  }),
}));

import {
  enforceMaxContactsCreate,
  assertContactsBatchFits,
} from '../../../server/services/billing/contactsLimit';
import { clearEntitlementCache } from '../../../server/middleware/featureGating';

function makeReqRes(body: Record<string, unknown> = { workspace_id: 'ws-x' }) {
  const req = {
    body,
    query: {},
    params: {},
    serverConfig: { supabaseUrl: 'http://stub', supabaseServiceRoleKey: 'key' },
  } as unknown as Request;
  let statusCode: number | undefined;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(p: Record<string, unknown>) { payload = p; return res; },
  } as unknown as Response;
  return { req, res, getStatus: () => statusCode, getPayload: () => payload ?? {} };
}

describe('contacts limit helper — single create', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    countMock.mockReset();
    clearEntitlementCache();
  });

  it('proceeds when below cap', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 100, plan: 'pro' }, error: null });
    countMock.mockResolvedValue({ count: 3, error: null });
    const { req, res, getStatus } = makeReqRes();
    const ok = await enforceMaxContactsCreate(req, res, 'ws-x');
    expect(ok).toBe(true);
    expect(getStatus()).toBeUndefined();
  });

  it('denies with 403 when at cap', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 3, plan: 'free' }, error: null });
    countMock.mockResolvedValue({ count: 3, error: null });
    const { req, res, getStatus } = makeReqRes();
    const ok = await enforceMaxContactsCreate(req, res, 'ws-x');
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
  });

  it('returns 400 when workspace_id is missing', async () => {
    const { req, res, getStatus } = makeReqRes({});
    const ok = await enforceMaxContactsCreate(req, res, '');
    expect(ok).toBe(false);
    expect(getStatus()).toBe(400);
  });

  it('evaluates the authorized workspace, ignoring a spoofed body workspaceId', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 3, plan: 'free' }, error: null });
    countMock.mockResolvedValue({ count: 3, error: null });
    const { req, res, getStatus } = makeReqRes({ workspace_id: 'ws-x', workspaceId: 'ws-unlimited' });
    const ok = await enforceMaxContactsCreate(req, res, 'ws-x');
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
    expect(rpcMock.mock.calls[0][1]._workspace_id).toBe('ws-x');
  });
});

describe('contacts limit helper — bulk import (all-or-nothing)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    countMock.mockReset();
    clearEntitlementCache();
  });

  it('proceeds when batch fits', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 100, plan: 'pro' }, error: null });
    countMock.mockResolvedValue({ count: 50, error: null });
    const { req, res } = makeReqRes();
    const ok = await assertContactsBatchFits(req, res, 'ws-x', 25);
    expect(ok).toBe(true);
  });

  it('proceeds for unlimited (-1) plan regardless of count', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: -1, plan: 'enterprise' }, error: null });
    const { req, res } = makeReqRes();
    const ok = await assertContactsBatchFits(req, res, 'ws-x', 10_000);
    expect(ok).toBe(true);
  });

  it('rejects whole batch when post-insert count would exceed limit', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 100, plan: 'pro' }, error: null });
    countMock.mockResolvedValue({ count: 95, error: null });
    const { req, res, getStatus, getPayload } = makeReqRes();
    const ok = await assertContactsBatchFits(req, res, 'ws-x', 10);
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
    const p = getPayload();
    expect(p.error).toBe('limit_exceeded');
    expect(p.inserted).toBe(0);
    expect(p.requested).toBe(10);
    expect(p.used).toBe(95);
    expect(p.limit).toBe(100);
  });

  it('denies when the plan says no', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: 'free' }, error: null });
    const { req, res, getStatus } = makeReqRes();
    const ok = await assertContactsBatchFits(req, res, 'ws-x', 1);
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
    expect(countMock).not.toHaveBeenCalled();
  });

  it('a plan that never mentions max_contacts gets the registry default (100), as the app shows', async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: 'legacy', reason: 'feature_not_in_plan' }, error: null });
    countMock.mockResolvedValue({ count: 99, error: null });
    const fits = makeReqRes();
    expect(await assertContactsBatchFits(fits.req, fits.res, 'ws-x', 1)).toBe(true);
    const over = makeReqRes();
    expect(await assertContactsBatchFits(over.req, over.res, 'ws-x', 2)).toBe(false);
    expect(over.getPayload()).toMatchObject({ error: 'limit_exceeded', limit: 100, used: 99 });
  });

  it('returns true immediately for zero-size batch', async () => {
    const { req, res } = makeReqRes();
    const ok = await assertContactsBatchFits(req, res, 'ws-x', 0);
    expect(ok).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});