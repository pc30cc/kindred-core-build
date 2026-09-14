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

/**
 * P0 regression (2026-09-14) — "Recent Conversations missing". Root cause
 * was NOT the server (GET /conversations already fails closed with a real
 * 500 on a DB error — see the assertion below) but the widget client:
 * `loadConversations()` unconditionally collapsed ANY non-OK response
 * (401/403/500/network failure) into `{ conversations: [] }`, so a real
 * outage rendered identically to "this visitor genuinely has no
 * conversations" with no way to tell the two apart or retry.
 */
describe('GET /api/widget/conversations — a backend failure must never be reported as a successful empty list', () => {
  it('server: a DB error on the conversations query returns 500, not conversations: []', () => {
    const body = handlerBody("widgetRouter.get('/conversations'");
    expect(body).toMatch(/if \(error\) throw error;/);
    expect(body).toMatch(/catch \(err: any\) \{/);
    expect(body).toMatch(/res\.status\(500\)\.json\(\{ error: 'Internal error' \}\)/);
  });

  it('client: loadConversations() no longer collapses a non-OK response into { conversations: [] }', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function loadConversations(onDone)');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 4200);
    // The old masking line must be gone.
    expect(body).not.toMatch(/return r\.ok \? r\.json\(\) : \{ conversations: \[\] \}/);
    expect(body).not.toMatch(/\.catch\(function \(\) \{ return \{ conversations: \[\] \}; \}\)/);
    // A non-OK response must throw so it lands in a distinct error path.
    expect(body).toMatch(/if \(!r\.ok\) \{/);
  });

  it('client: a failed fetch sets error state and does NOT claim loaded:true (so it is retried, not permanently cached as empty)', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function loadConversations(onDone)');
    const body = runtime.slice(idx, idx + 4200);
    const catchIdx = body.indexOf('.catch(function (err) {');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = body.slice(catchIdx, catchIdx + 1600);
    // Strip line comments before checking for a real `loaded: true`
    // assignment — the fix's own explanatory comment names the old,
    // rejected behavior ("Deliberately NOT loaded:true") and must not be
    // mistaken for the code doing it.
    const catchCode = catchBody.replace(/^\s*\/\/.*$/gm, '');
    expect(catchBody).toMatch(/error: true/);
    expect(catchCode).not.toMatch(/loaded:\s*true/);
  });

  it('client: a failed load schedules exactly one bounded automatic retry, using exponential backoff (never a fixed re-fetch on every render)', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    expect(runtime).toMatch(/CONVERSATIONS_RETRY_BASE_MS\s*=\s*15000/);
    expect(runtime).toMatch(/CONVERSATIONS_RETRY_MAX_MS\s*=\s*300000/);
    expect(runtime).toMatch(/function scheduleConversationsRetry\(\)/);
    // "At most one scheduled retry" — the guard must check the existing
    // timer handle before arming a new one.
    const idx = runtime.indexOf('function scheduleConversationsRetry()');
    const body = runtime.slice(idx, idx + 500);
    expect(body).toMatch(/if \(conversationsRetryTimer\) return;/);
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/conversationsNextRetryDelay\(\)/);
  });

  it('client: conversationsNextRetryDelay() implements 15s/30s/60s/120s/300s-cap exponential backoff, keyed off consecutive failures', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function conversationsNextRetryDelay()');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 300);
    expect(body).toMatch(/Math\.max\(0, conversationsConsecutiveFailures - 1\)/);
    expect(body).toMatch(/Math\.min\(CONVERSATIONS_RETRY_MAX_MS, CONVERSATIONS_RETRY_BASE_MS \* Math\.pow\(2, exp\)\)/);
  });

  it('client: a successful load resets the consecutive-failure counter and clears any pending timer — the next future failure starts again from 15s', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function loadConversations(onDone)');
    const body = runtime.slice(idx, idx + 4200);
    const thenIdx = body.indexOf('.then(function (data) {');
    expect(thenIdx).toBeGreaterThan(-1);
    const catchIdx = body.indexOf('.catch(function (err) {');
    const successBody = body.slice(thenIdx, catchIdx);
    expect(successBody).toMatch(/conversationsConsecutiveFailures = 0/);
    expect(successBody).toMatch(/clearTimeout\(conversationsRetryTimer\)/);
  });

  it('client: on failure, a previously loaded list is kept, not blanked (only the store fields loading/error are touched)', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function loadConversations(onDone)');
    const body = runtime.slice(idx, idx + 4200);
    const catchIdx = body.indexOf('.catch(function (err) {');
    const catchBody = body.slice(catchIdx, catchIdx + 1600);
    expect(catchBody).not.toMatch(/items:\s*\[\]/);
  });

  it('client: an explicit user retry bypasses backoff AND the hidden-tab defer, cancelling any pending automatic retry (no double-fire)', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    expect(runtime).toMatch(/function retryConversationsLoad\(\)/);
    const idx = runtime.indexOf('function retryConversationsLoad()');
    const body = runtime.slice(idx, idx + 500);
    expect(body).toMatch(/clearTimeout\(conversationsRetryTimer\)/);
    expect(body).toMatch(/removeEventListener\('visibilitychange', conversationsVisibilityHandler\)/);
    expect(body).toMatch(/runConversationsRetryRequest\(\)/);
  });

  it('client: runConversationsRetryRequest() (the one place that actually calls loadConversations() for a retry) is used by both the automatic and manual paths', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function runConversationsRetryRequest()');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 300);
    expect(body).toMatch(/loadConversations\(/);
  });

  it('client: an automatic retry defers while the tab is hidden and fires once visibility returns, without re-applying backoff', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('function fireConversationsAutoRetry()');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx, idx + 700);
    expect(body).toMatch(/document\.visibilityState === 'hidden'/);
    expect(body).toMatch(/if \(conversationsVisibilityHandler\) return;/);
    expect(body).toMatch(/addEventListener\('visibilitychange', conversationsVisibilityHandler\)/);
    expect(body).toMatch(/runConversationsRetryRequest\(\)/);
  });

  it('client: renderHome() and renderConversationList() are pure renders of store state — neither calls loadConversations() itself (the recursion bug: a retry callback re-entering the same render function that scheduled it)', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    // Strip comments first — this file's own explanatory prose names the
    // function ("...never itself a loadConversations() call site") and
    // must not be mistaken for actual code doing it.
    const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '');

    const homeIdx = runtime.indexOf('function renderHome()');
    expect(homeIdx).toBeGreaterThan(-1);
    const nextFnIdx = runtime.indexOf('\n    function ', homeIdx + 10);
    const homeBody = stripComments(runtime.slice(homeIdx, nextFnIdx));
    expect(homeBody).not.toMatch(/loadConversations\(/);

    const listIdx = runtime.indexOf('function renderConversationList()');
    expect(listIdx).toBeGreaterThan(-1);
    const listBody = stripComments(runtime.slice(listIdx, homeIdx)); // renderConversationList precedes renderHome
    expect(listBody).not.toMatch(/loadConversations\(/);
  });

  it('client: a load failure logs only a SAFE gs:debug diagnostic (operation/status/code/failureCount/nextRetryMs) — never widget/session/visitor/contact identity', () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const idx = runtime.indexOf('conversations_load_failed');
    expect(idx).toBeGreaterThan(-1);
    const body = runtime.slice(idx - 250, idx + 400);
    expect(body).toMatch(/operation:\s*'conversations_load'/);
    expect(body).toMatch(/status:/);
    expect(body).toMatch(/code:/);
    expect(body).toMatch(/failureCount:\s*conversationsConsecutiveFailures/);
    expect(body).toMatch(/nextRetryMs:\s*conversationsNextRetryDelay\(\)/);
    for (const banned of ['sessionToken', 'visitorId', 'contact_id', 'X-Widget-Token', 'dvsid']) {
      expect(body).not.toContain(banned);
    }
    // Gated behind Util.warn, which is itself gated on Util.debug (gs:debug)
    // — see productionHardeningPass.test.ts for the debug-gating contract.
    expect(runtime.slice(Math.max(0, idx - 150), idx + 40)).toContain("Util.warn('conversations_load_failed'");
    // The counter is incremented BEFORE this diagnostic (and before
    // scheduling), so nextRetryMs actually reflects the delay that will be
    // used — not a stale pre-increment value.
    const failIdx = body.indexOf('conversationsConsecutiveFailures += 1');
    expect(failIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeLessThan(body.indexOf('failureCount:'));
  });

  it("client: renderBodyInner()'s home/list branches are gated on both !loaded and !error, so a failed load is never re-attempted by the render path itself (only scheduleConversationsRetry's timer or an explicit user retry may)", () => {
    const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    const dispatcherIdx = runtime.indexOf('function renderBodyInner()');
    expect(dispatcherIdx).toBeGreaterThan(-1);
    const homeBranchIdx = runtime.indexOf("if (tab === 'home')", dispatcherIdx);
    const listBranchIdx = runtime.indexOf("if (tab === 'list')", dispatcherIdx);
    const homeBranch = runtime.slice(homeBranchIdx, listBranchIdx);
    expect(homeBranch).toMatch(/!homeConvState\.loaded && !homeConvState\.error/);
    expect(homeBranch).toMatch(/if \(!homeConvState\.loading\) \{/);

    const chatBranchIdx = runtime.indexOf("if (tab === 'chat')", listBranchIdx);
    const listBranch = runtime.slice(listBranchIdx, chatBranchIdx);
    expect(listBranch).toMatch(/!listConvState\.loaded && !listConvState\.error/);
    expect(listBranch).toMatch(/if \(!listConvState\.loading\) \{/);
  });
});

