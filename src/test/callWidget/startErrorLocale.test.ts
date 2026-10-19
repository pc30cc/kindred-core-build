/**
 * A call that cannot start says so in the widget's language.
 *
 * public/call-widget/runtime.js printed the server's own `message` (or its
 * error code) for any refusal it had no mapping for: an English sentence or
 * a raw `snake_case` code in a Persian or Turkish widget. Every unmapped
 * refusal now reads `err_failed_start` in the active language; the mapped
 * ones (consent, department) keep their own sentence.
 *
 * The shipped runtime and default presentation in jsdom; `fetch` answers
 * the start request with the refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';

const source = (name: string) => readFileSync(resolve(process.cwd(), 'public/call-widget', name), 'utf8');

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };

function mount(
  locale: 'fa' | 'en' | 'tr',
  refusal: Record<string, unknown>,
  /** Answers a request before the default (refuse /calls/request, accept the rest); undefined: the default. */
  answer?: (url: string) => Promise<Answer> | undefined,
  /** Leave the widget on its first screen (the launcher opened), not the started call. */
  stay = false,
) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://customer.example/page',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & {
    eval(code: string): unknown;
    CallCenterWidget: { mount(options: unknown): void };
  };
  const requests: string[] = [];
  // Only what the runtime's api() reads of a response.
  Object.assign(win, {
    fetch: (url: string) => {
      requests.push(String(url));
      const own = answer?.(String(url));
      if (own) return own;
      const refused = String(url).includes('/calls/request');
      return Promise.resolve({
        ok: !refused,
        status: refused ? 402 : 200,
        json: () => Promise.resolve(refused ? refusal : {}),
      });
    },
  });
  win.eval(source('presentation-registry.js'));
  win.eval(source('presentation-default.js'));
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
      i18n: { default_locale: locale, available_locales: [locale] },
    },
  });
  const host = win.document.querySelector('#call-center-widget-host') as HTMLElement;
  const root = host.shadowRoot!.querySelector('.ccw-root') as HTMLElement;
  (root.querySelector('.ccw-launcher-btn') as HTMLButtonElement).click();
  if (!stay) (root.querySelector('.ccw-btn.primary') as HTMLButtonElement).click();
  return { root, requests, dom };
}

const FAILED_START = { fa: 'شروع تماس ناموفق بود.', en: 'Failed to start call.', tr: 'Arama başlatılamadı.' };

describe('a refused call start reads in the widget\'s language', () => {
  for (const locale of ['fa', 'en', 'tr'] as const) {
    it(`${locale}: an unmapped refusal with an English message`, async () => {
      const { root, requests } = mount(locale, { error: 'calls_minutes_exhausted', message: 'Monthly call minutes exhausted' });
      await vi.waitFor(() => expect(root.textContent).toContain(FAILED_START[locale]));
      expect(requests.some((u) => u.includes('/api/call-widget/calls/request'))).toBe(true);
      expect(root.textContent).not.toContain('Monthly call minutes exhausted');
      expect(root.textContent).not.toContain('calls_minutes_exhausted');
    });
  }

  it('an unmapped code without a message is not printed either', async () => {
    const { root } = mount('fa', { error: 'provider_unavailable' });
    await vi.waitFor(() => expect(root.textContent).toContain(FAILED_START.fa));
    expect(root.textContent).not.toContain('provider_unavailable');
  });

  it('a mapped refusal keeps its own sentence', async () => {
    const { root } = mount('fa', { error: 'department_not_found' });
    await vi.waitFor(() => expect(root.textContent).toContain('این دپارتمان برای این نوع تماس در دسترس نیست.'));
  });
});

describe('a failure that is not a refusal reads in the widget\'s language too', () => {
  for (const locale of ['fa', 'en', 'tr'] as const) {
    it(`${locale}: the start request never reaches the server (a network error)`, async () => {
      const { root } = mount(locale, {}, (url) => (url.includes('/calls/request') ? Promise.reject(new TypeError('Failed to fetch')) : undefined));
      await vi.waitFor(() => expect(root.textContent).toContain(FAILED_START[locale]));
      expect(root.textContent).not.toContain('Failed to fetch');
    });
  }

  it('a callback request refused with a code the widget has no sentence for', async () => {
    const refused = (url: string) => (url.includes('/callbacks/request')
      ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'callback_queue_full', message: 'The callback queue is full' }) })
      : undefined);
    const { root, dom } = mount('fa', {}, refused, true);
    (root.querySelector('.ccw-btn.ghost') as HTMLButtonElement).click();
    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('.ccw-error')?.textContent).toBe('ناموفق بود.'));
    expect(root.textContent).not.toContain('callback_queue_full');
    expect(root.textContent).not.toContain('The callback queue is full');
  });
});
