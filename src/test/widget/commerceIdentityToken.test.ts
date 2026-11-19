/**
 * The store identity calls of the SHIPPED loader.js send the session token
 * the page holds NOW, and recover it once when it was refused.
 *
 * The bootstrap's own token lives 15 minutes; the lazy identity (OpenCart)
 * and its logout unlink run only when the visitor opens the chat, often
 * later. They used the bootstrap's token, so after a while on the page the
 * bind was refused (401/403) and the unlink too, after its "linked" mark had
 * already been removed: the previous customer's link was never ended.
 *
 * Now: the token bus's current token (the runtime refreshes it), and a 401 or
 * 403 recovers the session once (refresh) and sends again; the unlink's mark
 * goes only once the link is ended.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const CONTEXT_PATH = '/index.php?route=extension/webyar/module/webyar.context';
const IDENTITY = '/api/widget/commerce/identity';
const UNLINK = '/api/widget/commerce/identity/unlink';
const LINKED_KEY = 'gs:commerce-linked:ws-test';

type Init = { method?: string; body?: string; headers?: Record<string, string> };
type Win = Record<string, unknown> & { __gs_token?: { get(): string; set(t: string): void } };
const w = () => window as unknown as Win;

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

let fetchMock: ReturnType<typeof vi.fn>;
let contextAnswer: unknown;
/** The statuses the identity and unlink routes answer, in order; then 200. */
let identityStatuses: number[];
let unlinkStatuses: number[];

async function boot(attrs: Record<string, string>) {
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.head.appendChild(el);
  w().__gs_id = 'ws-test';
  w().__gs_api_base = 'https://api.test';
  const real = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const n = node as unknown as { tagName?: string; onload?: () => void };
    if (n.tagName === 'SCRIPT' || n.tagName === 'LINK') setTimeout(() => { if (typeof n.onload === 'function') n.onload(); }, 0);
    return real(node);
  });
  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('webyar.context')) return Promise.resolve(jsonResponse(contextAnswer));
    if (u.includes(UNLINK)) return Promise.resolve(jsonResponse({ ok: true }, unlinkStatuses.shift() ?? 200));
    if (u.includes(IDENTITY)) return Promise.resolve(jsonResponse({ ok: true, linked: true }, identityStatuses.shift() ?? 200));
    if (u.includes('/api/widget/session/refresh')) return Promise.resolve(jsonResponse({ session_token: 'tok-fresh' }));
    if (u.includes('/api/widget/bootstrap') || u.includes('/api/widget/boot')) {
      return Promise.resolve(jsonResponse({ session_token: 'tok-boot', workspace_id: 'ws-test', availability: { state: 'online' } }));
    }
    if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse({ enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default' }));
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  w().fetch = fetchMock;
  new Function(LOADER_SRC).call(window);
  await flush();
}

function clickLauncher() {
  for (const host of Array.from(document.querySelectorAll('*'))) {
    const button = host.shadowRoot?.querySelector('button.launcher') as HTMLButtonElement | null | undefined;
    if (button) { button.click(); return true; }
  }
  return false;
}

const calls = (path: string) => fetchMock.mock.calls.filter((c) => {
  const u = String(c[0]);
  return path === IDENTITY ? u.includes(IDENTITY) && !u.includes(UNLINK) : u.includes(path);
});
const tokenOf = (c: unknown[]) => (c[1] as Init).headers?.['X-Widget-Token'];

beforeEach(() => {
  contextAnswer = { assertion: 'lazy.assertion-value-long-enough', signed_in: true };
  identityStatuses = [];
  unlinkStatuses = [];
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  try { window.sessionStorage.clear(); window.localStorage.clear(); } catch { /* none */ }
  for (const k of ['__gs', '__gs_id', '__gs_api_base', '__gs_loaded', '__gs_loader_injected', '__gs_token', '__gs_runtime', '__gs_policy']) delete w()[k];
});
afterEach(() => { vi.restoreAllMocks(); });

const lazyPage = { 'data-commerce-context-url': `${window.location.origin}${CONTEXT_PATH}` };

describe('the lazy identity sends the token the page holds now', () => {
  it('after the runtime refreshed the session, the bind carries the new token, not the bootstrap\'s', async () => {
    await boot(lazyPage);
    expect(w().__gs_token?.get()).toBe('tok-boot');
    w().__gs_token!.set('tok-refreshed');
    clickLauncher();
    await flush();
    const bind = calls(IDENTITY);
    expect(bind).toHaveLength(1);
    expect(tokenOf(bind[0])).toBe('tok-refreshed');
  });

  it('a refused bind (403) recovers the session once and is sent again with the fresh token', async () => {
    identityStatuses = [403];
    await boot(lazyPage);
    clickLauncher();
    await flush();
    const bind = calls(IDENTITY);
    expect(bind.map(tokenOf)).toEqual(['tok-boot', 'tok-fresh']);
    expect(calls('/api/widget/session/refresh')).toHaveLength(1);
  });
});

describe('the logout unlink', () => {
  it('a refused unlink (401) recovers the session, is sent again, and the mark goes once it is ended', async () => {
    window.sessionStorage.setItem(LINKED_KEY, '1');
    contextAnswer = { assertion: null, signed_in: false };
    unlinkStatuses = [401];
    await boot(lazyPage);
    clickLauncher();
    await flush();
    const unlink = calls(UNLINK);
    expect(unlink.map(tokenOf)).toEqual(['tok-boot', 'tok-fresh']);
    expect(JSON.parse(String((unlink[1][1] as Init).body))).toEqual({ workspaceId: 'ws-test' });
    expect(window.sessionStorage.getItem(LINKED_KEY)).toBeNull();
  });

  it.each([503, 429])('an unlink the server could not do (%i) keeps the mark, so the next page asks again', async (status) => {
    window.sessionStorage.setItem(LINKED_KEY, '1');
    contextAnswer = { assertion: null, signed_in: false };
    unlinkStatuses = [status];
    await boot(lazyPage);
    clickLauncher();
    await flush();
    expect(calls(UNLINK)).toHaveLength(1);
    expect(window.sessionStorage.getItem(LINKED_KEY)).toBe('1');
  });
});

describe('the embedded assertion (WooCommerce, WHMCS)', () => {
  it('a refused bind (401) is sent again with the fresh token', async () => {
    identityStatuses = [401];
    await boot({ 'data-commerce-assertion': 'signed.assertion.value-long-enough' });
    expect(calls(IDENTITY).map(tokenOf)).toEqual(['tok-boot', 'tok-fresh']);
  });

  it('any other refusal is not retried with a new token (400)', async () => {
    identityStatuses = [400];
    await boot({ 'data-commerce-assertion': 'signed.assertion.value-long-enough' });
    expect(calls(IDENTITY)).toHaveLength(1);
    expect(calls('/api/widget/session/refresh')).toHaveLength(0);
  });
});
