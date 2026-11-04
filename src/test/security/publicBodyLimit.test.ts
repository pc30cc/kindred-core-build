// @vitest-environment node
/**
 * Audit widgetapi-1: the JSON body parser runs before the IP block, the abuse
 * check, every rate limiter and every auth check, so its limit is what any
 * anonymous client may make the backend parse. body-parser counts `limit` on
 * the INFLATED bytes, so a small gzip body used to become a 50 MB parse.
 *
 * - an oversized body on a public route is a 413 before any handler runs,
 *   with or without a Content-Length;
 * - a compressed body (a gzip bomb) is refused, without inflating it, on every
 *   route but the provider webhooks;
 * - real widget payloads (a 5,000-character message, an attachment upload)
 *   still pass;
 * - server/index.ts mounts the parser before ipBlock and the abuse check, and
 *   skips the raw-body webhook routes.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  jsonBodyParser,
  jsonBodyClassOf,
  PUBLIC_JSON_BODY_LIMIT,
  WIDGET_ATTACHMENT_UPLOAD_BODY_LIMIT,
  PANEL_JSON_BODY_LIMIT,
} from '../../../server/middleware/bodyParsers';

const handler = vi.fn((req: express.Request, res: express.Response) => {
  res.json({ ok: true, size: JSON.stringify(req.body ?? null).length });
});

function buildApp() {
  const app = express();
  app.use(jsonBodyParser());
  app.all('*', handler);
  // The same contract as server/index.ts's final error handler: a client
  // error keeps its status.
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number(err.status);
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'client' });
    return res.status(500).json({ error: 'server' });
  });
  return app;
}
const app = buildApp();

/** '64kb' / '35mb' as body-parser reads them (1024-based). */
const bytes = {
  parse(limit: string): number {
    const m = /^(\d+)(kb|mb)$/.exec(limit);
    if (!m) throw new Error(`unexpected limit ${limit}`);
    return Number(m[1]) * (m[2] === 'kb' ? 1024 : 1024 * 1024);
  },
};

/** A JSON array of zeros of about `size` bytes. */
function zeros(size: number): string {
  return `[${'0,'.repeat(Math.floor(size / 2) - 1)}0]`;
}

/**
 * POST exact bytes (supertest would JSON-encode a Buffer sent as
 * application/json). Without a Content-Length when `chunked`.
 */
async function rawPost(p: string, headers: Record<string, string>, body: Buffer | string, chunked = false): Promise<number> {
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<number>((resolve, reject) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const req = http.request({
        port, method: 'POST', path: p,
        headers: { ...headers, ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(buf.length) }) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      Readable.from([buf]).pipe(req);
    });
  } finally {
    server.close();
  }
}

describe('which limit a path gets', () => {
  it.each([
    ['/api/widget/message', 'public'],
    ['/API/Widget/Message/', 'public'],
    ['/api/widget/kb/search', 'public'],
    ['/api/widget/commerce/identity', 'public'],
    ['/api/visitors/track', 'public'],
    ['/api/call-widget/calls/request', 'public'],
    ['/api/realtime/visitor-presence', 'public'],
    ['/api/realtime/connect/', 'public'],
    ['/api/auth/login', 'public'],
    ['/api/auth-email/send', 'public'],
    ['/api/phone-verification/start', 'public'],
    ['/api/notifications/email/unsubscribe/tok', 'public'],
    ['/api/widget/attachments/0b6b3c8e-0000-4000-8000-000000000000/upload', 'widget-attachment-upload'],
    ['/API/widget/Attachments/abc/upload/', 'widget-attachment-upload'],
    ['/api/widget/attachments/init', 'public'],
    ['/webhooks/gmail/push', 'webhook'],
    ['/api/widget-settings/ws/fab-image', 'panel'],
    ['/api/visitor-intel/network/batch', 'panel'],
    ['/api/realtime/operator-presence', 'panel'],
    ['/api/conversation-attachments/upload', 'panel'],
    ['/api/authx', 'panel'],
  ])('%s → %s', (p, cls) => {
    expect(jsonBodyClassOf(p)).toBe(cls);
  });

  it('the attachment upload limit holds the widget\'s largest file (25 MB) as base64', () => {
    const maxFile = 25 * 1024 * 1024; // widgetAttachments.ts HARD_MAX_BYTES
    const body = Math.ceil(maxFile / 3) * 4 + '{"data":""}'.length;
    expect(bytes.parse(WIDGET_ATTACHMENT_UPLOAD_BODY_LIMIT)).toBeGreaterThanOrEqual(body);
    expect(bytes.parse(WIDGET_ATTACHMENT_UPLOAD_BODY_LIMIT)).toBeLessThan(bytes.parse(PANEL_JSON_BODY_LIMIT));
  });
});

