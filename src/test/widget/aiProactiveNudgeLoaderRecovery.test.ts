/**
 * AI Proactive Nudge — widget loader.js session-recovery contract (blocker 3).
 *
 * The nudge's code is Smart Engagement's visitor side,
 * src/lib/widget/smartClient.js (smart-engine.js carries it after the
 * engine); the session manager and recoverPost stay in loader.js, which
 * hands recoverPost to it (startSmart's `host`).
 *
 * public/widget/loader.js is a single monolithic IIFE (bound to window/
 * document) with no existing vm-execution test harness in this repo — every
 * loader.js test here (openCloseLifecycle.test.ts, designContract.test.ts,
 * previewParity.test.ts) instead asserts structural/contract properties on
 * the raw source, which is the established convention this file follows.
 *
 * What must hold, given the hardening requirement "reportAiEvent must not
 * use an independent auth/session implementation, must retry the SAME
 * lifecycle event exactly once on a widget-token 401/403, and must never
 * throw or break the visitor widget":
 *   1. window.__gs_token.recover (the canonical widget session manager's
 *      refresh-then-bootstrap sequence, installed once via
 *      installSessionManager near the top of this file) is the ONLY
 *      recovery implementation — reportAiEvent delegates to it rather than
 *      reimplementing session refresh/bootstrap a second time.
 *   2. reportAiEvent always reads the CURRENT shared token before sending.
 *   3. reportAiEvent retries via window.__gs_token.recover() on 401/403,
 *      gated so it can fire at most once (no infinite retry loop).
 *   (2 and 3 live in recoverPost, the POST reportAiEvent sends with, which
 *   the store identity calls share.)
 *   4. reportAiEvent never throws — every fetch has a .catch, and the whole
 *      function body is wrapped defensively.
 *   5. dismissed/cta_clicked events flow through the SAME reportAiEvent
 *      function as 'shown' (no separate, unrecovered reporting path).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const loader = fs.readFileSync(path.resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const client = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/widget/smartClient.js'), 'utf8');

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces for: ${signature}`);
}

describe('loader.js — AI nudge lifecycle reporting is session-recovery aware (blocker 3)', () => {
  it('window.__gs_token.recover is the ONE canonical session manager, installed once, and startTracking only delegates to it', () => {
    // installSessionManager (near the top of the file) is the single owner
    // of session recovery: it defines bus.refresh/bus.bootstrap/bus.recover
    // exactly once, guarded so a second call is a no-op.
    expect(loader).toContain('function installSessionManager(bus)');
    expect(loader).toContain('if (!bus || bus.__canonicalSession) return;');
    expect(loader).toContain('bus.refresh = function ()');
    expect(loader).toContain('bus.bootstrap = function (opts)');
    expect(loader).toContain('bus.recover = function (opts)');
    // Soft recovery is still "refresh, else bootstrap" — no separate
    // widget-token-minting logic outside the canonical session manager.
    expect(loader).toContain('start = bus.refresh().then(function (t) { return t || bus.bootstrap(); });');


    // startTracking's own recoverToken() is a thin wrapper delegating to
    // that SAME bus method — it does not reimplement refresh/bootstrap.
    const trackingBody = extractFunctionBody(loader, 'function startTracking(apiBase, workspaceId, token) {');
    expect(trackingBody).toContain('function recoverToken()');
    expect(trackingBody).toContain('window.__gs_token && window.__gs_token.recover');
    expect(trackingBody).not.toContain('function refreshToken()');
    expect(trackingBody).not.toContain('function bootstrapSession()');
  });

  it('reportAiEvent sends through recoverPost, which reads the CURRENT shared widget token before sending', () => {
    const body = extractFunctionBody(client, 'function reportAiEvent(nudgeId, type) {');
    expect(body).toContain('recoverPost(apiBase + "/api/widget/smart/event"');
    // The loader's own recoverPost, handed over by startSmart.
    expect(client).toContain('recoverPost = host.recoverPost');
    expect(extractFunctionBody(loader, 'function startSmart(config) {')).toContain('recoverPost: recoverPost');
    const post = extractFunctionBody(loader, 'function recoverPost(url, payload, token, signal) {');
    expect(post).toContain('var bus = window.__gs_token;');
    expect(post).toContain('send(bus.get() || token)');
  });

  it('reportAiEvent retries the SAME event exactly once via window.__gs_token.recover() on 401/403, never more', () => {
    const post = extractFunctionBody(loader, 'function recoverPost(url, payload, token, signal) {');
    expect(post).toContain('r.status == 401 || r.status == 403');
    // The retry's answer is returned as it is: a second 401/403 is not
    // looked at again, so there is no loop.
    expect(post).toContain('bus.recover().then(function (t) { return t ? send(t) : r; })');
    // No unbounded retry construct (setInterval/while) inside either function.
    expect(post).not.toMatch(/setInterval|while\s*\(/);
    expect(extractFunctionBody(client, 'function reportAiEvent(nudgeId, type) {')).not.toMatch(/setInterval|while\s*\(/);
  });

  it('reportAiEvent never throws — every fetch has a .catch and the send is wrapped in try/catch', () => {
    const body = extractFunctionBody(client, 'function reportAiEvent(nudgeId, type) {');
    expect(body).toContain('.catch(function () {});');
    expect(body).toContain('try {');
    expect(body).toContain('} catch (_) {}');
  });

  it('does not invent a second, independent widget-session-refresh implementation for the AI nudge path', () => {
    // Exactly one call site actually fetches the session-refresh/bootstrap
    // endpoints (inside the canonical installSessionManager) — reportAiEvent
    // must reuse recover(), not fetch either endpoint itself a second,
    // independent time.
    const refreshFetchSites = loader.split("fetch(cfg.apiBase + '/api/widget/session/refresh'").length - 1;
    expect(refreshFetchSites).toBe(1);
    // The bootstrap is posted to /boot (CORS-simple) and, from an older
    // backend, to /bootstrap (JSON): still ONE fetch site for both paths.
    const bootstrapFetchSites = loader.split("fetch(cfg.apiBase + bootstrapPath(").length - 1;
    expect(bootstrapFetchSites).toBe(1);
    expect(loader).toContain("function bootstrapPath(json) { return json ? '/api/widget/bootstrap' : '/api/widget/boot'; }");
    // Smart Engagement's visitor side never calls these two endpoints itself.
    expect(client).not.toContain('/api/widget/session/refresh');
    expect(client).not.toContain('/api/widget/boot');
    const reportAiEventBody = extractFunctionBody(client, 'function reportAiEvent(nudgeId, type) {');
    expect(reportAiEventBody).not.toContain('/api/widget/session/refresh');
    expect(reportAiEventBody).not.toContain('/api/widget/boot');
    expect(reportAiEventBody).not.toContain('bootstrapPath(');
    const recoverPostBody = extractFunctionBody(loader, 'function recoverPost(url, payload, token, signal) {');
    expect(recoverPostBody).not.toContain('/api/widget/session/refresh');
    expect(recoverPostBody).not.toContain('/api/widget/boot');
  });

  it('dismissed and cta_clicked nudge events are reported through the SAME session-recovery-aware reportAiEvent', () => {
    const shownSite = client.indexOf('reportAiEvent(data.nudgeId, "shown")');
    const dismissedSite = client.indexOf('reportAiEvent(data.nudgeId, "dismissed")');
    const ctaSite = client.indexOf('reportAiEvent(data.nudgeId, "cta_clicked")');
    expect(shownSite).toBeGreaterThan(-1);
    expect(dismissedSite).toBeGreaterThan(-1);
    expect(ctaSite).toBeGreaterThan(-1);
  });
});
