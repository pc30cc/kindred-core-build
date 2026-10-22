/**
 * W-10: a widget without a colour of its own (the seeded #3B82F6 on the
 * wire, shared/widgetColor.ts) wears its kit button's colour in the panel
 * too, so the button and the panel agree: the Iran kit's deep turquoise, RESPOK's
 * Ink; without a kit the product blue as before. A chosen colour is used as
 * it is. The default renderer paints a visitor's bubble with the panel's
 * accent (its stylesheet), never an inline copy of the raw colour.
 *
 * Boots the shipped loader.js in jsdom (as localKitLauncher.test.ts does).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { widgetBrandColor } from '../../../shared/widgetColor';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER_SRC = read('public/widget/loader.js');

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function boot(config: Record<string, unknown>) {
  (window as unknown as Record<string, unknown>).__gs_id = 'ws-test';
  (window as unknown as Record<string, unknown>).__gs_api_base = 'https://api.test';
  (window as unknown as { fetch: unknown }).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse({ session_token: 't', workspace_id: 'ws-test', availability: { state: 'online' } }));
    if (u.includes('/api/widget/config')) {
      return Promise.resolve(jsonResponse({ enabled: true, features: { chat: true }, templateId: 'default', locale: 'fa', fab: {}, ...config }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  new Function(LOADER_SRC).call(window);
  await flush();
  const root = document.querySelector('gs-widget')!.shadowRoot!;
  const shell = root.querySelector('.shell') as HTMLElement;
  return { accent: shell.style.getPropertyValue('--gs-primary'), launcher: root.querySelector('.launcher') as HTMLButtonElement };
}

/** A fresh page: no widget, no loader state. */
function reset() {
  document.body.innerHTML = '';
  for (const key of Object.keys(window)) {
    if (key.indexOf('__gs') === 0) delete (window as unknown as Record<string, unknown>)[key];
  }
}

beforeEach(() => {
  vi.useRealTimers();
  reset();
});
afterEach(() => vi.restoreAllMocks());

describe('the panel\'s accent', () => {
  it('Iranian edition, no colour of its own: the kit\'s deep turquoise, beside the kit\'s gradient button', async () => {
    for (const primaryColor of ['#3B82F6', '#3b82f6', '']) {
      const { accent, launcher } = await boot({ edition: 'iran', primaryColor });
      expect(accent.toUpperCase(), primaryColor).toBe(widgetBrandColor('iran'));
      expect(launcher.classList.contains('lk-kit-brand'), primaryColor).toBe(true);
      reset();
    }
  });

  it('International edition (RESPOK\'s button), no colour of its own: Ink', async () => {
    const { accent, launcher } = await boot({ edition: 'international', templateId: 'intl', primaryColor: '#3B82F6' });
    expect(accent.toUpperCase()).toBe(widgetBrandColor('respok'));
    expect(launcher.classList.contains('rpk-kit-brand')).toBe(true);
  });

  it('no kit: the product blue, as before', async () => {
    const { accent } = await boot({ primaryColor: '#3B82F6' });
    expect(accent.toUpperCase()).toBe(widgetBrandColor(null));
  });

  it('a chosen colour is the button\'s and the panel\'s, in every edition', async () => {
    for (const edition of ['iran', 'international', null]) {
      const { accent, launcher } = await boot({ edition, primaryColor: '#EF4444' });
      expect(accent.toUpperCase(), String(edition)).toBe('#EF4444');
      expect(launcher.classList.contains('lk-kit-brand') || launcher.classList.contains('rpk-kit-brand'), String(edition)).toBe(false);
      reset();
    }
  });
});

describe('the default renderer\'s visitor bubble', () => {
  it('wears the panel\'s accent from its stylesheet, never an inline raw colour', () => {
    new Function(read('public/widget/presentation-default.js')).call(window);
    const mod = (window as unknown as Record<string, { create: (env: unknown) => { messagesHtml: (s: unknown, x: string, v: unknown) => string } }>).__gs_presentation_default;
    const R = mod.create({ t: (k: string) => k, escapeHtml: (s: string) => s, config: {}, locale: 'fa', primaryColor: '#3B82F6', capabilities: {} });
    const html = R.messagesHtml({ messages: [{ sender: 'visitor', senderType: 'visitor', body: 'سلام', time: new Date().toISOString(), status: 'sent' }] }, '', {});
    const page = new DOMParser().parseFromString(html, 'text/html');
    const bubble = page.querySelector('.msg.visitor')!;
    expect(bubble).not.toBeNull();
    expect(bubble.getAttribute('style')).toBeNull();
    expect(read('public/widget/presentation-default.css')).toMatch(/\.msg\.visitor \{ background: var\(--wy-accent\);/);
  });
});