describe('oversized and compressed bodies on public routes', () => {
  it('a body over 64 KB on POST /api/widget/message is a 413, and no handler runs', async () => {
    handler.mockClear();
    const res = await request(app)
      .post('/api/widget/message')
      .set('Content-Type', 'application/json')
      .send(zeros(bytes.parse(PUBLIC_JSON_BODY_LIMIT) + 1024));
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('the same without a Content-Length (chunked) is a 413 too', async () => {
    handler.mockClear();
    const status = await rawPost('/api/visitors/track', { 'Content-Type': 'application/json' }, zeros(200 * 1024), true);
    expect(status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a gzip bomb (50 KB that inflates to 50 MB) is refused with 415, never inflated', async () => {
    handler.mockClear();
    const bomb = zlib.gzipSync(Buffer.from(zeros(50 * 1024 * 1024)), { level: 9 });
    expect(bomb.length).toBeLessThan(200 * 1024);
    const inflate = vi.spyOn(zlib, 'createGunzip');
    for (const p of ['/api/widget/message', '/api/widget/attachments/abc/upload', '/api/conversations/x/send-message']) {
      const status = await rawPost(p, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, bomb);
      expect(status, p).toBe(415);
    }
    expect(inflate).not.toHaveBeenCalled();
    inflate.mockRestore();
    expect(handler).not.toHaveBeenCalled();
  });

  it('the text/plain widget paths keep their own limits', async () => {
    handler.mockClear();
    const boot = await request(app)
      .post('/api/widget/bootstrap')
      .set('Content-Type', 'text/plain')
      .send(zeros(20 * 1024));
    expect(boot.status).toBe(413);
    const track = await request(app)
      .post('/api/widget/track')
      .set('Content-Type', 'application/json')
      .send(zeros(100 * 1024));
    expect(track.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('real payloads still pass', () => {
  it('a 5,000-character Persian chat message with contact details', async () => {
    handler.mockClear();
    const body = {
      workspace_id: '0b6b3c8e-0000-4000-8000-000000000000',
      conversation_id: null,
      message: 'سلام دنیا 😀 '.repeat(400).slice(0, 5000),
      visitor_id: 'v'.repeat(255),
      visitor_name: 'ن'.repeat(200),
      visitor_email: 'someone@example.com',
      visitor_phone: '+989121234567',
      session_id: '0b6b3c8e-0000-4000-8000-000000000001',
      client_message_id: 'c'.repeat(64),
    };
    const res = await request(app).post('/api/widget/message').send(body);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('smart-event telemetry with a full page journey', async () => {
    const page = { path: '/'.padEnd(500, 'p'), title: 't'.repeat(300), ts: Date.now() };
    const body = { event_type: 'shown', current: page, recent_pages: Array.from({ length: 20 }, () => page), referrer: 'r'.repeat(1000) };
    const res = await request(app).post('/api/widget/smart/event').send(body);
    expect(res.status).toBe(200);
  });

  it('a widget attachment upload of several MB of base64', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    const res = await request(app).post('/api/widget/attachments/abc/upload').send({ data });
    expect(res.status).toBe(200);
  });

  it('a panel upload above 64 KB is not held to the public limit', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    const res = await request(app).post('/api/conversation-attachments/upload').send({ workspace_id: 'w', data });
    expect(res.status).toBe(200);
  });

  it('a gzip body to a provider webhook is still inflated', async () => {
    const message = { message: { data: Buffer.from('{"emailAddress":"a@b.c","historyId":1}').toString('base64') }, subscription: 's' };
    handler.mockClear();
    // The same spy as the bomb test: proves it sees body-parser's gunzip.
    const inflate = vi.spyOn(zlib, 'createGunzip');
    const status = await rawPost('/webhooks/gmail/push', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, zlib.gzipSync(Buffer.from(JSON.stringify(message))));
    expect(status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(inflate).toHaveBeenCalledTimes(1);
    inflate.mockRestore();
  });
});

describe('server/index.ts mount order', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../server/index.ts'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('parses bodies with jsonBodyParser before the IP block and the abuse check, and nowhere else', () => {
    const parser = at('return parseJsonBody(req, res, next);');
    expect(parser).toBeLessThan(at("app.use('/api/', ipBlockMiddleware());"));
    expect(parser).toBeLessThan(at("app.use('/api/', abuseDetectionMiddleware());"));
    expect(src).not.toMatch(/^\s*app\.use\([^\n]*express\.(json|urlencoded)\(/m);
  });

  it('keeps the raw-body webhook routes ahead of it and skipped by it', () => {
    const parser = at('return parseJsonBody(req, res, next);');
    for (const mount of [
      "app.use('/api/calls/livekit/webhook'",
      "app.use('/api/billing/webhook'",
      "app.use('/api/commerce/events'",
      "app.use('/api/commerce/connection'",
      "app.use('/api/email-events'",
    ]) {
      expect(at(mount), mount).toBeLessThan(parser);
    }
    for (const skip of ['/api/calls/livekit/webhook', '/api/billing/webhook', '/api/commerce/events', '/api/commerce/connection', '/api/email-events']) {
      const escaped = skip.replace(/[/.]/g, '\\$&');
      expect(src).toMatch(new RegExp(`'${escaped}'\\)+ return next\\(\\);`));
    }
  });
});
