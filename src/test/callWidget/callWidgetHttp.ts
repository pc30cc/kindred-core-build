/**
 * A tiny HTTP client for the server tests of the call widget (S11): mounts a
 * router on a real express app (port 0) and sends requests with a cookie jar,
 * as a browser on the customer's site would (its Origin, the dvsid cookie).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import cookieParser from 'cookie-parser';

export type HttpResult<T = Record<string, unknown>> = { status: number; body: T; text: string };

export interface TestServer {
  get<T = Record<string, unknown>>(path: string, headers?: Record<string, string>): Promise<HttpResult<T>>;
  post<T = Record<string, unknown>>(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResult<T>>;
  put<T = Record<string, unknown>>(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResult<T>>;
  /** Forget every cookie (a new browser). */
  clearCookies(): void;
  close(): void;
}

export function startTestServer(
  mount: string,
  router: Router,
  serverConfig: Record<string, unknown>,
  opts: { origin?: string; authUserId?: string } = {},
): TestServer {
  const app = express();
  app.use((req, _res, next) => {
    const r = req as unknown as { serverConfig: object; authUser?: { id: string } };
    r.serverConfig = serverConfig;
    if (opts.authUserId) r.authUser = { id: opts.authUserId };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use(mount, router);
  const server = http.createServer(app).listen(0);
  let jar: Record<string, string> = {};

  function send<T>(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const h: Record<string, string> = { ...(opts.origin ? { origin: opts.origin } : {}), ...headers };
      if (cookie) h.cookie = cookie;
      if (payload !== undefined) {
        h['content-type'] = 'application/json';
        h['content-length'] = String(Buffer.byteLength(payload));
      }
      const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          for (const sc of ([] as string[]).concat(res.headers['set-cookie'] || [])) {
            const [kv, ...attrs] = sc.split(';');
            const i = kv.indexOf('=');
            const k = kv.slice(0, i).trim();
            const v = kv.slice(i + 1);
            if (/max-age=0/i.test(attrs.join(';')) || v === '') delete jar[k]; else jar[k] = v;
          }
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          resolve({ status: res.statusCode || 0, body: parsed as T, text });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return {
    get: (path, headers) => send('GET', path, undefined, headers),
    post: (path, body, headers) => send('POST', path, body, headers),
    put: (path, body, headers) => send('PUT', path, body, headers),
    clearCookies: () => { jar = {}; },
    close: () => { server.close(); },
  };
}
