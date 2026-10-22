/**
 * S-04: the Super Admin's "Powered by" preview shows what visitors see.
 *
 *   - shared/poweredByCredit.ts holds the widget's own words, which are the
 *     runtime dictionary's (public/widget/runtime.js, evaluated here), and
 *     the renderers' rule: the default renderer, painting a real footer,
 *     shows exactly the prefix poweredByPrefixFor gives, for a Latin and a
 *     Persian prefix in a Persian and an English widget;
 *   - PoweredBySection (Super Admin → Widget settings → Powered by) lists the
 *     credit per widget language with that rule: a prefix typed in one script
 *     falls back to the widget's own word in the other languages; the
 *     edition's logo stands in the name's place where the widget draws one;
 *     with the master switch off it says no widget shows the credit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import { POWERED_BY_WIDGET_WORDS, poweredByPrefixFor } from '../../../shared/poweredByCredit';
import { INTL_BRAND } from '../../../shared/internationalMode';

const flags = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international' | null,
  locales: ['fa', 'en', 'tr'] as string[],
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: flags.edition, isInternational: flags.edition === 'international', ready: true }),
  useKnownEdition: () => flags.edition,
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'multi', allowedLocales: flags.locales, canSwitchLanguage: true, currency: 'USD' }),
}));
vi.mock('@/features/branding/BrandingContext', () => ({ useBrandingContext: () => ({ branding: null, platformName: 'Acme' }) }));

const { PoweredBySection } = await import('@/pages/admin/widget-settings/PoweredBySection');
const { WidgetLivePreview } = await import('@/components/app/widget/WidgetLivePreview');

const read = (file: string) => readFileSync(resolve(process.cwd(), 'public/widget', file), 'utf8');
const RUNTIME = read('runtime.js');

beforeEach(() => {
  flags.edition = 'iran';
  flags.locales = ['fa', 'en', 'tr'];
});
afterEach(cleanup);

/** The runtime's own words, as the widget looks them up. */
function runtimeWord(locale: string, key: string): string {
  const page = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = page.window as unknown as { eval: (s: string) => void; __gs_runtime: { t: (l: string, k: string) => string } };
  w.eval(RUNTIME);
  return w.__gs_runtime.t(locale, key);
}

/** The default renderer's footer prefix for a widget in `locale` with the platform's `text`. */
function renderedPrefix(locale: 'fa' | 'en', text: string): string {
  const { container } = render(
    <WidgetLivePreview
      settings={{ widget_language: locale }}
      brandName="Shop"
      view="home"
      templateId="default"
      templateOptions={{}}
      poweredBy={{ text, brand: 'Acme', url: null }}
    />,
  );
  const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
  cleanup();
  const page = new JSDOM(doc, { runScripts: 'outside-only' });
  const w = page.window as unknown as Record<string, unknown> & { eval: (s: string) => void };
  w.eval(RUNTIME);
  w.eval(Array.from((page.window.document as Document).querySelectorAll('script:not([src])')).map((s) => s.textContent).join('\n'));
  w.eval(read('presentation-default.js'));
  (w as unknown as { gsRenderPreview: (mod: unknown) => void }).gsRenderPreview(w.__gs_presentation_default);
  const span = page.window.document.querySelector('.wy-powered span');
  // Without a logo the span reads "<prefix> <name>".
  return (span?.textContent || '').replace(/\s*Acme\s*$/, '').trim();
}

