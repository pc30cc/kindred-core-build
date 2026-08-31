import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Security contract: GET /api/widget/conversations and
 * POST /api/widget/conversations/:id/read must derive visitor identity
 * EXCLUSIVELY from the signed HttpOnly `dvsid` cookie (exposed by the
 * identity middleware as `req.visitorId`).
 *
 * A client-supplied `visitor_id` (query or body) must never be read on these
 * routes — otherwise any visitor could enumerate another visitor's threads by
 * tampering with the parameter.
 */

let source: string;

function handlerBody(startMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `route not found: ${startMarker}`).toBeGreaterThan(-1);
  // Cut at the next route registration so we only inspect this handler.
  const next = source.indexOf('widgetRouter.', start + startMarker.length);
  const slice = source.slice(start, next === -1 ? source.length : next);
  // Strip comments — prose describing what the handler refuses to read must
  // not be mistaken for the handler actually reading it.
  return slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}


beforeAll(() => {
  source = readFileSync(resolve(process.cwd(), 'server/routes/widget.ts'), 'utf8');
});

describe('widget conversations — visitor identity is cookie-only', () => {
  const routes = [
    "widgetRouter.get('/conversations'",
    "widgetRouter.post('/conversations/:id/read'",
  ];

  for (const route of routes) {
    it(`${route} uses req.visitorId and never a client-sent visitor_id`, () => {
      const body = handlerBody(route);

      // Authoritative source: the cookie-derived value.
      expect(body).toMatch(/\(req as any\)\.visitorId/);

      // Tampered/forged client input must not be consulted at all.
      expect(body).not.toMatch(/req\.query\.visitor_id/);
      expect(body).not.toMatch(/req\.body[^\n]*visitor_id/);
      expect(body).not.toMatch(/body\.visitor_id/);
    });

    it(`${route} bails out when the cookie yields no identity`, () => {
      const body = handlerBody(route);
      // Guard immediately after resolving visitorId — no identity, no data.
      expect(body).toMatch(/if \(!visitorId\)/);
    });
  }

  it('the read marker is written keyed by the cookie-derived visitor id', () => {
    const body = handlerBody("widgetRouter.post('/conversations/:id/read'");
    expect(body).toMatch(/widget_conversation_reads/);
    expect(body).toMatch(/visitor_id: visitorId/);
    // Ownership of the thread is re-verified before any write.
    expect(body).toMatch(/owns/);
  });

  it('unread counts are computed, not hard-coded to zero', () => {
    const body = handlerBody("widgetRouter.get('/conversations'");
    expect(body).not.toMatch(/unreadCount: 0/);
    expect(body).toMatch(/unreadCount: unreadByConv\[c\.id\] \|\| 0/);
    expect(body).toMatch(/widget_conversation_reads/);
  });
});

describe('widget runtime — new conversation & identity hygiene', () => {
  it('runtime never sends visitor_id to the conversations endpoint', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf("'/api/widget/conversations?workspace_id='");
    expect(idx).toBeGreaterThan(-1);
    const snippet = runtime.slice(idx, idx + 400);
    expect(snippet).not.toMatch(/visitor_id/);
  });

  it('"+ new conversation" arms the canonical fresh-intent latch in the store', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    expect(runtime).toMatch(/function startNewConversation\(\)/);
    expect(runtime).toMatch(/chatUI\.startNewConversation/);
    // P0-A/P0-B — the latch lives in chatStore (not a closure boolean) so
    // transport, polling and history bootstrap all observe the same truth.
    expect(runtime).toMatch(/freshIntent: true/);
    expect(runtime).toMatch(/function freshIntentArmed\(\)/);
    // Disarmed only when a real id for the NEW thread comes back.
    expect(runtime).toMatch(/freshIntent: false/);
  });


  it('the chat transport forwards force_new_conversation only without a conversation id', () => {
    const chat = readFileSync(resolve(process.cwd(), 'public/widget/runtime-chat.js'), 'utf8');
    expect(chat).toMatch(/var forceNewConversation = !conversationId && !!opts\.forceNewConversation/);
    expect(chat).toMatch(/force_new_conversation: forceNewConversation \|\| undefined/);
  });

  it('the server skips every reuse path when force_new_conversation is set', () => {
    expect(source).toMatch(/if \(!convId && body\.visitor_id && !body\.force_new_conversation\)/);
  });
});
