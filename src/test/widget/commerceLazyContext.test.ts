/**
 * Lazy store identity in the SHIPPED loader.js (the OpenCart extension's
 * mode). The page carries only the address of a same-origin, no-store
 * endpoint; the loader asks it for an assertion when — and only when — the
 * visitor opens the chat, once per page. A page nobody interacts with makes
 * no identity call at all, and a browser that was linked and is now signed
 * out has its link ended.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const CONTEXT_PATH = '/index.php?route=extension/webyar/module/webyar.context';

type FetchInit = { method?: string; body?: string; credentials?: string; cache?: string };

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

let fetchMock: ReturnType<typeof vi.fn>;
let contextAnswer: unknown = { assertion: 'lazy.assertion-value-long-enough', signed_in: true };

async function boot(attrs: Record<string, string>) {
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.head.appendChild(el);
  const w = window as unknown as Record<string, unknown>;
  w.__gs_id = 'ws-test';
  w.__gs_api_base = 'https://api.test';
  const real = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const n = node as unknown as { tagName?: string; onload?: () => void };
    if (n.tagName === 'SCRIPT' || n.tagName === 'LINK') setTimeout(() => { if (typeof n.onload === 'function') n.onload(); }, 0);
    return real(node);
  });
  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('webyar.context')) return Promise.resolve(jsonResponse(contextAnswer));
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse({ session_token: 'tok-1', workspace_id: 'ws-test', availability: { state: 'online' } }));
    if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse({ enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default' }));
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  w.fetch = fetchMock;
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

const calls = (part: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(part));

beforeEach(() => {
  contextAnswer = { assertion: 'lazy.assertion-value-long-enough', signed_in: true };
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  try { window.sessionStorage.clear(); } catch { /* none */ }
  const w = window as unknown as Record<string, unknown>;
  for (const k of ['__gs', '__gs_id', '__gs_api_base', '__gs_loaded', '__gs_loader_injected', '__gs_token', '__gs_runtime', '__gs_policy']) delete w[k];
});
afterEach(() => { vi.restoreAllMocks(); });

describe('lazy store identity', () => {
  it('an idle page makes no identity call at all', async () => {
    await boot({ 'data-commerce-context-url': `${window.location.origin}${CONTEXT_PATH}`, 'data-commerce-provider': 'opencart' });
    expect(calls('webyar.context')).toHaveLength(0);
    expect(calls('/api/widget/commerce/identity')).toHaveLength(0);
  });

  it('opening the chat asks the store once, same-origin and uncached, then binds', async () => {
    await boot({ 'data-commerce-context-url': `${window.location.origin}${CONTEXT_PATH}`, 'data-commerce-connection': '11111111-2222-3333-4444-555555555555' });
    expect(clickLauncher()).toBe(true);
    await flush();
    clickLauncher();
    await flush();
    const ctx = calls('webyar.context');
    expect(ctx).toHaveLength(1);
    expect((ctx[0][1] as FetchInit)).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    const bind = calls('/api/widget/commerce/identity');
    expect(bind).toHaveLength(1);
    expect(JSON.parse(String((bind[0][1] as FetchInit).body))).toMatchObject({ workspaceId: 'ws-test', assertion: 'lazy.assertion-value-long-enough' });
  });

  it('never calls a context URL on another origin', async () => {
    await boot({ 'data-commerce-context-url': `https://evil.example${CONTEXT_PATH}` });
    clickLauncher();
    await flush();
    expect(calls('webyar.context')).toHaveLength(0);
    expect(calls('evil.example')).toHaveLength(0);
  });

  it('a guest who was never linked: nothing is sent', async () => {
    contextAnswer = { assertion: null, signed_in: false };
    await boot({ 'data-commerce-context-url': `${window.location.origin}${CONTEXT_PATH}` });
    clickLauncher();
    await flush();
    expect(calls('/api/widget/commerce/identity')).toHaveLength(0);
  });

  it('signed out after having been linked in this tab: the link is ended', async () => {
    window.sessionStorage.setItem('gs:commerce-linked:ws-test', '1');
    contextAnswer = { assertion: null, signed_in: false };
    await boot({ 'data-commerce-context-url': `${window.location.origin}${CONTEXT_PATH}` });
    clickLauncher();
    await flush();
    const unlink = calls('/api/widget/commerce/identity/unlink');
    expect(unlink).toHaveLength(1);
    expect(JSON.parse(String((unlink[0][1] as FetchInit).body))).toEqual({ workspaceId: 'ws-test' });
    expect(window.sessionStorage.getItem('gs:commerce-linked:ws-test')).toBeNull();
  });

  it('the embedded-assertion mode (WooCommerce) is unchanged', async () => {
    await boot({ 'data-commerce-assertion': 'signed.assertion.value-long-enough' });
    expect(calls('/api/widget/commerce/identity')).toHaveLength(1);
    expect(calls('webyar.context')).toHaveLength(0);
  });
});
