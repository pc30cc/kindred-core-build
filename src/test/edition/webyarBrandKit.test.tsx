/**
 * WebYar's official brand kit (shared/webyarBrand.ts) is the Iranian
 * edition's ONLY: `platform_settings.region_mode = 'iran'`. Every other
 * region mode (multi, global, turkey — the International edition, RESPOK)
 * and an edition that is not known keep exactly what they showed before.
 * The Iranian edition is Persian-only, so only the Persian logotype is used.
 *
 * Covers: the shared rule and its files, the browser's head tags
 * (PlatformBrandingGate), the PWA manifest's choice, and the "powered by"
 * credit of the chat widget (presentation-default.js + widget.ts) and of the
 * call widget (runtime.js + callWidget.ts).
 *
 * The launcher (floating button) is covered by
 * src/test/widget/webyarLauncher.test.ts; the boot splash and the panel's
 * marks by phase5Brand.test.tsx and themes/internationalMode.test.tsx.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({ data: state.data }),
  fetchPlatformPublicConfig: () => Promise.resolve(state.data),
}));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'fa', dir: 'rtl', t: (key: string) => key }),
  useTranslation: () => ({ locale: 'fa', dir: 'rtl', t: (key: string) => key }),
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false }));

import { WEBYAR_BRAND, isUncustomisedColor, isWebyarKitEdition } from '../../../shared/webyarBrand';
import { __resetEditionForTests } from '@/lib/edition';
import { PlatformBrandingGate } from '@/features/branding/PlatformBrandingGate';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const config = (regionMode: string | null, branding: Record<string, unknown> = {}) => ({
  branding: { logo_url: null, favicon_url: null, pwa_icon_url: null, primary_color: '#3B82F6', pwa_enabled: true, pwa_short_name: null, ...branding },
  localized: [],
  region: { region_mode: regionMode, active_locales: null, default_locale: null, site_mode: 'single_language' },
  brand: null,
});

beforeEach(() => {
  state.data = undefined;
  localStorage.clear();
  __resetEditionForTests();
});

describe('the rule and the files', () => {
  it('is the Iranian edition only: never another region mode, never an unknown edition', () => {
    expect(isWebyarKitEdition('iran')).toBe(true);
    for (const v of ['international', 'multi', 'global', 'turkey', null, undefined, '', 'IRAN', 42]) {
      expect(isWebyarKitEdition(v), String(v)).toBe(false);
    }
  });

  it('treats only the seeded #3B82F6 (or nothing) as "no colour chosen"', () => {
    for (const v of [null, undefined, '', '#3B82F6', '#3b82f6', ' #3B82F6 ']) expect(isUncustomisedColor(v)).toBe(true);
    for (const v of ['#0B7D6C', '#E11D48', 'red']) expect(isUncustomisedColor(v)).toBe(false);
  });

  it('ships every file it names, Persian logotype only', () => {
    const files = [WEBYAR_BRAND.logo.light, WEBYAR_BRAND.logo.dark, WEBYAR_BRAND.symbol, WEBYAR_BRAND.favicon, WEBYAR_BRAND.appleTouchIcon,
      WEBYAR_BRAND.maskIcon, WEBYAR_BRAND.ogImage, WEBYAR_BRAND.pwa192, WEBYAR_BRAND.pwa512, WEBYAR_BRAND.pwaMaskable];
    for (const file of files) {
      expect(file.startsWith('/brand/webyar/'), file).toBe(true);
      expect(existsSync(resolve(process.cwd(), `public${file}`)), file).toBe(true);
      expect(file).not.toMatch(/latin/);
    }
    expect(WEBYAR_BRAND.themeColor).toBe('#0B7D6C');
    // The SVGs are plain artwork: nothing executable.
    for (const svg of files.filter((f) => f.endsWith('.svg'))) {
      expect(read(`public${svg}`)).not.toMatch(/<script|\son[a-z]+=|href=/i);
    }
  });

  it('index.html mirrors the shared paths', () => {
    const html = read('index.html');
    for (const p of [WEBYAR_BRAND.logo.light, WEBYAR_BRAND.logo.dark, WEBYAR_BRAND.favicon, WEBYAR_BRAND.appleTouchIcon, WEBYAR_BRAND.maskIcon, WEBYAR_BRAND.ogImage]) {
      expect(html).toContain(p);
    }
    // The static head is unchanged: the kit is applied only once the edition is known.
    expect(html).toContain('<link rel="icon" href="/favicon.png" type="image/png" />');
    expect(html).toContain('<meta name="theme-color" content="#3B82F6" />');
  });
});

describe('PlatformBrandingGate (head tags)', () => {
  function mount() {
    document.head.innerHTML = '<link rel="icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#3B82F6">';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><PlatformBrandingGate><span>app</span></PlatformBrandingGate></QueryClientProvider>);
    const q = (sel: string, attr: string) => document.head.querySelector(sel)?.getAttribute(attr) ?? null;
    return {
      icon: () => q('link[rel="icon"]', 'href'),
      touch: () => q('link[rel="apple-touch-icon"]', 'href'),
      theme: () => q('meta[name="theme-color"]', 'content'),
      mask: () => q('link[rel="mask-icon"]', 'href'),
      og: () => q('meta[property="og:image"]', 'content'),
    };
  }

  it('Iran: the kit\'s favicon, touch icon, mask icon, theme colour and share image', async () => {
    state.data = config('iran');
    const h = mount();
    await waitFor(() => expect(h.icon()).toBe(WEBYAR_BRAND.favicon));
    expect(h.touch()).toBe(WEBYAR_BRAND.appleTouchIcon);
    expect(h.theme()).toBe('#0B7D6C');
    expect(h.mask()).toBe(WEBYAR_BRAND.maskIcon);
    expect(h.og()).toBe(WEBYAR_BRAND.ogImage);
  });

  it('Iran: an operator\'s own favicon / PWA icon / colour still win, in the old order', async () => {
    state.data = config('iran', { favicon_url: 'https://cdn.example/fav.png', pwa_icon_url: 'https://cdn.example/pwa.png', primary_color: '#E11D48' });
    const h = mount();
    await waitFor(() => expect(h.icon()).toBe('https://cdn.example/fav.png'));
    expect(h.touch()).toBe('https://cdn.example/pwa.png');
    expect(h.theme()).toBe('#E11D48');
  });

  it.each(['multi', 'global', 'turkey'])('%s: none of the kit, as before', async (mode) => {
    state.data = config(mode);
    const h = mount();
    await waitFor(() => expect(h.icon()).toBe('/brand/intl/favicon.svg'));
    expect(h.theme()).toBe('#3B82F6');
    expect(h.mask()).toBeNull();
    expect(h.og()).toBeNull();
    expect(document.head.innerHTML).not.toContain('/brand/webyar/');
  });
});

describe('the PWA manifest', () => {
  const manifest = read('server/routes/manifest.ts');
  it('uses the kit\'s icons only in Iran and only without an operator icon', () => {
    expect(manifest).toContain('const webyarKit = isWebyarKitEdition(edition);');
    expect(manifest).toMatch(/: webyarKit && !operatorIcon\s*\?\s*\[\s*\{ src: onApp\(WEBYAR_BRAND\.pwa192\)/);
    expect(manifest).toMatch(/const icons = international\s*\?/);
    expect(manifest).toContain("(b.primary_color as string | null) || '#3B82F6'");
    expect(manifest).toContain('webyarKit && isUncustomisedColor(b.primary_color)');
  });
});

describe('chat widget "powered by"', () => {
  function footer(templateId: 'default' | 'intl', poweredBy: Record<string, unknown>, locale = 'fa') {
    new Function(read('public/widget/presentation-registry.js')).call(window);
    new Function(read('public/widget/presentation-default.js')).call(window);
    const reg = (window as unknown as { __gs_presentation_registry: { resolve: (id: string) => { globalKey: string } } }).__gs_presentation_registry;
    const mod = (window as unknown as Record<string, { create: (env: unknown) => Record<string, (...a: unknown[]) => string> }>)[reg.resolve(templateId).globalKey];
    const r = mod.create({
      t: (k: string) => (k === 'poweredBy' && locale === 'fa' ? 'قدرت گرفته از' : k),
      escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
      config: { attachments: { enabled: false }, composer: {}, readReceipts: { enabled: true }, poweredBy, showPoweredBy: true },
      locale,
      primaryColor: '#3B82F6',
    });
    const html = r.homeHtml({ rtl: locale === 'fa', isOnline: true, teamMembers: [], categories: [], articles: [], conversations: [], kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6', welcomeMessage: 'Hi', smartSurface: null });
    return /<div class="wy-footer">[\s\S]*?<\/(a|span)><\/div>/.exec(html)?.[0] ?? '';
  }
  const LOGO = `https://app.webyar.ai${WEBYAR_BRAND.logo.light}`;

  it('Iran: the label, then the Persian logotype; the name is its alt text', () => {
    const html = footer('default', { text: 'قدرت گرفته از', brand: 'وب یار', url: 'https://webyar.ai', logo: LOGO });
    expect(html).toContain('<span>قدرت گرفته از</span><img class="wy-powered-logo" data-wy-brand-logo src="' + LOGO + '" alt="وب یار"');
    expect(html).toContain('href="https://webyar.ai"');
  });

  it('without a logo (an unknown edition) the text credit is exactly as before', () => {
    expect(footer('default', { text: 'قدرت گرفته از', brand: 'وب یار', url: null })).toContain('<span class="wy-powered"><span>قدرت گرفته از وب یار</span></span>');
  });

  it('the default stylesheet sizes it 16px high on the centre line; the server sends it for Iran only', () => {
    expect(read('public/widget/presentation-default.css')).toMatch(/\.wy-powered \.wy-powered-logo \{[^}]*height: 16px;[^}]*vertical-align: middle;/);
    // The International skin still sizes its own (14px), after the base rule.
    expect(read('public/widget/presentation-intl.css')).toMatch(/\.wy-powered \.wy-powered-logo \{[^}]*height: 14px;/);
    const route = read('server/routes/widget.ts');
    expect(route).toContain('if (poweredBy && isWebyarKitEdition(edition) && assetBase) {');
    expect(route).toContain('.logo = `${assetBase}${WEBYAR_BRAND.logo.light}`');
    expect(route).toContain('.logo = `${assetBase}${INTL_BRAND.horizontal.light}`');
    // A broken image becomes the name (Core, capture-phase listener, CSP-safe).
    expect(read('public/widget/runtime.js')).toContain("img.hasAttribute('data-wy-brand-logo')");
  });
});

describe('call widget "powered by"', () => {
  const cw = (name: string) => read(`public/call-widget/${name}`);
  function callWidget(extra: Record<string, unknown>, locale = 'fa') {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/page', runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { eval(code: string): unknown; CallCenterWidget: { mount(o: unknown): void } };
    win.eval(cw('presentation-registry.js'));
    win.eval(cw('presentation-default.js'));
    win.eval(cw('runtime.js'));
    win.CallCenterWidget.mount({
      apiBase: 'https://api.example',
      origin: 'https://app.webyar.ai',
      preview: true,
      bootstrap: {
        status: 'ok', provider_ready: true, session: 'preview',
        config: { widget_template_id: 'default', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [] },
        capabilities: { voice: true, video: false, callback: true },
        callback_policy: { enabled: true, show_when_online: true },
        recording: { effective_enabled: false },
        departments: { voice: [], video: [], callback: [] },
        i18n: { default_locale: locale, available_locales: [locale] },
        ...extra,
      },
    });
    const root = (win.document.querySelector('#call-center-widget-host') as HTMLElement).shadowRoot!.querySelector('.ccw-root') as HTMLElement;
    (root.querySelector('.ccw-launcher-btn') as HTMLButtonElement | null)?.click();
    return { root, win };
  }

  it('Iran (fa): the label first, then the logotype; absolute from the widget origin; the dead link kept', () => {
    const { root } = callWidget({ edition: 'iran', powered_by_logo: WEBYAR_BRAND.logo.light });
    const link = root.querySelector('.ccw-powered') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#');
    expect(link.firstElementChild!.textContent).toBe('قدرت گرفته از');
    const img = link.lastElementChild as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(`https://app.webyar.ai${WEBYAR_BRAND.logo.light}`);
    expect(img.getAttribute('alt')).toBe('وب یار');
  });

  it('Iran: English and Turkish keep their label around the same Persian logotype', () => {
    const en = callWidget({ edition: 'iran', powered_by_logo: WEBYAR_BRAND.logo.light }, 'en').root.querySelector('.ccw-powered')!;
    expect(en.textContent).toBe('Powered by');
    expect(en.querySelector('img')!.getAttribute('src')).toContain('webyar-logo-fa-color.svg');
    const tr = callWidget({ edition: 'iran', powered_by_logo: WEBYAR_BRAND.logo.light }, 'tr').root.querySelector('.ccw-powered')!;
    expect(tr.firstElementChild!.tagName).toBe('IMG');
    expect(tr.textContent).toBe('tarafından desteklenmektedir');
  });

  it('Iran: a logo that cannot load becomes the words again', () => {
    const { root, win } = callWidget({ edition: 'iran', powered_by_logo: WEBYAR_BRAND.logo.light });
    root.querySelector('img.ccw-powered-logo')!.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('error'));
    expect(root.querySelector('.ccw-powered')!.textContent).toBe('قدرت گرفته ازوب یار');
  });

  it('an unknown edition, or Iran without the field (older backend), keeps the exact words', () => {
    for (const extra of [{ powered_by_logo: WEBYAR_BRAND.logo.light }, { edition: null, powered_by_logo: WEBYAR_BRAND.logo.light }, { edition: 'iran' }]) {
      const link = callWidget(extra).root.querySelector('.ccw-powered')!;
      expect(link.querySelector('img')).toBeNull();
      expect(link.textContent).toBe('قدرت گرفته از وب یار');
    }
  });

  it('a workspace\'s own "powered by" text still wins over the logo', () => {
    const custom = callWidget({
      edition: 'iran', powered_by_logo: WEBYAR_BRAND.logo.light,
      config: { widget_template_id: 'default', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [], custom_texts: { fa: { powered_by: 'ساخت آکمه' } } },
    }).root;
    expect(custom.querySelector('img.ccw-powered-logo')).toBeNull();
    expect(custom.querySelector('.ccw-powered')!.textContent).toBe('ساخت آکمه');
  });

  it('the server names the logo for Iran only; the default stylesheet sizes it, never the intl root', () => {
    const route = read('server/routes/callWidget.ts');
    expect(route).toContain('...(isWebyarKitEdition(edition) ? { powered_by_logo: WEBYAR_BRAND.logo.light } : {}),');
    const css = cw('presentation-default.css');
    expect(css).toMatch(/\.ccw-presentation-default:not\(\.ccw-presentation-intl\) \.ccw-powered-logo \{[^}]*height: 16px;/);
  });
});