describe('POST /api/widget/message — public error code (P0 regression, 2026-09-14 outage)', () => {
  it('the catch-all failure path returns a stable, sanitized code alongside the generic message', () => {
    const idx = source.indexOf("widgetRouter.post('/message'");
    expect(idx).toBeGreaterThan(-1);
    const tail = source.slice(idx, source.length);
    const catchIdx = tail.indexOf("console.error('[widget-message] Error:'");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = tail.slice(catchIdx, catchIdx + 300);
    expect(catchBody).toMatch(/code:\s*'MESSAGE_PERSIST_FAILED'/);
    // The PUBLIC json response (res.status(...).json({...})) must never
    // interpolate the raw driver error — only the console.error server log
    // (already outside the public response) may reference err.message.
    const jsonLineIdx = catchBody.indexOf('res.status(500).json(');
    expect(jsonLineIdx).toBeGreaterThan(-1);
    const jsonLine = catchBody.slice(jsonLineIdx, catchBody.indexOf('\n', jsonLineIdx));
    expect(jsonLine).not.toMatch(/err\.message/);
  });

  it('runtime-chat.js captures status + server code (never raw body) for gs:debug diagnostics, never widget/session identity', () => {
    const chat = readFileSync(resolve(process.cwd(), 'public/widget/runtime-chat.js'), 'utf8');
    const idx = chat.indexOf('message_send failed');
    expect(idx).toBeGreaterThan(-1);
    const body = chat.slice(idx - 50, idx + 350);
    expect(body).toMatch(/operation:\s*'message_send'/);
    expect(body).toMatch(/status:/);
    expect(body).toMatch(/code:/);
    expect(body).toMatch(/conversation_present:/);
    // Must never appear anywhere near this diagnostic block.
    for (const banned of ['sessionToken', 'visitorId', 'contact_id', 'X-Widget-Token']) {
      expect(body).not.toContain(banned);
    }
  });
});
