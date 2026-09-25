/**
 * The shipped loader.js and a billing plugin's per-person hints.
 *
 *   data-commerce-subject  "anon" | "u<opaque hash>" — who is using this
 *                          browser, as the embedding site knows it.
 *   data-commerce-binding  opaque fingerprint of the grant behind the
 *                          assertion on this page.
 *
 * Logout keeps the browser's conversation and all previous messages.
 * A different signed-in person still starts a fresh visitor, including when
 * anonymous pages separate the two logins. Plain embeds are unaffected.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const IDENTITY_PATH = '/api/widget/commerce/identity';
const BOOTSTRAP_PATH = '/api/widget/bootstrap';

type Win = Record<string, unknown>;
const win = () => window as unknown as Win;

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function patchAppendChild(target: HTMLElement) {
  const real = target.appendChild.bind(target);
  return vi.spyOn(target, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const el = node as unknown as { tagName?: string; onload?: () => void; getAttribute?: (n: string) => string | null };
    if ((el.tagName === 'SCRIPT' || el.tagName === 'LINK') && el.getAttribute?.('data-gs-runtime-call') !== 'true') {
      setTimeout(() => { if (typeof el.onload === 'function') el.onload(); }, 0);
    }
    return real(node) as T;
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

async function boot(attrs: Record<string, string>, identityFailure = 0, bootstrapFailure = false) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const k of ['__gs', '__gs_id', '__gs_api_base', '__gs_loaded', '__gs_loader_injected', '__gs_token', '__gs_runtime', '__gs_policy']) {
    delete win()[k];
  }
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.head.appendChild(el);
  win().__gs_id = 'ws-test';
  win().__gs_api_base = 'https://api.test';
  patchAppendChild(document.head);

  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes(IDENTITY_PATH)) {
      if (identityFailure) {
        const status = identityFailure;
        identityFailure = 0;
        return Promise.resolve({ ...jsonResponse({}), ok: false, status });
      }
      return Promise.resolve(jsonResponse({ ok: true, linked: true }));
    }
    if (u.includes(BOOTSTRAP_PATH)) {
      if (bootstrapFailure) return Promise.resolve({ ...jsonResponse({}), ok: false, status: 401 });
      return Promise.resolve(jsonResponse({ session_token: 'tok-1', workspace_id: 'ws-test', is_new_visitor: false, availability: { state: 'online' } }));
    }
    if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse({ enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default' }));
    return Promise.resolve(jsonResponse({}));
  });
  win().fetch = fetchMock;

  new Function(LOADER_SRC).call(window);
  await flush();
}

function bootstrapBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(BOOTSTRAP_PATH));
  expect(call, 'bootstrap was called').toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body));
}

const identityCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes(IDENTITY_PATH));

beforeEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a different person on the same browser', () => {
  it('a plain embed never asks for a fresh visitor', async () => {
    await boot({});
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
  });

  it('the first signed-in page keeps the visitor', async () => {
    await boot({ 'data-commerce-subject': 'uaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
  });

  it('the same person on the next page keeps the visitor', async () => {
    await boot({ 'data-commerce-subject': 'uaaaaaaaaaaaaaaaaaaaaaaaa' });
    await boot({ 'data-commerce-subject': 'uaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
  });

  it('logout and anonymous navigation keep the same conversation and visitor', async () => {
    await boot({ 'data-commerce-subject': 'uaaaaaaaaaaaaaaaaaaaaaaaa' });
    const view = JSON.stringify({ tab: 'chat', conversationId: 'existing-thread' });
    window.sessionStorage.setItem('gs:view:ws-test', view);
    document.cookie = 'gs_active=1; path=/';
    await boot({ 'data-commerce-subject': 'anon' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
    expect(window.sessionStorage.getItem('gs:view:ws-test')).toBe(view);
    expect(document.cookie).toContain('gs_active=1');
    expect(identityCalls()).toHaveLength(0);
    await boot({ 'data-commerce-subject': 'anon' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
    expect(window.sessionStorage.getItem('gs:view:ws-test')).toBe(view);
  });

  it('signing back in as the same user keeps the conversation', async () => {
    await boot({ 'data-commerce-subject': 'ualice' });
    await boot({ 'data-commerce-subject': 'anon' });
    await boot({ 'data-commerce-subject': 'ualice' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
  });

  it('a different user after logout still starts a fresh visitor', async () => {
    await boot({ 'data-commerce-subject': 'ualice' });
    await boot({ 'data-commerce-subject': 'anon' });
    expect(window.localStorage.getItem('gs:csub:ws-test')).toBe('ualice');
    await boot({ 'data-commerce-subject': 'ubob' });
    expect(bootstrapBody().fresh_visitor).toBe(true);
  });

  it('another user signing in starts a fresh visitor', async () => {
    await boot({ 'data-commerce-subject': 'uaaaaaaaaaaaaaaaaaaaaaaaa' });
    await boot({ 'data-commerce-subject': 'ubbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(bootstrapBody().fresh_visitor).toBe(true);
  });

  it('a guest who signs in keeps the visitor (nothing private was shown before)', async () => {
    await boot({ 'data-commerce-subject': 'anon' });
    await boot({ 'data-commerce-subject': 'uaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
  });
});

describe('binding the same grant again', () => {
  const page = { 'data-commerce-assertion': 'whmcs1.payload.signature-long-enough', 'data-commerce-binding': 'bind-1' };

  it('reconciles the WHMCS profile on each page even with the same grant', async () => {
    await boot(page);
    expect(identityCalls()).toHaveLength(1);
    await boot(page);
    expect(identityCalls()).toHaveLength(1);
  });

  it('binds again when the grant changed (new login, other account)', async () => {
    await boot(page);
    await boot({ ...page, 'data-commerce-binding': 'bind-2' });
    expect(identityCalls()).toHaveLength(1);
  });

  it('an assertion without a binding hint (WooCommerce) is posted on every page as before', async () => {
    await boot({ 'data-commerce-assertion': 'woo.assertion.value-long-enough' });
    await boot({ 'data-commerce-assertion': 'woo.assertion.value-long-enough' });
    expect(identityCalls()).toHaveLength(1);
  });
});


describe('identity transport recovery', () => {
  const page = { 'data-commerce-assertion': 'whmcs1.payload.signature-long-enough' };
  it('retries a transient sync failure without a page reload', async () => {
    await boot(page, 503);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(identityCalls()).toHaveLength(2);
  });
  it('does not retry invalid or cross-user assertions', async () => {
    await boot(page, 400);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(identityCalls()).toHaveLength(1);
  });
});


describe('account switch reset acknowledgement', () => {
  it('clears tab continuation and retries a failed identity reset on the next page', async () => {
    window.localStorage.setItem('gs:csub:ws-test', 'ualice');
    window.sessionStorage.setItem('gs:view:ws-test', JSON.stringify({ tab: 'chat', conversationId: 'private-thread' }));
    window.sessionStorage.setItem('gs:cbind:ws-test', 'old-binding');
    await boot({ 'data-commerce-subject': 'ubob' }, 0, true);
    expect(bootstrapBody().fresh_visitor).toBe(true);
    expect(window.sessionStorage.getItem('gs:view:ws-test')).toBeNull();
    expect(window.sessionStorage.getItem('gs:cbind:ws-test')).toBeNull();
    expect(window.localStorage.getItem('gs:csub:ws-test')).toBe('ualice');
    await boot({ 'data-commerce-subject': 'ubob' });
    expect(bootstrapBody().fresh_visitor).toBe(true);
    expect(window.localStorage.getItem('gs:csub:ws-test')).toBe('ubob');
    await boot({ 'data-commerce-subject': 'ubob' });
    expect(bootstrapBody()).not.toHaveProperty('fresh_visitor');
  });
});
