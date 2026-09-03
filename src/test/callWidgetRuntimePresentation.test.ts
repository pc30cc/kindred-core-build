import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';

const source = (name: string) => readFileSync(resolve(process.cwd(), 'public/call-widget', name), 'utf8');

function mount(config: Record<string, unknown>, online = true) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://customer.example/page',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & {
    eval(code: string): unknown;
    CallCenterWidget: { mount(options: unknown): void };
  };
  win.eval(source('presentation-registry.js'));
  win.eval(source('presentation-default.js'));
  win.eval(source('runtime.js'));
  win.CallCenterWidget.mount({
    apiBase: 'https://api.example',
    origin: 'https://api.example',
    preview: true,
    bootstrap: {
      status: 'ok',
      provider_ready: true,
      session: 'preview',
      config: {
        widget_template_id: 'default',
        widget_position: 'right',
        offline_behavior: 'show_callback',
        pre_call_form_enabled: true,
        pre_call_form_schema: [],
        ...config,
      },
      capabilities: { voice: online, video: false, callback: true },
      callback_policy: { enabled: true, show_when_online: true },
      recording: { effective_enabled: false },
      departments: { voice: [], video: [], callback: [] },
      i18n: { default_locale: 'en', available_locales: ['en'] },
    },
  });
  const host = win.document.querySelector('#call-center-widget-host') as HTMLElement;
  return { dom, root: host.shadowRoot!.querySelector('.ccw-root') as HTMLElement };
}

describe('Call Widget runtime/presentation integration', () => {
  beforeEach(() => {
    // Every test gets an isolated Window because the public runtime is an IIFE singleton.
  });

  it('mounts the default presentation and applies allowlisted theme tokens', () => {
    const { root } = mount({ widget_theme: { primary: '#ff0000', radius: 'lg', density: 'compact' } });
    expect(root.classList.contains('ccw-presentation-default')).toBe(true);
    expect(root.style.getPropertyValue('--ccw-primary')).toBe('0 100% 50%');
    expect(root.dataset.radius).toBe('lg');
    expect(root.dataset.density).toBe('compact');
  });

  it.each([
    ['hide', false, false],
    ['show_message', true, false],
    ['show_callback', true, true],
  ])('enforces offline behavior %s', (behavior, launcher, callback) => {
    const { root } = mount({ offline_behavior: behavior }, false);
    expect(!!root.querySelector('.ccw-launcher')).toBe(launcher);
    expect(!!root.querySelector('.ccw-btn.primary')).toBe(callback);
  });

  it('uses the authoritative pre-call schema', () => {
    const { root } = mount({
      pre_call_form_schema: [{ id: 'account_id', type: 'text', label: 'Account ID', required: true }],
    });
    const voice = root.querySelector('.ccw-btn.primary') as HTMLButtonElement;
    voice.click();
    expect(root.textContent).toContain('Account ID');
    expect(root.textContent).not.toContain('Full name');
  });
});
