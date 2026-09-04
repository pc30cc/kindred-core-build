/**
 * The Prometheus/OpenTelemetry readiness stub (GET /metrics) is deliberately
 * mounted OUTSIDE adminRouter's requireAdmin gate (scrapers don't carry the
 * admin session cookie) — it must enforce its own access control instead:
 * off by default (404, indistinguishable from a nonexistent route), and
 * token-gated even when explicitly enabled. Its output must never contain a
 * high-cardinality identifier (workspace_id, conversation_id, call_id, or
 * any other UUID) as a label — see collector/prometheusExport.ts.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { metricsExportRouter } from '../../../server/routes/metricsExport.js';
import { getMonitoringCollector, __resetMonitoringCollectorForTests } from '../../../server/services/observability/collector/index.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const app = express();
app.use('/metrics', metricsExportRouter);
const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function get(headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path: '/metrics', method: 'GET', headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ORIGINAL_ENABLED = process.env.OBSERVABILITY_PROMETHEUS_ENABLED;
const ORIGINAL_TOKEN = process.env.OBSERVABILITY_PROMETHEUS_TOKEN;

beforeEach(() => {
  __resetMonitoringCollectorForTests();
  delete process.env.OBSERVABILITY_PROMETHEUS_ENABLED;
  delete process.env.OBSERVABILITY_PROMETHEUS_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_ENABLED === undefined) delete process.env.OBSERVABILITY_PROMETHEUS_ENABLED;
  else process.env.OBSERVABILITY_PROMETHEUS_ENABLED = ORIGINAL_ENABLED;
  if (ORIGINAL_TOKEN === undefined) delete process.env.OBSERVABILITY_PROMETHEUS_TOKEN;
  else process.env.OBSERVABILITY_PROMETHEUS_TOKEN = ORIGINAL_TOKEN;
});

afterAll(() => server.close());

describe('GET /metrics — off by default', () => {
  it('returns 404 when OBSERVABILITY_PROMETHEUS_ENABLED is unset', async () => {
    const res = await get();
    expect(res.status).toBe(404);
  });

  it('returns 404 even with a bearer token, if the flag is unset', async () => {
    process.env.OBSERVABILITY_PROMETHEUS_TOKEN = 'secret';
    const res = await get({ authorization: 'Bearer secret' });
    expect(res.status).toBe(404);
  });
});

describe('GET /metrics — enabled and token-gated', () => {
  it('returns 503 if enabled but no token is configured (never falls open)', async () => {
    process.env.OBSERVABILITY_PROMETHEUS_ENABLED = '1';
    const res = await get();
    expect(res.status).toBe(503);
  });

  it('returns 401 with a missing or wrong token', async () => {
    process.env.OBSERVABILITY_PROMETHEUS_ENABLED = '1';
    process.env.OBSERVABILITY_PROMETHEUS_TOKEN = 'correct-token';
    const missing = await get();
    expect(missing.status).toBe(401);
    const wrong = await get({ authorization: 'Bearer wrong-token' });
    expect(wrong.status).toBe(401);
  });

  it('returns 200 with the correct bearer token and renders known metric families', async () => {
    process.env.OBSERVABILITY_PROMETHEUS_ENABLED = '1';
    process.env.OBSERVABILITY_PROMETHEUS_TOKEN = 'correct-token';
    getMonitoringCollector().recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo', workspaceId: 'ws-should-not-leak' });
    const res = await get({ authorization: 'Bearer correct-token' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('process_rss_bytes');
    expect(res.text).toContain('realtime_metric_total');
  });

  it('never exposes a UUID-shaped identifier (workspace_id/conversation_id/call_id) as a label', async () => {
    process.env.OBSERVABILITY_PROMETHEUS_ENABLED = '1';
    process.env.OBSERVABILITY_PROMETHEUS_TOKEN = 'correct-token';
    const collector = getMonitoringCollector();
    collector.recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo', workspaceId: '11111111-2222-3333-4444-555555555555' });
    collector.recordRequestSample({ routeGroup: 'widget.bootstrap', method: 'POST', statusCode: 200, durationMs: 50 });
    const res = await get({ authorization: 'Bearer correct-token' });
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(UUID_RE);
  });
});
