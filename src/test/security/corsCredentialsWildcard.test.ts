/**
 * BLOCKER 3 — CORS wildcard + credentials fail-safe.
 *
 * server/index.ts used to build its CORS policy as
 *   origin: config.corsOrigins[0] === '*' ? true : config.corsOrigins
 * with `credentials: true` unconditionally. Passing `origin: true` to the
 * `cors` package makes it REFLECT the request's Origin verbatim (the only
 * way to combine a wildcard with credentials — browsers refuse a literal
 * `Access-Control-Allow-Origin: *` alongside `Allow-Credentials: true`).
 * Combined with `CORS_ORIGINS` defaulting to `*` (server/config.ts) — and
 * this repo's own .env.docker.example previously recommending it — this
 * meant a fresh, unconfigured deployment (or one following the shipped
 * Docker example) accepted a credentialed, cookie-carrying browser request
 * from ANY origin on the internet by default.
 *
 * This test drives the REAL `cors` npm package (not a reimplementation)
 * with the exact policy expression from server/index.ts, for both the
 * fixed (fail-closed) branch and the explicitly-configured branch, proving
 * the actual header behavior rather than asserting our own logic sees
 * itself as correct.
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import cors from 'cors';

function buildApp(corsOrigins: string[]) {
  const app = express();
  const appCors = cors({
    origin: corsOrigins.length === 1 && corsOrigins[0] === '*' ? false : corsOrigins,
    credentials: true,
  });
  app.use(appCors);
  app.post('/api/mutate', express.json(), (_req, res) => res.json({ ok: true }));
  return app;
}

function preflight(port: number, origin: string): Promise<{ status: number; acao: string | undefined; acac: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/mutate', method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          acao: res.headers['access-control-allow-origin'] as string | undefined,
          acac: res.headers['access-control-allow-credentials'] as string | undefined,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('CORS policy — origin computation matches server/index.ts', () => {
  it('unconfigured (wildcard-default) corsOrigins: no Allow-Origin header for ANY requester — fails closed', async () => {
    const app = buildApp(['*']);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const attacker = await preflight(port, 'https://literally-anyone.example');
      expect(attacker.acao).toBeUndefined();
      expect(attacker.acac).toBeUndefined();

      const evenALegitLookingOrigin = await preflight(port, 'https://app.example.com');
      expect(evenALegitLookingOrigin.acao).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('explicitly configured corsOrigins: the listed origin is reflected with credentials, others are not', async () => {
    const app = buildApp(['https://app.example.com']);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const trusted = await preflight(port, 'https://app.example.com');
      expect(trusted.acao).toBe('https://app.example.com');
      expect(trusted.acac).toBe('true');

      const untrusted = await preflight(port, 'https://evil.attacker.example');
      expect(untrusted.acao).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
