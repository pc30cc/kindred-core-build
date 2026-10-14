// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { BridgeStore, type LeasedContact } from '../../../worker/widget-bridge/store.js';
import { sendNext, syncReplies } from '../../../worker/widget-bridge/index.js';
import type { BridgeAdapter } from '../../../worker/widget-bridge/adapters.js';
import type { Queryable } from '../../../server/db/postgrest/types.js';

const gate = vi.hoisted(() => ({ admin: true, owner: '', workspace: '', pool: null as unknown as Queryable }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requirePlatformAdmin: async (_req: unknown, res: express.Response) => {
    if (!gate.admin) { res.status(403).json({ error: 'Not authorized' }); return null; }
    return gate.owner;
  },
}));
vi.mock('../../../server/db/index.js', () => ({ directPool: () => ({
  query: async (_sql: string, values: unknown[]) => ({ rows: values[0] === gate.workspace && values[1] === gate.owner ? [{ id: gate.workspace }] : [], rowCount: 0 }),
}) }));
vi.mock('../../../server/services/widgetBridge/config.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../server/services/widgetBridge/config.js')>();
  return { ...original, bridgePool: () => gate.pool };
});
vi.mock('../../../shared/net/hostGuard.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../shared/net/hostGuard.js')>();
  return { ...original, checkOutboundUrl: async () => ({ ok: true }) };
});
import { adminWidgetBridgeRouter } from '../../../server/routes/adminWidgetBridge.js';

const owner = '00000000-0000-4000-8000-000000000001';
const workspace = '00000000-0000-4000-8000-000000000002';
const worker = '00000000-0000-4000-8000-000000000003';
const identity = { name: 'Super Admin', email: 'admin@example.com', phone: '+905551234567' };
let db: PGlite;
const app = express(); app.use(express.json()); app.use('/bridge', adminWidgetBridgeRouter);
const api = (path: string) => `/bridge${path}${path.includes('?') ? '&' : '?'}workspaceId=${gate.workspace}`;
const adapter = (): BridgeAdapter => ({ prepare: vi.fn(async () => {}), send: vi.fn(async () => true), receive: vi.fn(async () => []) });
const store = () => new BridgeStore(gate.pool, process.env.WIDGET_BRIDGE_APP_ID || 'webyar', worker);

async function connected(): Promise<LeasedContact> {
  await request(app).put(api('/settings')).send({ enabled: true, identity }).expect(200);
  await request(app).post(api('/contacts')).send({ url: 'https://example.com', enabled: true }).expect(201);
  return (await store().claim())!;
}
function queue(contact: LeasedContact, body = 'Hello', id = randomUUID()) {
  return request(app).post(api(`/contacts/${contact.id}/messages`)).send({ body, clientMessageId: id });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(new URL('../../../deploy/widget-bridge/schema.sql', import.meta.url), 'utf8'));
  gate.pool = { query: async <R>(sql: string, values?: unknown[]) => {
    const result = await db.query<R>(sql, values); return { rows: result.rows, rowCount: result.affectedRows || 0 };
  } };
}, 30000);
afterAll(async () => { await db?.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await db.exec('TRUNCATE widget_bridge_settings CASCADE');
  gate.admin = true; gate.owner = owner; gate.workspace = workspace;
  vi.stubEnv('WIDGET_BRIDGE_ENABLED', '1'); vi.stubEnv('WIDGET_BRIDGE_APP_ID', 'webyar');
  vi.stubEnv('WIDGET_BRIDGE_DATABASE_URL', 'postgresql://bridge@bridge-db/widget_bridge');
  vi.stubEnv('WIDGET_BRIDGE_ENCRYPTION_KEY', 'e'.repeat(64)); vi.stubEnv('DATABASE_URL', 'postgresql://main@main-db/webyar');
});