describe('the credit\'s words are the widget\'s', () => {
  it('the shared words are the runtime dictionary\'s', () => {
    for (const locale of Object.keys(POWERED_BY_WIDGET_WORDS) as Array<keyof typeof POWERED_BY_WIDGET_WORDS>) {
      expect(runtimeWord(locale, 'poweredBy'), locale).toBe(POWERED_BY_WIDGET_WORDS[locale]);
    }
  });

  it('the default renderer shows the prefix the shared rule gives', () => {
    flags.edition = null; // no logo: the name follows the prefix
    for (const locale of ['fa', 'en'] as const) {
      for (const text of ['Built with', 'ساخته‌شده با', '']) {
        expect(renderedPrefix(locale, text), `${locale} "${text}"`).toBe(poweredByPrefixFor(text, locale));
      }
    }
    expect(poweredByPrefixFor('Built with', 'fa')).toBe('با فناوری');
    expect(poweredByPrefixFor('ساخته‌شده با', 'fa')).toBe('ساخته‌شده با');
    expect(poweredByPrefixFor('ساخته‌شده با', 'tr')).toBe('Sağlayan');
  });
});

const ROW = {
  powered_by_enabled: true,
  powered_by_text: 'Built with',
  powered_by_brand_text: 'Acme Cloud',
  powered_by_url: null,
} as never;

function section(settings = ROW) {
  render(
    <I18nProvider initialLocale="en" initialTranslations={en}>
      <PoweredBySection settings={settings} onSave={vi.fn()} saving={false} />
    </I18nProvider>,
  );
  return () => document.querySelector('[data-powered-preview]') as HTMLElement;
}
const row = (preview: HTMLElement, lang: string) => preview.querySelector(`[data-powered-preview-locale="${lang}"]`) as HTMLElement;

describe('Super Admin → Widget settings → Powered by: the preview', () => {
  it('one line per widget language, each with the prefix that language gets', () => {
    flags.edition = null;
    const preview = section();
    expect(within(row(preview(), 'en')).getByText('Built with')).toBeTruthy();
    expect(row(preview(), 'fa').querySelector('[data-powered-prefix]')!.textContent).toBe('با فناوری');
    expect(row(preview(), 'tr').querySelector('[data-powered-prefix]')!.textContent).toBe('Built with');
    expect(row(preview(), 'fa').querySelector('[data-powered-brand]')!.textContent).toBe('Acme Cloud');

    // A Persian prefix: Persian keeps it, English and Turkish fall back.
    fireEvent.change(screen.getByPlaceholderText('Powered by'), { target: { value: 'ساخته‌شده با' } });
    expect(row(preview(), 'fa').querySelector('[data-powered-prefix]')!.textContent).toBe('ساخته‌شده با');
    expect(row(preview(), 'en').querySelector('[data-powered-prefix]')!.textContent).toBe('Powered by');
    expect(row(preview(), 'tr').querySelector('[data-powered-prefix]')!.textContent).toBe('Sağlayan');
  });

  it('only the platform\'s languages', () => {
    flags.edition = null;
    flags.locales = ['fa'];
    const preview = section();
    expect(preview().querySelectorAll('[data-powered-preview-locale]')).toHaveLength(1);
  });

  it('the International edition shows the logo the widget draws, the name as its alt text', () => {
    flags.edition = 'international';
    const preview = section();
    const logo = row(preview(), 'en').querySelector('[data-powered-logo]') as HTMLImageElement;
    expect(logo.getAttribute('src')).toBe(INTL_BRAND.horizontal.light);
    expect(logo.getAttribute('alt')).toBe('Acme Cloud');
    expect(row(preview(), 'en').querySelector('[data-powered-brand]')).toBeNull();
  });

  it('without a brand name of its own, the platform\'s name', () => {
    flags.edition = null;
    const preview = section({ ...(ROW as object), powered_by_brand_text: null } as never);
    expect(row(preview(), 'en').querySelector('[data-powered-brand]')!.textContent).toBe('Acme');
  });

  it('the master switch off: no widget shows it, and the preview says so', () => {
    const preview = section({ ...(ROW as object), powered_by_enabled: false } as never);
    expect(preview().querySelector('[data-powered-preview-off]')!.textContent).toBe(en.admin.widgetSettingsPage.poweredBy.previewOff);
    expect(preview().querySelectorAll('[data-powered-preview-locale]')).toHaveLength(0);
  });
});
