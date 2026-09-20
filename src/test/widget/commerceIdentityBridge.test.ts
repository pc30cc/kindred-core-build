/**
 * The commerce customer identity bridge, in the SHIPPED loader.js.
 *
 * A store plugin puts a signed, short-lived assertion on the loader script
 * tag when the page is being viewed by a signed-in customer. The server has
 * always had `POST /api/widget/commerce/identity` to verify it and bind that
 * customer to the widget visitor — and its own doc comment says the widget
 * runtime calls it "after it reads the plugin-injected assertion out of the
 * page bootstrap config".
 *
 * Nothing ever did. Both ends of the bridge were built and the middle was
 * missing, so a signed-in shopper was an anonymous visitor to the widget and
 * every order question could only ever answer `identity_required`. Because
 * the widget otherwise worked perfectly, nothing looked broken.
 *
 * The failure mode this guards against is silence, so the tests assert the
 * call is MADE — and, just as importantly, that it is not made from a
 * half-formed state, not made twice, and cannot take the widget down with it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');

const IDENTITY_PATH = '/api/widget/commerce/identity';
const ASSERTION = 'signed.assertion.value-long-enough';
const CONNECTION_ID = '11111111-2222-3333-4444-555555555555';

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok, status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function autoLoad(node: any) {
  if (!node || (node.tagName !== 'SCRIPT' && node.tagName !== 'LINK')) return;
  if (node.getAttribute && node.getAttribute('data-gs-runtime-call') === 'true') return;
  setTimeout(() => { if (typeof node.onload === 'function') node.onload(); }, 0);
}
function patchAppendChild(target: any) {
  const real = target.appendChild.bind(target);
  return vi.spyOn(target, 'appendChild').mockImplementation((node: any) => { autoLoad(node); return real(node); });
}

const BOOTSTRAP_RESPONSE = { session_token: 'tok-1', workspace_id: 'ws-test', is_new_visitor: false, availability: { state: 'online' } };
const CONFIG_RESPONSE = { enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default' };

/**
 * The loader resolves its own <script> tag once, at load time, and reads
 * every data-* attribute off it — so the tag has to exist BEFORE boot.
 */
function placeLoaderScript(attrs: Record<string, string>) {
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.head.appendChild(el);
  return el;
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Set to make the identity call reject, to prove it cannot break the widget. */
let identityRejects = false;

async function boot(attrs: Record<string, string>) {
  placeLoaderScript(attrs);
  (window as any).__gs_id = 'ws-test';
  (window as any).__gs_api_base = 'https://api.test';
  patchAppendChild(document.head);

  fetchMock = vi.fn((url: string, init?: any) => {
    const u = String(url);
    if (u.includes(IDENTITY_PATH)) {
      return identityRejects ? Promise.reject(new Error('network')) : Promise.resolve(jsonResponse({ ok: true, linked: true }));
    }
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse(BOOTSTRAP_RESPONSE));
    if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse(CONFIG_RESPONSE));
    return Promise.resolve(jsonResponse({}));
  });
  (window as any).fetch = fetchMock;

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LOADER_SRC).call(window);
  await flush();
}

const identityCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes(IDENTITY_PATH));

beforeEach(() => {
  vi.useRealTimers();
  identityRejects = false;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const k of ['__gs', '__gs_id', '__gs_api_base', '__gs_loaded', '__gs_loader_injected', '__gs_token', '__gs_runtime', '__gs_policy']) {
    delete (window as any)[k];
  }
});
afterEach(() => { vi.restoreAllMocks(); });

describe('commerce identity bridge', () => {
  it('binds the customer once bootstrap has established the visitor', async () => {
    await boot({ 'data-commerce-assertion': ASSERTION, 'data-commerce-connection': CONNECTION_ID });

    const calls = identityCalls();
    expect(calls).toHaveLength(1);

    const [, init] = calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      workspaceId: 'ws-test',
      connectionId: CONNECTION_ID,
      assertion: ASSERTION,
    });
  });

  it('sends the visitor cookie, without which the server cannot identify anyone', async () => {
    // The endpoint resolves the visitor from the cookie bootstrap just set.
    // Omitting credentials would make the call succeed and bind nothing.
    await boot({ 'data-commerce-assertion': ASSERTION, 'data-commerce-connection': CONNECTION_ID });

    expect(identityCalls()[0][1].credentials).toBe('include');
  });

  it('runs only after bootstrap, never before', async () => {
    await boot({ 'data-commerce-assertion': ASSERTION, 'data-commerce-connection': CONNECTION_ID });

    const order = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(order.findIndex((u) => u.includes('/api/widget/bootstrap')))
      .toBeLessThan(order.findIndex((u) => u.includes(IDENTITY_PATH)));
  });

  it('does nothing for a guest — no assertion, no call', async () => {
    await boot({});
    expect(identityCalls()).toHaveLength(0);
  });

  it('still binds a store that has no connection id to send', async () => {
    // The connection id only reached the plugin through pairing/exchange, and
    // older builds did not store it — so a store paired before that field
    // existed sends the assertion alone and has no way to learn the id. The
    // first version of this bridge required both attributes, which would have
    // left it permanently inert on exactly the longest-connected stores. The
    // server resolves the workspace's connection itself in this case.
    await boot({ 'data-commerce-assertion': ASSERTION });

    const calls = identityCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ workspaceId: 'ws-test', assertion: ASSERTION });
  });

  it('never calls on a connection id alone — the assertion is the proof', async () => {
    await boot({ 'data-commerce-connection': CONNECTION_ID });
    expect(identityCalls()).toHaveLength(0);
  });

  it('does not re-POST the assertion when the loader is injected twice', async () => {
    // A merchant can end up with both the plugin injection and the snippet
    // pasted into the theme. NOTE: what stops the second call here is the
    // loader's own singleton (__gs_loaded / an existing <gs-widget>), which
    // returns before bootstrap ever runs again — not the bridge's internal
    // `_commerceBound` flag. That flag is defence in depth and this test does
    // not exercise it; removing it leaves this suite green.
    await boot({ 'data-commerce-assertion': ASSERTION, 'data-commerce-connection': CONNECTION_ID });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(LOADER_SRC).call(window);
    await flush();

    expect(identityCalls()).toHaveLength(1);
  });

  it('cannot take the widget down when the binding fails', async () => {
    identityRejects = true;
    await boot({ 'data-commerce-assertion': ASSERTION, 'data-commerce-connection': CONNECTION_ID });

    // The widget still reached its normal ready state: config was fetched and
    // the shell is mounted. A shopper simply stays anonymous.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/widget/config'))).toBe(true);
    expect(document.querySelector('gs-widget')).not.toBeNull();
  });
});
