/**
 * Authenticated admin preview endpoint: CORS + authorization contract.
 *
 * Mirrors the mount from server/index.ts (global CORS gate + explicit
 * appCors on /api/widget-preview) and proves:
 *   - OPTIONS preflight with Authorization is allowed (was broken when the
 *     public-widget path check matched `/api/widget-preview` by prefix),
 *   - a valid Bearer JWT for a member returns 200 with the config document,
 *   - a non-member returns 403,
 *   - a missing token returns 401.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';

const MEMBER_TOKEN = 'member-jwt';
const OUTSIDER_TOKEN = 'outsider-jwt';
const WS = 'ws_1707dfa8';

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async (req: any, res: any, workspaceId: string) => {
    const auth = req.headers?.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization' });
      return null;
    }
    const token = auth.slice(7);
    if (token !== MEMBER_TOKEN && token !== OUTSIDER_TOKEN) {
      res.status(401).json({ error: 'Invalid token' });
      return null;
    }
    if (token === OUTSIDER_TOKEN || workspaceId !== WS) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return { userId: 'u1', isAdmin: false, role: 'admin' };
  },
}));

vi.mock('../../../server/routes/widget.js', () => ({
  widgetConfigHandler: async (req: any, res: any) => {
    res.json({
      workspaceId: (req as any)._widgetWorkspaceId,
      assetBase: 'https://assets.example.com',
      loaderUrl: 'https://assets.example.com/widget/loader.js?v=7b1e5375',
      runtimeUrl: 'https://assets.example.com/widget/runtime.1266296e.js?v=7b1e5375',
      styleUrl: 'https://assets.example.com/widget/runtime.faa4acad.css?v=7b1e5375',
      loaderVersion: '7b1e5375',
    });
  },
}));

async function buildApp() {
  const { widgetPreviewRouter } = await import('../../../server/routes/widgetPreview.js');
  const app = express();
  const appCors = cors({ origin: true, credentials: true });
  const isPublicWidgetPath = (p: string) => p === '/api/widget' || p.startsWith('/api/widget/');
  app.use((req, res, next) => (isPublicWidgetPath(req.path) ? next() : appCors(req, res, next)));
  app.options('/api/widget-preview/*', appCors);
  app.use('/api/widget-preview', appCors, widgetPreviewRouter);
  return app;
}

describe('GET /api/widget-preview/config', () => {
  let app: express.Express;
  beforeEach(async () => { app = await buildApp(); });

  it('answers the Authorization preflight with CORS headers', async () => {
    const res = await request(app)
      .options(`/api/widget-preview/config`)
      .set('Origin', 'https://admin.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');
    expect([200, 204]).toContain(res.status);
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(String(res.headers['access-control-allow-headers'] || '').toLowerCase())
      .toContain('authorization');
  });

  it('returns 200 and the config for a member with a valid Bearer JWT', async () => {
    const res = await request(app)
      .get(`/api/widget-preview/config?workspace_id=${WS}`)
      .set('Origin', 'https://admin.example.com')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(res.body.workspaceId).toBe(WS);
    // Loader must be advertised on the ASSET base, not the API origin.
    expect(res.body.loaderUrl).toMatch(/^https:\/\/assets\.example\.com\/widget\/loader\.js/);
    expect(res.body.runtimeUrl).toMatch(/runtime\.[a-f0-9]{8}\.js/);
    expect(res.body.styleUrl).toMatch(/runtime\.[a-f0-9]{8}\.css/);
  });

  it('returns 403 for an authenticated non-member', async () => {
    const res = await request(app)
      .get(`/api/widget-preview/config?workspace_id=${WS}`)
      .set('Authorization', `Bearer ${OUTSIDER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('returns 401 when the Bearer token is missing', async () => {
    const res = await request(app).get(`/api/widget-preview/config?workspace_id=${WS}`);
    expect(res.status).toBe(401);
  });
});
