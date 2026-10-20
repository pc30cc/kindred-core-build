/**
 * The home badge tells the same truth as the header (D17). With the channels
 * on and an operator available it reads "Live now" over a live dot and lists
 * the channels; with the channels on and nobody available (calls still
 * queue, the tiles stay) it must not say "Live now" over an off dot while
 * the header says no operator is available: it reads the header's
 * `no_operator_now`, and the channel list makes room for it (the sentence and
 * the list do not fit one 28px badge line in Persian or English; the tiles
 * below still name the channels). Both brands, every locale, and the switch
 * both ways when presence changes on an open panel.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeCallWidgets, mountCallWidget, type Locale, type Mounted } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const NOW = Date.parse('2026-10-22T11:00:00+03:30');
const BRANDS = {
  webyar: {},
  respok: { bootstrap: { config: { widget_template_id: 'intl' } }, edition: 'international' as const },
};
const LOCALES: Locale[] = ['fa', 'en', 'tr'];
/** The strings the engine's tables hold (runtime.js I18N), for the reader of a failure. */
const WORDS: Record<Locale, { live: string; none: string }> = {
  fa: { live: 'آنلاین', none: 'فعلاً اپراتوری در دسترس نیست' },
  en: { live: 'Live now', none: 'No operator available right now' },
  tr: { live: 'Canlı', none: 'Şu anda müsait operatör yok' },
};

function openHome(brand: keyof typeof BRANDS, locale: Locale, anyAvailable: boolean): Mounted {
  const b = BRANDS[brand] as { bootstrap?: { config?: Record<string, unknown> }; edition?: 'international' };
  const m = mountCallWidget({
    ...b, now: NOW, locale,
    bootstrap: { ...(b.bootstrap ?? {}), presence: { any_available: anyAvailable } },
  });
  m.open();
  expect(m.screenId()).toBe('home');
  return m;
}

const badge = (m: Mounted) => m.q('[data-screen="home"] .badge')!;
/** The badge's status words: everything in it but the channel list. */
function status(m: Mounted): string {
  return [...badge(m).childNodes]
    .filter((n) => !(n instanceof m.win.Element && n.classList.contains('chn')))
    .map((n) => n.textContent)
    .join('')
    .trim();
}
const shown = (el: Element | null) => !!el && !el.hasAttribute('hidden');
const t = (m: Mounted, key: string) => (m.ctrl as unknown as { t(k: string): string }).t(key);

for (const brand of Object.keys(BRANDS) as Array<keyof typeof BRANDS>) {
  describe(`${brand}: the home badge agrees with the header`, () => {
    it.each(LOCALES)('%s: staffed, "live now" over a live dot, with the channels', (locale) => {
      const m = openHome(brand, locale, true);
      expect(t(m, 'live_now')).toBe(WORDS[locale].live);
      expect(status(m)).toBe(WORDS[locale].live);
      expect(m.q('[data-screen="home"] .badge .dot')!.classList.contains('off')).toBe(false);
      expect(shown(m.q('[data-screen="home"] .badge .sep'))).toBe(true);
      expect(shown(m.q('[data-screen="home"] .badge .chn'))).toBe(true);
      expect(m.q('[data-screen="home"] .badge .chn')!.textContent).not.toBe('');
    });

    it.each(LOCALES)('%s: online but unstaffed, the header\'s "no operator now" over an off dot, no channel list', (locale) => {
      const m = openHome(brand, locale, false);
      const header = m.q('[data-screen="home"] .hd .st')!.textContent;
      expect(header).toBe(WORDS[locale].none);
      expect(t(m, 'no_operator_now')).toBe(WORDS[locale].none);
      expect(status(m)).toBe(header);
      expect(status(m)).not.toContain(WORDS[locale].live);
      expect(m.q('[data-screen="home"] .badge .dot')!.classList.contains('off')).toBe(true);
      expect(shown(m.q('[data-screen="home"] .badge .sep'))).toBe(false);
      expect(shown(m.q('[data-screen="home"] .badge .chn'))).toBe(false);
      // The call tiles stay: calls still queue (D17).
      expect(m.qa('[data-screen="home"] .opts .opt')).toHaveLength(2);
    });

    it('follows presence both ways on the open panel, in place (same badge node)', () => {
      const m = openHome(brand, 'en', true);
      const node = badge(m);
      const boot = (m.ctrl as unknown as { bootstrap: Record<string, unknown> }).bootstrap;
      boot.presence = { any_available: false };
      m.set({});
      expect(badge(m)).toBe(node);
      expect(status(m)).toBe(WORDS.en.none);
      expect(shown(m.q('[data-screen="home"] .badge .chn'))).toBe(false);
      boot.presence = { any_available: true };
      m.set({});
      expect(badge(m)).toBe(node);
      expect(status(m)).toBe(WORDS.en.live);
      expect(shown(m.q('[data-screen="home"] .badge .chn'))).toBe(true);
    });
  });
}
