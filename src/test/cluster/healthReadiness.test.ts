// @vitest-environment node
/**
 * /api/health in cluster mode (server/routes/health.ts): a worker answers 503
 * `starting` until the primary says every worker listens, then 200 for its
 * whole life; a worker respawned after the container was ready starts ready.
 * The single process answers exactly as before, and has no /cluster route;
 * /database names the worker that answered in cluster mode only.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function appWith(as: 'single' | 'lead' | 'follower', env: Record<string, string> = {}) {
  vi.resetModules();
  vi.doMock('../../../server/cluster/role.js', async (orig) => {
    const real = await orig<typeof import('../../../server/cluster/role.js')>();
    const inputs = () => ({ isWorker: as !== 'single', env: { BACKEND_CLUSTER_ROLE: as, ...env }, hasChannel: true });
    return {
      ...real,
      clusterRole: () => real.clusterRole(inputs()),
      clusterWorkerReady: () => real.clusterWorkerReady(inputs()),
      clusterWorkerIndex: () => real.clusterWorkerIndex(inputs()),
      usesClusterHub: () => real.usesClusterHub(inputs()),
    };
  });
  const role = await import('../../../server/cluster/role.js');
  const { healthRouter } = await import('../../../server/routes/health.js');
  const app = express();
  app.use('/api/health', healthRouter);
  return { app, role };
}

afterEach(() => {
  vi.doUnmock('../../../server/cluster/role.js');
  vi.resetModules();
});

describe('/api/health', () => {
  it('the single process answers 200 ok, as before, and has no /cluster', async () => {
    const { app } = await appWith('single');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['status', 'timestamp']);
    expect(res.body.status).toBe('ok');
    expect((await request(app).get('/api/health/cluster')).status).toBe(404);
    const db = await request(app).get('/api/health/database');
    expect(db.body).not.toHaveProperty('worker');
  });

  it('/database names the worker that answered in cluster mode (its index, no pid)', async () => {
    const { app } = await appWith('follower', { BACKEND_CLUSTER_INDEX: '1', BACKEND_CLUSTER_READY: '1' });
    const db = await request(app).get('/api/health/database');
    expect(db.body.worker).toBe(1);
    expect(JSON.stringify(db.body)).not.toContain(String(process.pid));
  });

  it('a cluster worker answers 503 starting until every worker listens, then 200', async () => {
    const { app, role } = await appWith('follower');
    const before = await request(app).get('/api/health');
    expect(before.status).toBe(503);
    expect(before.body.status).toBe('starting');
    role.markClusterReady();
    const after = await request(app).get('/api/health');
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('ok');
  });

  it('a worker respawned after the container was ready starts ready', async () => {
    const { app } = await appWith('lead', { BACKEND_CLUSTER_READY: '1' });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('/cluster exists in cluster mode (503 while the primary does not answer)', async () => {
    const { app } = await appWith('lead', { BACKEND_CLUSTER_READY: '1' });
    const { __setHubTransportForTests } = await import('../../../server/cluster/client.js');
    __setHubTransportForTests({
      onMessage: (h) => { deliver = h; },
      send: (m) => {
        const { id } = m as { id: number };
        deliver({ kcb: 1, re: id, ok: true, result: { processes: 2, alive: 2, listening: 2, ready: true, restarts: 1 } });
      },
    });
    let deliver: (m: unknown) => void = () => undefined;
    const res = await request(app).get('/api/health/cluster');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', processes: 2, alive: 2, listening: 2, ready: true, restarts: 1 });
    __setHubTransportForTests(null);
  });
});
