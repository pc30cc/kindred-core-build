// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { installExpressAsyncErrors } from './asyncErrors.js';
import { isParseableDate, isValidYmdDate } from './dateInput.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('installExpressAsyncErrors', () => {
  let server: Server;
  let base = '';
  const errorHandlerCalls: string[] = [];
  const afterNextHits: string[] = [];

  beforeAll(async () => {
    expect(installExpressAsyncErrors()).toBe(true);
    // Idempotent.
    expect(installExpressAsyncErrors()).toBe(true);

    const app = express();
    const router = express.Router();

    router.get('/reject', async () => {
      await sleep(1);
      throw new Error('secret db detail');
    });
    router.get('/reject-falsy', async () => {
      await sleep(1);
      return Promise.reject(undefined);
    });
    router.get('/sync-throw', () => {
      throw new Error('sync');
    });
    router.get('/ok', async (_req, res) => {
      await sleep(1);
      res.json({ ok: true });
    });
    router.get('/handled', async (_req, res) => {
      try {
        await Promise.reject(new Error('x'));
      } catch {
        res.status(418).json({ error: 'teapot' });
      }
    });
    // Sends, then rejects: must not be forwarded (response already complete).
    router.get('/send-then-reject', async (_req, res) => {
      res.json({ sent: true });
      await sleep(1);
      throw new Error('after send');
    });
    // Calls next(), then rejects: must not call next a second time.
    router.get(
      '/next-then-reject',
      async (_req, _res, next) => {
        next();
        await sleep(1);
        throw new Error('after next');
      },
      (_req, res) => {
        afterNextHits.push('hit');
        setTimeout(() => res.json({ second: true }), 20);
      },
    );
    // Middleware (router.use) rejecting.
    router.use('/mw', async (_req, _res, _next) => {
      await sleep(1);
      throw new Error('mw');
    });
    // Async error handler that itself rejects → next error handler.
    router.get('/bad-error-handler', async () => {
      throw new Error('first');
    });
    router.use('/bad-error-handler', async (_err: unknown, _req: express.Request, _res: express.Response, _next: express.NextFunction) => {
      await sleep(1);
      throw new Error('second');
    });

    app.use(router);
    app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      errorHandlerCalls.push(err.message);
      if (res.headersSent) return next(err);
      res.status(500).json({ error: 'Internal server error' });
    });

    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it('forwards a rejected async handler to the error middleware as a generic 500', async () => {
    const res = await fetch(`${base}/reject`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(errorHandlerCalls).toContain('secret db detail');
  });

  it('normalises a falsy rejection reason into an error', async () => {
    const res = await fetch(`${base}/reject-falsy`);
    expect(res.status).toBe(500);
  });

  it('keeps synchronous throw semantics', async () => {
    const res = await fetch(`${base}/sync-throw`);
    expect(res.status).toBe(500);
  });

  it('leaves successful and self-handled async handlers alone', async () => {
    const ok = await fetch(`${base}/ok`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const handled = await fetch(`${base}/handled`);
    expect(handled.status).toBe(418);
  });

  it('does not forward a rejection after the response was completed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = errorHandlerCalls.length;
    const res = await fetch(`${base}/send-then-reject`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    await sleep(20);
    expect(errorHandlerCalls.length).toBe(before);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never calls next twice when the handler already called next()', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = errorHandlerCalls.length;
    const res = await fetch(`${base}/next-then-reject`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ second: true });
    expect(afterNextHits).toEqual(['hit']);
    expect(errorHandlerCalls.length).toBe(before);
    spy.mockRestore();
  });

  it('covers rejecting middleware and rejecting error handlers', async () => {
    const mw = await fetch(`${base}/mw/anything`);
    expect(mw.status).toBe(500);
    const eh = await fetch(`${base}/bad-error-handler`);
    expect(eh.status).toBe(500);
    expect(errorHandlerCalls).toContain('second');
  });
});

describe('date input helpers', () => {
  it('accepts only real YYYY-MM-DD calendar dates', () => {
    expect(isValidYmdDate('2024-02-29')).toBe(true);
    expect(isValidYmdDate('2024-12-31')).toBe(true);
    expect(isValidYmdDate('2024-13-01')).toBe(false);
    expect(isValidYmdDate('2023-02-29')).toBe(false);
    expect(isValidYmdDate('2024-02-31')).toBe(false);
    expect(isValidYmdDate('2024-00-10')).toBe(false);
    expect(isValidYmdDate('2024-1-01')).toBe(false);
    expect(isValidYmdDate(['2024-01-01'])).toBe(false);
  });

  it('accepts only strings new Date(x).toISOString() can handle', () => {
    expect(isParseableDate('2024-01-01T00:00:00Z')).toBe(true);
    expect(isParseableDate('2024-01-01')).toBe(true);
    expect(isParseableDate('not-a-date')).toBe(false);
    expect(isParseableDate('2024-13-01')).toBe(false);
    expect(isParseableDate('')).toBe(false);
  });
});
