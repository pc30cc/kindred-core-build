/**
 * The settings page's "widget label overrides" (src/lib/callWidgetTexts.ts)
 * against the widget itself, in every language and in every state that
 * draws them (each launcher style, staffed or not, offline with and without
 * a callback, the home and offline screens):
 *
 *   - each field's placeholder is the widget's own copy;
 *   - an override reaches every place its key is drawn: wherever the
 *     widget's own copy of that key disappears, the override appears, and
 *     each key is drawn somewhere;
 *   - a text set for one language never shows in another.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WIDGET_TEXT_KEYS } from '@/lib/callWidgetTexts';
import { closeCallWidgets, mountCallWidget, type Locale, type Mounted } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const LOCALES: Locale[] = ['fa', 'en', 'tr'];
const OFFLINE = { capabilities: { voice: false, video: false } };
const SCENARIOS: Record<string, Record<string, unknown>> = {
  ...Object.fromEntries(['round_label', 'pill', 'card', 'split', 'edge_tab', 'dark_square'].map((style) => [`online ${style}`, { config: { launcher_style: style } }])),
  'online, nobody free': { config: { launcher_style: 'card' }, presence: { any_available: false } },
  'offline, callback': { ...OFFLINE, config: { launcher_style: 'card', offline_behavior: 'show_callback' } },
  'offline, callback, split': { ...OFFLINE, config: { launcher_style: 'split', offline_behavior: 'show_callback' } },
  'offline, message': { ...OFFLINE, config: { launcher_style: 'card', offline_behavior: 'show_message' } },
  'offline, no callback': { capabilities: { voice: false, video: false, callback: false }, config: { launcher_style: 'pill', offline_behavior: 'show_callback' } },
  'no display name': { config: { display_name: null } },
};

const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object'
      ? merge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
};

/** What a visitor can read or hear: the launcher and the open panel's words, and their accessible names. */
function visible(m: Mounted): string {
  const parts: string[] = [];
  const add = (el: Element | null) => {
    if (!el) return;
    parts.push(el.textContent || '');
    el.querySelectorAll('[aria-label],[title],[placeholder]').forEach((n) => {
      for (const a of ['aria-label', 'title', 'placeholder']) if (n.getAttribute(a)) parts.push(n.getAttribute(a)!);
    });
  };
  add(m.q('.ccw-launcher-wrap'));
  add(m.screen());
  return parts.join('\n');
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function render(locale: Locale, scenario: Record<string, unknown>, texts: Record<string, Record<string, string>>): string {
  const m = mountCallWidget({ locale, bootstrap: merge(scenario, { config: { custom_texts: texts } }) });
  const launcher = visible(m);
  // The split launcher has no single button: its halves start a call, so the panel opens as the engine opens it.
  if (m.q('.ccw-launcher-btn')) m.open();
  else { (m.ctrl as unknown as { toggleOpen(): void }).toggleOpen(); m.loadLinks(); }
  return launcher + '\n' + visible(m);
}

describe('the texts editor matches the widget', () => {
  it.each(LOCALES)('%s: every placeholder is the widget\'s own copy', (locale) => {
    const m = mountCallWidget({ locale });
    for (const { key, placeholder } of WIDGET_TEXT_KEYS) expect([key, placeholder[locale]]).toEqual([key, m.ctrl.t(key)]);
  });

  it('every key is listed once', () => {
    const keys = WIDGET_TEXT_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe.each(LOCALES)('%s', (locale) => {
    let base: Record<string, string> | null = null;
    const own = () => (base ??= Object.fromEntries(Object.entries(SCENARIOS).map(([name, sc]) => [name, render(locale, sc, {})])));
    it.each(WIDGET_TEXT_KEYS.map((k) => k.key))('%s reaches every place it is drawn', (key) => {
      const before = own();
      const def = mountCallWidget({ locale }).ctrl.t(key);
      const mark = `«${key}»`;
      let drawn = 0;
      for (const [name, sc] of Object.entries(SCENARIOS)) {
        const after = render(locale, sc, { [locale]: { [key]: mark } });
        const shown = count(after, mark);
        // Every copy of the key the widget drew is now the owner's words.
        expect({ name, replaced: count(before[name], def) - count(after, def) }).toEqual({ name, replaced: shown });
        drawn += shown;
      }
      expect(drawn, `${key} is drawn in no state`).toBeGreaterThan(0);
    });
  });

  it('a text set for another language never shows', () => {
    const after = render('fa', SCENARIOS['online card'], { en: { talk_to_team: '«en-only»' } });
    expect(after).not.toContain('«en-only»');
  });

  it('the dashboard preview shows the language it is given, never one a visitor stored', () => {
    const setup = (win: Mounted['win']) => win.localStorage.setItem('ccw_locale', 'en');
    const preview = mountCallWidget({ locale: 'fa', bootstrap: { i18n: { default_locale: 'fa', available_locales: ['fa', 'en'] } }, setup });
    expect(preview.ctrl.locale).toBe('fa');
    // Switching languages in the preview stores nothing for the visitor's page.
    preview.win.localStorage.removeItem('ccw_locale');
    preview.ctrl.setLocale('en');
    expect(preview.ctrl.locale).toBe('en');
    expect(preview.win.localStorage.getItem('ccw_locale')).toBeNull();
  });
});