describe('standalone bridge database and API', () => {
  it('creates only isolated bridge tables, no main-app records', async () => {
    const { rows } = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    expect(rows.map(row => row.tablename)).toEqual(['widget_bridge_batches','widget_bridge_contacts','widget_bridge_messages','widget_bridge_settings']);
  });
  it('rejects ordinary users before touching the bridge database', async () => {
    gate.admin = false;
    await request(app).get(api('/contacts')).expect(403);
    expect((await db.query('SELECT * FROM widget_bridge_settings')).rows).toHaveLength(0);
  });
  it('rejects a customer workspace even for a platform admin', async () => {
    await request(app).get(`/bridge/contacts?workspaceId=${randomUUID()}`).expect(403);
  });
  it('fails closed if configured with the main app database', async () => {
    vi.stubEnv('WIDGET_BRIDGE_DATABASE_URL', 'postgresql://other:password@main-db:5432/webyar?sslmode=require');
    const response = await request(app).get(api('/settings')).expect(503);
    expect(response.body.error).toBe('bridge_database_must_be_separate');
  });
  it('starts disabled and requires saving default details before adding a site', async () => {
    const initial = await request(app).get(api('/settings')).expect(200);
    expect(initial.body.settings.enabled).toBe(false);
    await request(app).post(api('/contacts')).send({ url: 'https://example.com' }).expect(409);
  });
  it('stores the site name as the contact and never exposes encrypted sessions', async () => {
    const contact = await connected();
    expect(contact.name).toBe('example.com');
    await db.query('UPDATE widget_bridge_contacts SET session_envelope=$1 WHERE id=$2', [{ ciphertext: 'private-cookie' }, contact.id]);
    const response = await request(app).get(api('/contacts')).expect(200);
    expect(JSON.stringify(response.body)).not.toContain('private-cookie');
    expect(response.body.contacts[0]).not.toHaveProperty('session_envelope');
  });
  it('isolates app, owner and workspace in the same shared database', async () => {
    const contact = await connected();
    vi.stubEnv('WIDGET_BRIDGE_APP_ID', 'respok');
    expect((await request(app).get(api('/contacts')).expect(200)).body.contacts).toEqual([]);
    await request(app).patch(api(`/contacts/${contact.id}`)).send({ enabled: false }).expect(404);
    await request(app).post(api(`/contacts/${contact.id}/messages`)).send({ body: 'not mine', clientMessageId: randomUUID() }).expect(409);
    vi.stubEnv('WIDGET_BRIDGE_APP_ID', 'webyar'); gate.owner = randomUUID();
    expect((await request(app).get(api('/contacts')).expect(200)).body.contacts).toEqual([]);
    gate.owner = owner; gate.workspace = randomUUID();
    expect((await request(app).get(api('/contacts')).expect(200)).body.contacts).toEqual([]);
  });
  it('queues only once for a retried message and rejects reusing its id with different content', async () => {
    const contact = await connected(); const id = randomUUID();
    const first = await queue(contact, 'Hello', id).expect(202);
    const again = await queue(contact, 'Hello', id).expect(202);
    expect(again.body.message.id).toBe(first.body.message.id);
    await queue(contact, 'Changed', id).expect(409);
    expect((await db.query('SELECT * FROM widget_bridge_messages')).rows).toHaveLength(1);
  });
  it('allows only one worker to claim a site and never claims another app’s sites', async () => {
    await connected();
    expect(await new BridgeStore(gate.pool, 'webyar', randomUUID()).claim()).toBeNull();
    expect(await new BridgeStore(gate.pool, 'respok', randomUUID()).claim()).toBeNull();
  });
  it('keeps a live session open unless another enabled site is waiting for capacity', async () => {
    await connected();
    expect(await store().hasWaiting()).toBe(false);
    await request(app).post(api('/contacts')).send({ url: 'https://waiting.example.com', enabled: true }).expect(201);
    expect(await store().hasWaiting()).toBe(true);
    await new BridgeStore(gate.pool, 'webyar', randomUUID()).claim();
    expect(await store().hasWaiting()).toBe(false);
  });
  it('pauses unsupported/verification-blocked forms instead of repeatedly submitting default details', async () => {
    const contact = await connected(); await queue(contact).expect(202);
    await store().release(contact, 'composer_unavailable'); await store().reap();
    expect(await store().claim()).toBeNull();
    const response = await request(app).get(api('/contacts')).expect(200);
    expect(response.body.contacts[0].enabled).toBe(false);
    expect(response.body.contacts[0].last_error).toBe('composer_unavailable');
    await queue(contact).expect(409);
    await request(app).patch(api(`/contacts/${contact.id}`)).send({ enabled: true }).expect(200);
    expect((await store().claim())?.id).toBe(contact.id);
  });
  it('posts queued messages through the worker and receives replies without echoing or duplicates', async () => {
    const contact = await connected(); await queue(contact).expect(202);
    const remote = adapter(); const persist = vi.fn(async () => {});
    await sendNext(store(), contact, remote, persist);
    expect(remote.send).toHaveBeenCalledWith('Hello'); expect(persist).toHaveBeenCalledTimes(2);
    await store().receive(contact, [{ key: 'reply-1', body: 'Welcome' }]);
    await store().receive(contact, [{ key: 'reply-1', body: 'Welcome' }]);
    const response = await request(app).get(api(`/contacts/${contact.id}/messages`)).expect(200);
    expect(response.body.messages.map((m: { direction: string; delivery: string }) => [m.direction, m.delivery])).toEqual([
      ['outbound','sent'], ['inbound','received'],
    ]);
  });
  it('syncs a large rendered history across batches without silently losing replies beyond the first batch', async () => {
    const contact = await connected(); const remote = adapter();
    const replies = Array.from({ length: 305 }, (_, i) => ({ key: `history-${i}`, body: `History ${i}` }));
    remote.receive = async () => replies;
    const cache = new Map<string, string>();
    await syncReplies(store(), contact, remote, cache);
    await syncReplies(store(), contact, remote, cache);
    await syncReplies(store(), contact, remote, cache);
    const { rows } = await db.query<{ body: string }>('SELECT body FROM widget_bridge_messages ORDER BY created_at,id');
    expect(rows.map(row => row.body)).toEqual(replies.map(reply => reply.body));
  });
  it('does not dispatch if saving session continuity fails', async () => {
    const contact = await connected(); await queue(contact).expect(202); const remote = adapter();
    await sendNext(store(), contact, remote, async () => { throw new Error('database down'); });
    expect(remote.send).not.toHaveBeenCalled();
    expect((await db.query<{ delivery: string }>('SELECT delivery FROM widget_bridge_messages')).rows[0].delivery).toBe('failed');
  });
  it('does not repeat a send after an ambiguous browser failure', async () => {
    const contact = await connected(); await queue(contact).expect(202); const remote = adapter();
    remote.send = vi.fn(async () => { throw new Error('browser disconnected after click'); });
    await sendNext(store(), contact, remote, async () => {});
    await sendNext(store(), contact, remote, async () => {});
    expect(remote.send).toHaveBeenCalledTimes(1);
    expect((await db.query<{ delivery: string }>('SELECT delivery FROM widget_bridge_messages')).rows[0].delivery).toBe('uncertain');
  });
  it('recovers pre-dispatch work but never automatically retries dispatching work', async () => {
    const contact = await connected(); await queue(contact, 'Prepared').expect(202); await queue(contact, 'Dispatched').expect(202);
    await db.query("UPDATE widget_bridge_messages SET delivery=CASE WHEN body='Prepared' THEN 'preparing' ELSE 'dispatching' END");
    await store().recover(contact);
    const { rows } = await db.query<{ body: string; delivery: string }>('SELECT body,delivery FROM widget_bridge_messages ORDER BY body');
    expect(rows).toEqual([{ body: 'Dispatched', delivery: 'uncertain' }, { body: 'Prepared', delivery: 'queued' }]);
  });
  it('disable during form preparation fences the send and keeps history', async () => {
    const contact = await connected(); await queue(contact).expect(202); const remote = adapter();
    remote.prepare = vi.fn(async () => { await request(app).put(api('/settings')).send({ enabled: false, identity }).expect(200); });
    await sendNext(store(), contact, remote, async () => {});
    expect(remote.send).not.toHaveBeenCalled(); expect(await store().alive(contact)).toBe(false);
    expect((await db.query<{ delivery: string }>('SELECT delivery FROM widget_bridge_messages')).rows[0].delivery).toBe('cancelled');
    await queue(contact).expect(409);
  });
  it('deletes only after a live browser lease is released, then cascades bridge messages', async () => {
    const contact = await connected(); await queue(contact).expect(202);
    await request(app).delete(api(`/contacts/${contact.id}`)).expect(202);
    expect((await db.query('SELECT * FROM widget_bridge_contacts')).rows).toHaveLength(1);
    expect(await store().alive(contact)).toBe(false);
    await store().release(contact, null); await store().reap();
    expect((await db.query('SELECT * FROM widget_bridge_contacts')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM widget_bridge_messages')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM widget_bridge_settings')).rows).toHaveLength(1);
  });
  it('purges one app’s bridge data while leaving the other app’s inbox intact', async () => {
    const contact = await connected();
    vi.stubEnv('WIDGET_BRIDGE_APP_ID', 'respok'); await connected();
    vi.stubEnv('WIDGET_BRIDGE_APP_ID', 'webyar');
    await request(app).delete(api('/settings')).expect(202); await store().release(contact, null); await store().reap();
    expect((await request(app).get(api('/contacts')).expect(200)).body.contacts).toEqual([]);
    vi.stubEnv('WIDGET_BRIDGE_APP_ID', 'respok');
    expect((await request(app).get(api('/contacts')).expect(200)).body.contacts).toHaveLength(1);
  });
  it('cannot add a new contact while a workspace purge is closing its sessions', async () => {
    const contact = await connected();
    await request(app).delete(api('/settings')).expect(202);
    await request(app).post(api('/contacts')).send({ url: 'https://another.example.com', enabled: true }).expect(409);
    await store().release(contact, null); await store().reap();
    expect((await db.query('SELECT * FROM widget_bridge_settings')).rows).toHaveLength(0);
  });
  it('reads thread history with a scoped keyset cursor', async () => {
    const contact = await connected();
    await store().receive(contact, Array.from({ length: 105 }, (_, i) => ({ key: `reply-${i}`, body: `Reply ${i}` })));
    const latest = await request(app).get(api(`/contacts/${contact.id}/messages`)).expect(200);
    expect(latest.body.messages).toHaveLength(100); expect(latest.body.hasMore).toBe(true);
    const earlier = await request(app).get(api(`/contacts/${contact.id}/messages?before=${latest.body.messages[0].id}`)).expect(200);
    expect(earlier.body.messages).toHaveLength(5);
    expect(new Set([...earlier.body.messages,...latest.body.messages].map(m => m.id)).size).toBe(105);
    expect([...earlier.body.messages,...latest.body.messages].map(m => m.body)).toEqual(
      Array.from({ length: 105 }, (_, i) => `Reply ${i}`),
    );
  });
});


