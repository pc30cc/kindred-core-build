/**
 * The chat widget's call pieces, as they meet in the SHIPPED files.
 *
 *  - runtime-call.js adds its engine to `window.__gs_call` and keeps what is
 *    already there: runtime.js puts `ended` on it (the server's call:ended,
 *    which the realtime drivers dispatch), and the call module usually loads
 *    after runtime.js. It used to replace the object, so a call the operator
 *    ended left the visitor's call surface up.
 *  - "Join" waits for the engine (`__gs_call.engine.connect`); the module has
 *    had no `incoming` since Pass 2, and the old check made every Join wait
 *    for a script that could never pass it.
 *  - A Join that fails says so under its card, which is in the widget's
 *    shadow root (it was looked for in the host page's document).
 *  - The call's clock moves every second: the ticker looks for the surface
 *    in the panel-level call host, where it is drawn, not in `.body`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { boot, click, flush, resetWindow, win, type Dict } from './coreFeaturesHarness';

const CALL_SRC = readFileSync(resolve(process.cwd(), 'public/widget/runtime-call.js'), 'utf8');

describe('runtime-call.js joins the object runtime.js made', () => {
  const doms: JSDOM[] = [];
  afterEach(() => { while (doms.length) doms.pop()!.window.close(); });

  function page() {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/', runScripts: 'outside-only' });
    doms.push(dom);
    return dom.window as unknown as Dict & { eval(src: string): void; __gs_call?: Dict & { engine?: Dict } };
  }

  it('keeps `ended` (and anything else on it) and adds the engine', () => {
    const w = page();
    const ended = () => {};
    w.__gs_call = { ended, mine: 1 };
    const before = w.__gs_call;
    let resolved: unknown = null;
    w.__gs_call_resolveReady = (v: unknown) => { resolved = v; };
    w.eval(CALL_SRC);
    expect(w.__gs_call).toBe(before);
    expect(w.__gs_call!.ended).toBe(ended);
    expect(w.__gs_call!.mine).toBe(1);
    expect(typeof w.__gs_call!.engine!.connect).toBe('function');
    expect(typeof w.__gs_call!.preload).toBe('function');
    expect((w.__gs_call!.isActive as () => boolean)()).toBe(false);
    expect(resolved).toBe(before);
  });

  it('first on the page: makes the object itself', () => {
    const w = page();
    w.eval(CALL_SRC);
    expect(typeof w.__gs_call!.engine!.connect).toBe('function');
  });
});

describe('the chat runtime and a call', () => {
  const INVITE = {
    id: 'sys-inv-1', role: 'system', sender_type: 'system', conversation_id: 'c1', text: '', body: '',
    time: new Date().toISOString(),
    metadata: { kind: 'call_invitation', invitation_id: 'inv-1', channel: 'audio', status: 'pending', expires_at: new Date(Date.now() + 120_000).toISOString() },
  };

  beforeEach(() => {
    vi.useRealTimers();
    resetWindow();
    win.__gs_token = { get: () => 'tok', set() {}, onChange() { return () => {}; }, vc: '' };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Join goes ahead once the engine is in (no `incoming`), and a refused Join says so under its card', async () => {
    const joins: string[] = [];
    const h = boot({
      hint: { tab: 'chat', conversationId: 'c1' },
      conversations: [{ id: 'c1' }],
      history: { c1: [INVITE] },
      api: (url) => {
        if (!url.includes('/api/widget/call-invitations/')) return undefined;
        joins.push(url);
        return { status: 409, body: { error: 'invitation_expired' } };
      },
    });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    // What runtime-call.js leaves: runtime.js's own `ended`, and the engine.
    (win.__gs_call as Dict).engine = { connect: () => Promise.resolve(), on() {}, getState: () => ({ state: 'idle' }) };
    const join = h.q<HTMLButtonElement>('[data-ci-action="join"][data-ci-id="inv-1"]');
    expect(join, 'the invitation card is drawn').toBeTruthy();
    click(join);
    await vi.waitFor(() => expect(h.q('[data-ci-card="inv-1"] .ci-err')?.textContent).toBe('پیوستن به تماس ممکن نشد. لطفاً دوباره تلاش کنید.'));
    expect(joins).toEqual(['https://api.test/api/widget/call-invitations/inv-1/join']);
    // No script was asked for: the engine already counted as ready.
    expect(h.scripts.some((s) => /runtime-call/.test(s))).toBe(false);
  });

  it('the call clock moves every second while connected', async () => {
    const h = boot({});
    await flush(20);
    const surface = (h.runtime as unknown as { __test: { callSurface(p: Dict): void } }).__test;
    surface.callSurface({ phase: 'connected', channel: 'audio', callId: 'call-1', micEnabled: true, connectedAt: Date.now() - 5_000 });
    await flush(5);
    const clock = () => h.q('[data-call-host] [data-call-timer]')?.textContent;
    expect(clock()).toBe('00:05');
    await new Promise((r) => setTimeout(r, 2_100));
    expect(clock()).toMatch(/^00:0[6-8]$/);
  });
});
