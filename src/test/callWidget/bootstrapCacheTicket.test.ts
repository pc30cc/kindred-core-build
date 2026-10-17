/**
 * The call widget bootstrap's two shortcuts: the per-process memo of its
 * workspace-level part (server/services/callCenter/bootstrapCache.ts) and the
 * signed presence ticket that lets a visitor's next page views skip the
 * visitor queries (server/services/callCenter/presenceTicket.ts).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { ServerConfig } from '../../../server/config.js';
import { db, fakeClient } from './fakeDb';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));

const { memoCallWidgetBootstrap, invalidateCallWidgetBootstrapCache } = await import('../../../server/services/callCenter/bootstrapCache.js');
const { readPresenceTicket, issuePresenceTicket } = await import('../../../server/services/callCenter/presenceTicket.js');
const { updateWorkspaceSettings, invalidatePlatformCallCenterCache } = await import('../../../server/services/callCenter/settings.js');
afterEach(() => { vi.useRealTimers(); invalidateCallWidgetBootstrapCache(); });
const config = { supabaseServiceRoleKey: 'K', supabaseUrl: 'u' } as unknown as ServerConfig;

type Loaded = { ws: { workspace_id: string } | null };
const wsOf = (v: Loaded) => v.ws?.workspace_id ?? null;
const none = () => null;

describe('bootstrap memo', () => {
  it('shares one load, and a settings save drops the workspace under every key it was looked up by', async () => {
    let loads = 0;
    const load = async (): Promise<Loaded> => { loads++; await new Promise((r) => setTimeout(r, 5)); return { ws: { workspace_id: 'W' } }; };
    await Promise.all([1, 2, 3].map(() => memoCallWidgetBootstrap('ws:w', load, wsOf)));
    expect(loads).toBe(1);
    await memoCallWidgetBootstrap('pk:cck_1', load, wsOf);
    expect(loads).toBe(2);
    db.call_center_settings = [{ workspace_id: 'W', enabled: true }];
    await updateWorkspaceSettings(config, 'W', { display_name: 'x' });
    await memoCallWidgetBootstrap('ws:w', load, wsOf);
    await memoCallWidgetBootstrap('pk:cck_1', load, wsOf);
    expect(loads).toBe(4);
  });
  it('does not keep a failed load', async () => {
    let n = 0;
    await expect(memoCallWidgetBootstrap('ws:f', async (): Promise<Loaded> => { n++; throw new Error('db down'); }, none)).rejects.toThrow();
    await expect(memoCallWidgetBootstrap('ws:f', async (): Promise<Loaded> => { n++; return { ws: null }; }, none)).resolves.toBeTruthy();
    expect(n).toBe(2);
  });
  it('keeps a value 30 s and "not found" (null) only 10 s', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(t0);
    let hits = 0; let misses = 0;
    const found = async (): Promise<Loaded> => { hits++; return { ws: { workspace_id: 'T' } }; };
    const missing = async (): Promise<Loaded | null> => { misses++; return null; };
    await memoCallWidgetBootstrap('ws:t', found, wsOf);
    await memoCallWidgetBootstrap('pk:cck_none', missing, none);
    vi.setSystemTime(t0 + 9_000);
    await memoCallWidgetBootstrap('ws:t', found, wsOf);
    await memoCallWidgetBootstrap('pk:cck_none', missing, none);
    expect([hits, misses]).toEqual([1, 1]);
    vi.setSystemTime(t0 + 11_000);
    await memoCallWidgetBootstrap('ws:t', found, wsOf);
    await memoCallWidgetBootstrap('pk:cck_none', missing, none);
    expect([hits, misses]).toEqual([1, 2]);
    vi.setSystemTime(t0 + 31_000);
    await memoCallWidgetBootstrap('ws:t', found, wsOf);
    expect(hits).toBe(2);
  });
  it('a platform call-center settings change drops every workspace', async () => {
    let loads = 0;
    const load = async (): Promise<Loaded> => { loads++; return { ws: { workspace_id: 'p' } }; };
    await memoCallWidgetBootstrap('ws:p', load, wsOf);
    await memoCallWidgetBootstrap('pk:cck_p', load, wsOf);
    invalidatePlatformCallCenterCache();
    await memoCallWidgetBootstrap('ws:p', load, wsOf);
    await memoCallWidgetBootstrap('pk:cck_p', load, wsOf);
    expect(loads).toBe(4);
  });
  it('a load that an invalidation overtook is answered but not kept (it may hold the old row)', async () => {
    let loads = 0;
    let release: () => void = () => {};
    const slow = async (): Promise<Loaded> => { loads++; await new Promise<void>((r) => { release = r; }); return { ws: { workspace_id: 's' } }; };
    const first = memoCallWidgetBootstrap('ws:s', slow, wsOf);
    invalidateCallWidgetBootstrapCache('s');
    release();
    await expect(first).resolves.toEqual({ ws: { workspace_id: 's' } });
    const second = memoCallWidgetBootstrap('ws:s', slow, wsOf);
    release();
    await second;
    expect(loads).toBe(2);
  });
  it("one workspace's change does not disown another workspace's running load", async () => {
    let loads = 0;
    let release: () => void = () => {};
    const slow = async (): Promise<Loaded> => { loads++; await new Promise<void>((r) => { release = r; }); return { ws: { workspace_id: 'b' } }; };
    const first = memoCallWidgetBootstrap('ws:b', slow, wsOf);
    invalidateCallWidgetBootstrapCache('a');
    release();
    await first;
    await memoCallWidgetBootstrap('ws:b', slow, wsOf);
    expect(loads).toBe(1);
  });

  it('follows the cache bus: widget:<ws> and platform drop entries, a resync keeps them (30 s bounds it)', async () => {
    const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');
    const load = vi.fn(async (): Promise<Loaded> => ({ ws: { workspace_id: 'c' } }));
    await memoCallWidgetBootstrap('ws:c', load, wsOf);
    invalidateLocal(['all'], { resync: true });
    await memoCallWidgetBootstrap('ws:c', load, wsOf);
    expect(load).toHaveBeenCalledTimes(1);
    invalidateLocal(['widget:C']); // any spelling of the id
    await memoCallWidgetBootstrap('ws:c', load, wsOf);
    expect(load).toHaveBeenCalledTimes(2);
    invalidateLocal(['platform']);
    await memoCallWidgetBootstrap('ws:c', load, wsOf);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('holds at most 5000 workspaces, dropping the oldest first', async () => {
    let loads = 0;
    const load = (id: string) => async (): Promise<Loaded> => { loads++; return { ws: { workspace_id: id } }; };
    for (let i = 0; i <= 5000; i++) await memoCallWidgetBootstrap(`ws:l${i}`, load(`l${i}`), wsOf);
    expect(loads).toBe(5001);
    await memoCallWidgetBootstrap('ws:l5000', load('l5000'), wsOf); // newest: kept
    expect(loads).toBe(5001);
    await memoCallWidgetBootstrap('ws:l0', load('l0'), wsOf); // oldest: evicted
    expect(loads).toBe(5002);
  });
  it('keys that name no workspace live in their own 1000-entry map: made-up ids never evict a real one', async () => {
    let real = 0;
    let made = 0;
    const realLoad = async (): Promise<Loaded> => { real++; return { ws: { workspace_id: 'r' } }; };
    await memoCallWidgetBootstrap('ws:r', realLoad, wsOf);
    for (let i = 0; i < 6000; i++) {
      await memoCallWidgetBootstrap(`pk:made_up_${i}`, async (): Promise<Loaded | null> => { made++; return null; }, none);
    }
    await memoCallWidgetBootstrap('ws:r', realLoad, wsOf);
    expect(real).toBe(1);
    expect(made).toBe(6000);
    // The newest made-up key is still remembered; the oldest is not.
    await memoCallWidgetBootstrap('pk:made_up_5999', async (): Promise<Loaded | null> => { made++; return null; }, none);
    expect(made).toBe(6000);
    await memoCallWidgetBootstrap('pk:made_up_0', async (): Promise<Loaded | null> => { made++; return null; }, none);
    expect(made).toBe(6001);
    // "No call center row" for an id (ws: null) is a negative too.
    let noRow = 0;
    for (let i = 0; i < 1500; i++) await memoCallWidgetBootstrap(`ws:none${i}`, async (): Promise<Loaded> => { noRow++; return { ws: null }; }, wsOf);
    await memoCallWidgetBootstrap('ws:r', realLoad, wsOf);
    expect(real).toBe(1);
  });
});

describe('presence ticket', () => {
  const asReq = (r: object) => r as unknown as Request;
  function issue(t: { w: string; v: string; s: string; h: string; c: string | null }, cfg = config, reqHeaders: Record<string, string> = {}) {
    const headers: string[] = [];
    const res = { append: (_: string, v: string) => { headers.push(v); } } as unknown as Response;
    issuePresenceTicket(res, asReq({ headers: reqHeaders }), cfg, t);
    const value = headers[0].split(';')[0].split('=').slice(1).join('=');
    return { cookie: headers[0], req: asReq({ cookies: { dvccp: value } }), value };
  }
  const base = { w: 'W', v: 'V', s: 'S', h: 'H', c: null };
  const expected = { workspaceId: 'W', visitorId: 'V', ipHash: 'H' };

  it('holds only for the same workspace, visitor and network, under 60 s', () => {
    const { req, cookie } = issue(base);
    expect(cookie).toMatch(/^dvccp=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/api\/call-widget\/bootstrap; HttpOnly; Max-Age=60; /);
    expect(readPresenceTicket(req, config, expected)).toMatchObject({ w: 'W', v: 'V', s: 'S', h: 'H', c: null });
    expect(readPresenceTicket(req, config, { ...expected, ipHash: 'OTHER' })).toBeNull();
    expect(readPresenceTicket(req, config, { ...expected, visitorId: 'V2' })).toBeNull();
    expect(readPresenceTicket(req, config, { ...expected, workspaceId: 'W2' })).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61_000);
    expect(readPresenceTicket(req, config, expected)).toBeNull();
  });
  it('is SameSite=None; Secure; Partitioned on a secure request, like the other widget cookies', () => {
    const { cookie } = issue(base, config, { 'x-forwarded-proto': 'https' });
    expect(cookie).toMatch(/; SameSite=None; Secure; Partitioned$/);
  });
  it('rejects a forged, edited, foreign, future-dated or oversized ticket', () => {
    const { value } = issue(base);
    const [body, sig] = value.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    const reencode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(readPresenceTicket(asReq({ cookies: { dvccp: `${reencode({ ...decoded, c: 'someone-else' })}.${sig}` } }), config, expected)).toBeNull();
    expect(readPresenceTicket(asReq({ cookies: { dvccp: 'x.y' } }), config, expected)).toBeNull();
    expect(readPresenceTicket(asReq({ cookies: { dvccp: 'no-dot' } }), config, expected)).toBeNull();
    expect(readPresenceTicket(asReq({ cookies: {} }), config, expected)).toBeNull();
    // Signed with another deployment's secret.
    const other = issue(base, { supabaseServiceRoleKey: 'OTHER', supabaseUrl: 'u' } as unknown as ServerConfig);
    expect(readPresenceTicket(other.req, config, expected)).toBeNull();
    // Dated in the future.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120_000);
    const future = issue(base);
    vi.useRealTimers();
    expect(readPresenceTicket(future.req, config, expected)).toBeNull();
    expect(readPresenceTicket(asReq({ cookies: { dvccp: `${'a'.repeat(1100)}.${sig}` } }), config, expected)).toBeNull();
  });
});