describe('ordered site batches', () => {
  function batch(urls = ['https://first.example.com', 'https://second.example.com'], clientBatchId = randomUUID()) {
    return request(app).post(api('/batches')).send({ urls, body: 'Batch hello', clientBatchId });
  }
  it('deduplicates sites, preserves order across workers, and resumes after restart', async () => {
    await request(app).put(api('/settings')).send({ roundSize:2, intervalSeconds:5, enabled: true, identity, allowedProviders: ['goftino'] }).expect(200);
    const id = randomUUID();
    const urls = ['https://first.example.com', 'https://first.example.com/#duplicate', 'https://second.example.com'];
    await batch(urls,id).expect(202); await batch(urls,id).expect(202);
    await batch(['https://third.example.com']).expect(409);
    const first = (await store().claim())!; expect(first.name).toBe('first.example.com');
    expect(first.allowed_providers).toEqual(['goftino']);
    expect(await new BridgeStore(gate.pool,'webyar',randomUUID()).claim()).toBeNull();
    const message = (await store().next(first))!;
    await store().dispatch(first,message);
    expect(await new BridgeStore(gate.pool,'webyar',randomUUID()).claim()).toBeNull();
    await db.query("UPDATE widget_bridge_contacts SET lease_until=now()-interval '1 second' WHERE id=$1",[first.id]);
    const restarted = (await store().claim())!; await store().recover(restarted);
    expect(await new BridgeStore(gate.pool,'webyar',randomUUID()).claim()).toBeNull();
    await request(app).post(api(`/batches/${id}/continue`)).send({ reviewVersion:1 }).expect(200);
    await db.query("UPDATE widget_bridge_batches SET next_send_at=now()-interval '1 second' WHERE id=$1",[id]);
    const second = (await new BridgeStore(gate.pool,'webyar',randomUUID()).claim())!;
    expect(second.name).toBe('second.example.com');
    const progress = await request(app).get(api(`/batches/${id}`)).expect(200);
    expect(progress.body.items.map((x: { delivery: string }) => x.delivery)).toEqual(['uncertain','queued']);
    expect((await db.query('SELECT * FROM widget_bridge_messages')).rows).toHaveLength(2);
  });
  it('moves past a failed widget and cancels pending sends without touching normal contacts', async () => {
    await request(app).put(api('/settings')).send({ roundSize:2, intervalSeconds:5, enabled: true, identity }).expect(200);
    const id = randomUUID(); await batch(undefined,id).expect(202);
    const first = (await store().claim())!;
    await store().release(first,'provider_not_allowed');
    expect(await store().claim()).toBeNull();
    await request(app).post(api(`/batches/${id}/continue`)).send({ reviewVersion:1 }).expect(200);
    await db.query("UPDATE widget_bridge_batches SET next_send_at=now()-interval '1 second' WHERE id=$1",[id]);
    const second = (await store().claim())!; expect(second.name).toBe('second.example.com');
    const msg = (await store().next(second))!;
    await request(app).delete(api(`/batches/${id}`)).expect(200);
    expect(await store().dispatch(second,msg)).toBe(false);
    const items = (await request(app).get(api(`/batches/${id}`))).body.items;
    expect(items.map((x: { delivery: string }) => x.delivery)).toEqual(['failed','cancelled']);
    expect((await db.query('SELECT * FROM widget_bridge_contacts')).rows).toHaveLength(2);
  });
  it('skips disabled existing contacts, completes, and isolates purge by app', async () => {
    await request(app).put(api('/settings')).send({ roundSize:2, intervalSeconds:5, enabled: true, identity }).expect(200);
    await request(app).post(api('/contacts')).send({ url:'https://first.example.com',enabled:false }).expect(201);
    const id = randomUUID(); await batch(undefined,id).expect(202);
    const second = (await store().claim())!; const remote = adapter();
    await sendNext(store(),second,remote,async()=>{}); await store().release(second,null); await store().reap();
    const batches = (await request(app).get(api('/batches'))).body.batches;
    expect(batches[0]).toMatchObject({ status:'completed',sent:1,skipped:1,total:2 });
    vi.stubEnv('WIDGET_BRIDGE_APP_ID','respok');
    expect((await request(app).get(api('/batches'))).body.batches).toEqual([]);
    await request(app).delete(api('/settings')).expect(202);
    vi.stubEnv('WIDGET_BRIDGE_APP_ID','webyar');
    expect((await request(app).get(api('/batches'))).body.batches).toHaveLength(1);
    await request(app).delete(api('/settings')).expect(202);
    expect((await db.query('SELECT * FROM widget_bridge_batches')).rows).toHaveLength(0);
  });
  it('rejects unsafe lists and requires allowed providers; settings changes cancel batches', async () => {
    await request(app).put(api('/settings')).send({ enabled:true,identity,allowedProviders:[] }).expect(200);
    await batch().expect(409);
    await request(app).put(api('/settings')).send({ enabled:true,identity,allowedProviders:['crisp'] }).expect(200);
    await batch(['https://127.0.0.1']).expect(400);
    const id=randomUUID();await batch(undefined,id).expect(202);
    await request(app).put(api('/settings')).send({ enabled:true,identity,allowedProviders:['goftino'] }).expect(200);
    expect((await request(app).get(api('/batches'))).body.batches[0].status).toBe('cancelled');
    expect((await request(app).get(api(`/batches/${id}`))).body.items.every((x: {delivery:string})=>x.delivery==='cancelled')).toBe(true);
  });
});


