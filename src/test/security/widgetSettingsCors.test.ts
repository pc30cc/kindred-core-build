import { describe, expect, it } from 'vitest';
import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { isPublicWidgetApiPath } from '../../../server/lib/routePrefix.js';

function corsProbeApp(status: 401 | 403 | 500 = 401) {
  const app = express();
  const appCors = cors({ origin: ['https://app.destekly.tr'], credentials: true });
  app.use((req, res, next) =>
    isPublicWidgetApiPath(req.path) ? next() : appCors(req, res, next),
  );
  app.get('/api/widget-settings/platform/config', (_req, res) => {
    res.status(status).json({ error: 'probe' });
  });
  return app;
}

describe('widget-settings app CORS behavior', () => {
  it('answers an allowed-origin preflight with credentials', async () => {
    const response = await request(corsProbeApp())
      .options('/api/widget-settings/platform/config')
      .set('Origin', 'https://app.destekly.tr')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.destekly.tr');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it.each([401, 403, 500] as const)('retains CORS headers on HTTP %s', async (status) => {
    const response = await request(corsProbeApp(status))
      .get('/api/widget-settings/platform/config')
      .set('Origin', 'https://app.destekly.tr');

    expect(response.status).toBe(status);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.destekly.tr');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});