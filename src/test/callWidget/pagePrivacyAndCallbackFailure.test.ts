/**
 * The call center widget (public/call-widget/runtime.js):
 *
 *  - The page it sends with a call or a callback (`page_url`) has no
 *    fragment and no credential or contact detail in its query, whatever the
 *    case of the name (shared/pageUrlPrivacy.ts; the server strips them again
 *    before storing). It sent `location.href` as it was.
 *  - A callback request that never gets an answer it can read (a network
 *    error, a 503 page that is not JSON) says so in the widget's language and
 *    keeps the form; it used to leave the form as if nothing had happened.
 *
 * The runtime, the core presentation and its panel module in jsdom, as in
 * startErrorLocale.test.ts; `fetch` records every request body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';

const source = (name: string) => readFileSync(resolve(process.cwd(), 'public/call-widget', name), 'utf8');

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const doms: JSDOM[] = [];
afterEach(() => { while (doms.length) doms.pop()!.window.close(); });

function mount(url: string, answer?: (url: string) => Promise<Answer> | undefined) {
  const dom = new JSDOM('<!doctype html><body></body>', { url, runScripts: 'outside-only' });
  doms.push(dom);
  const win = dom.window as unknown as Window & {
    eval(code: string): unknown;
    CallCenterWidget: { mount(options: unknown): void };
  };
  const bodies: Record<string, Record<string, unknown>> = {};
  Object.assign(win, {
    fetch: (u: string, init?: { body?: string }) => {
      const path = new URL(String(u)).pathname;
      if (init && init.body) bodies[path] = JSON.parse(init.body);
      const own = answer?.(String(u));
      if (own) return own;
      // Hold the call where it is once asked for: nothing past the request is under test.
      if (path.endsWith('/calls/request')) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
  });
  win.eval(source('presentation-registry.js'));
  win.eval(source('presentation-default.js'));
  win.eval(source('presentation-default-panel.js'));
  win.eval(source('runtime.js'));
  win.CallCenterWidget.mount({
    apiBase: 'https://api.example',
    origin: 'https://api.example',
    bootstrap: {
      status: 'ok',
      provider_ready: true,
      session: 'sess-1',
      config: {
        widget_template_id: 'default',
        widget_position: 'right',
        offline_behavior: 'show_callback',
        pre_call_form_enabled: false,
        pre_call_form_schema: [],
      },
      capabilities: { voice: true, video: false, callback: true },
      callback_policy: { enabled: true, show_when_online: true },
      recording: { effective_enabled: false },
      departments: { voice: [], video: [], callback: [] },
      i18n: { default_locale: 'fa', available_locales: ['fa'] },
    },
  });
  const host = win.document.querySelector('#call-center-widget-host') as HTMLElement;
  const root = host.shadowRoot!.querySelector('.ccw-root') as HTMLElement;
  (root.querySelector('.ccw-launcher-btn') as HTMLButtonElement).click();
  return { root, bodies, dom };
}

function submitCallback(root: HTMLElement, dom: JSDOM) {
  (root.querySelector('[data-screen="home"] [data-action="callback"]') as HTMLButtonElement).click();
  (root.querySelector('[data-action="continue"]') as HTMLButtonElement).click();
  const form = root.querySelector('[data-screen="callback"] form') as HTMLFormElement;
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

const PAGE = 'https://customer.example/checkout?step=2&Token=abc&reset_token=x&PHONE=0912&utm_source=ad#access_token=y';
const CLEAN = 'https://customer.example/checkout?step=2&utm_source=ad';

describe('the page sent with a call or a callback', () => {
  it('a call: no fragment, no sensitive parameter whatever its case', async () => {
    const { root, bodies } = mount(PAGE);
    (root.querySelector('[data-action="voice"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(bodies['/api/call-widget/calls/request']).toBeTruthy());
    expect(bodies['/api/call-widget/calls/request'].page_url).toBe(CLEAN);
  });

  it('a callback: the same', async () => {
    const { root, bodies, dom } = mount(PAGE);
    submitCallback(root, dom);
    await vi.waitFor(() => expect(bodies['/api/call-widget/callbacks/request']).toBeTruthy());
    expect(bodies['/api/call-widget/callbacks/request'].page_url).toBe(CLEAN);
  });

  it('a page with nothing to drop is sent as it is', async () => {
    const { root, bodies } = mount('https://customer.example/p?q=1');
    (root.querySelector('[data-action="voice"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(bodies['/api/call-widget/calls/request']).toBeTruthy());
    expect(bodies['/api/call-widget/calls/request'].page_url).toBe('https://customer.example/p?q=1');
  });
});

describe('a callback request without a readable answer', () => {
  const TRY_AGAIN = 'لطفاً دوباره تلاش کنید.';

  it('a network error: the widget\'s own sentence, and the form stays', async () => {
    const { root, dom } = mount('https://customer.example/page', (u) => (u.includes('/callbacks/request') ? Promise.reject(new TypeError('Failed to fetch')) : undefined));
    submitCallback(root, dom);
    await vi.waitFor(() => expect(root.querySelector('[data-screen="callback"] [data-error]')?.textContent).toBe(TRY_AGAIN));
    expect(root.textContent).not.toContain('Failed to fetch');
  });

  it('an answer that is not JSON (a 503 page)', async () => {
    const notJson = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
    const { root, dom } = mount('https://customer.example/page', (u) => (u.includes('/callbacks/request') ? notJson() : undefined));
    submitCallback(root, dom);
    await vi.waitFor(() => expect(root.querySelector('[data-screen="callback"] [data-error]')?.textContent).toBe(TRY_AGAIN));
    expect(root.textContent).not.toContain('Unexpected token');
  });
});