describe('paced rounds and approval', () => {
  it('defaults to one site, enforces cooldown, and rejects stale approvals', async () => {
    await request(app).put(api('/settings')).send({ enabled:true,identity }).expect(200);
    const id=randomUUID();
    await request(app).post(api('/batches')).send({ clientBatchId:id,body:'One at a time',urls:['https://one.example.com','https://two.example.com','https://three.example.com'] }).expect(202);
    const first=(await store().claim())!;
    await sendNext(store(),first,adapter(),async()=>{});
    await store().reap();
    const progress=(await request(app).get(api('/batches'))).body.batches[0];
    expect(progress).toMatchObject({status:'paused',round_size:1,interval_seconds:30,approved_through:1,review_version:1,sent:1});
    expect(await store().claim()).toBeNull();
    await request(app).post(api(`/batches/${id}/continue`)).send({reviewVersion:1}).expect(200);
    await request(app).post(api(`/batches/${id}/continue`)).send({reviewVersion:1}).expect(409);
    expect(await store().claim()).toBeNull(); // approval cannot bypass cooldown
    await db.query("UPDATE widget_bridge_batches SET next_send_at=now()-interval '1 second' WHERE id=$1",[id]);
    const second=(await store().claim())!;expect(second.name).toBe('two.example.com');
    await sendNext(store(),second,adapter(),async()=>{});await store().reap();
    await request(app).post(api(`/batches/${id}/continue`)).send({reviewVersion:1}).expect(409);
    expect((await request(app).get(api('/batches'))).body.batches[0]).toMatchObject({status:'paused',review_version:2,sent:2});
    await request(app).delete(api(`/batches/${id}`)).expect(200);
    expect((await request(app).get(api(`/batches/${id}`))).body.items[2].delivery).toBe('cancelled');
  });
  it('allows configured rounds but stops immediately at an uncertain send', async () => {
    await request(app).put(api('/settings')).send({enabled:true,identity,roundSize:3,intervalSeconds:10}).expect(200);
    await request(app).post(api('/batches')).send({clientBatchId:randomUUID(),body:'Careful',urls:['https://one.example.com','https://two.example.com']}).expect(202);
    const first=(await store().claim())!; const remote=adapter();remote.send=async()=>false;
    await sendNext(store(),first,remote,async()=>{});
    expect((await request(app).get(api('/batches'))).body.batches[0]).toMatchObject({status:'paused',uncertain:1,pending:1});
    expect(await store().claim()).toBeNull();
    await request(app).put(api('/settings')).send({enabled:true,identity,roundSize:0,intervalSeconds:1}).expect(400);
  });
});

it('processes a configured round sequentially with a gap after each site, then waits for approval', async () => {
  await request(app).put(api('/settings')).send({enabled:true,identity,roundSize:3,intervalSeconds:60}).expect(200);
  const id=randomUUID();
  await request(app).post(api('/batches')).send({clientBatchId:id,body:'Slow round',urls:[1,2,3,4].map(n=>`https://site${n}.example.com`)}).expect(202);
  for (let n=1;n<=3;n++) {
    const contact=(await store().claim())!; expect(contact.name).toBe(`site${n}.example.com`);
    await sendNext(store(),contact,adapter(),async()=>{});
    expect(await store().claim()).toBeNull();
    await db.query("UPDATE widget_bridge_batches SET next_send_at=now()-interval '1 second' WHERE id=$1",[id]);
  }
  await store().reap();
  expect((await request(app).get(api('/batches'))).body.batches[0]).toMatchObject({status:'paused',sent:3,pending:1});
  expect(await store().claim()).toBeNull();
});
