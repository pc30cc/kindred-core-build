/**
 * Editions phase 4 — widgets. Each edition wears its own chat and call widget
 * template (shared/widgetTemplates.ts), names its own platform in the call
 * widget's credit, and draws Persian dates in its own calendar. The Iranian
 * edition — and an edition that cannot be read — is pinned here to exactly
 * what it was before editions existed.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  CHAT_WIDGET_TEMPLATES,
  EDITION_CALL_WIDGET_TEMPLATES,
  EDITION_CHAT_WIDGET_TEMPLATES,
  resolveCallWidgetTemplateForEdition,
  resolveChatWidgetTemplate,
  widgetDateHints,
} from '../../../shared/widgetTemplates';
import {
  resolveEditionWidgetTemplateId,
  resolveWidgetTemplateId,
  widgetTemplateAssetKeys,
} from '../../../server/services/widget/presentationAssets';
import {
  callWidgetTemplateAssetKeys,
  callWidgetTemplateIdSchema,
  isCallWidgetTemplateOffered,
  resolveCallWidgetTemplateId,
} from '../../../server/services/callCenter/presentation';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('widget templates per edition (shared/widgetTemplates.ts)', () => {
  it('Iran and an unknown edition wear `default`, whatever is requested', () => {
    for (const edition of ['iran', null, undefined] as const) {
      expect(resolveChatWidgetTemplate(edition)).toBe('default');
      expect(resolveChatWidgetTemplate(edition, 'intl')).toBe('default');
      expect(resolveChatWidgetTemplate(edition, 'web-yar')).toBe('default');
      expect(resolveCallWidgetTemplateForEdition(edition, 'default')).toBe('default');
      expect(resolveCallWidgetTemplateForEdition(edition, 'intl')).toBe('default');
    }
    expect(EDITION_CHAT_WIDGET_TEMPLATES.iran).toEqual({ default: 'default', offered: ['default'] });
    expect(EDITION_CALL_WIDGET_TEMPLATES.iran).toEqual({ default: 'default', offered: ['default'] });
  });

  it('the International edition wears `intl`, never the Iranian template', () => {
    expect(resolveChatWidgetTemplate('international')).toBe('intl');
    expect(resolveChatWidgetTemplate('international', 'default')).toBe('intl');
    expect(resolveChatWidgetTemplate('international', 'web-yar')).toBe('intl');
    // The stored call widget id defaults to 'default' (migration 101).
    expect(resolveCallWidgetTemplateForEdition('international', 'default')).toBe('intl');
    expect(resolveCallWidgetTemplateForEdition('international', 'intl')).toBe('intl');
  });

  it('date hints: Jalali in Tehran time for Iran (and unknown); Gregorian, visitor zone abroad', () => {
    expect(widgetDateHints('iran')).toEqual({ calendar: 'jalali', timeZone: 'Asia/Tehran' });
    expect(widgetDateHints(null)).toEqual({ calendar: 'jalali', timeZone: 'Asia/Tehran' });
    expect(widgetDateHints('international')).toEqual({ calendar: 'gregorian', timeZone: null });
  });
});

describe('chat widget assets on the server', () => {
  it('Iran: the same asset names as before editions, with no skin', () => {
    const id = resolveWidgetTemplateId(resolveEditionWidgetTemplateId('iran', null));
    expect(id).toBe('default');
    expect(widgetTemplateAssetKeys(id)).toEqual({
      script: 'presentation-default.js',
      style: 'presentation-default.css',
      fonts: 'presentation-default-fonts.css',
      skin: null,
    });
    expect(resolveEditionWidgetTemplateId(null, null)).toBe('default');
  });

  it('International: the shared renderer plus the intl skin', () => {
    const id = resolveWidgetTemplateId(resolveEditionWidgetTemplateId('international', null));
    expect(id).toBe('intl');
    expect(widgetTemplateAssetKeys(id)).toEqual({
      script: 'presentation-default.js',
      style: 'presentation-default.css',
      fonts: 'presentation-default-fonts.css',
      skin: 'presentation-intl.css',
    });
  });

  it('an unknown, shape-safe id still follows the file-name convention', () => {
    expect(widgetTemplateAssetKeys('future')).toEqual({
      script: 'presentation-future.js',
      style: 'presentation-future.css',
      fonts: 'presentation-future-fonts.css',
      skin: null,
    });
  });

  it('every template file exists and the browser registry lists the same ids', () => {
    for (const t of Object.values(CHAT_WIDGET_TEMPLATES)) {
      for (const f of [t.script, t.style, t.skin, t.fonts]) {
        if (f) expect(existsSync(`public/widget/${f}`), f).toBe(true);
      }
    }
    new Function(read('public/widget/presentation-registry.js')).call(window);
    const registry = (window as unknown as {
      __gs_presentation_registry: { resolve: (id: string) => Record<string, unknown> };
    }).__gs_presentation_registry;
    for (const t of Object.values(CHAT_WIDGET_TEMPLATES)) {
      const d = registry.resolve(t.id);
      expect(d.id).toBe(t.id);
      expect(d.script).toBe(t.script);
      expect(d.style).toBe(t.style);
      expect(d.skin ?? null).toBe(t.skin);
      expect(d.fonts ?? null).toBe(t.fonts);
    }
  });

  it('the bootstrap carries the edition, brand and date hints, and the skin URL (additive)', () => {
    const route = read('server/routes/widget.ts');
    expect(route).toContain('const edition = await getPlatformEditionOrNull(config);');
    expect(route).toContain('resolveEditionWidgetTemplateId(');
    expect(route).toMatch(/\n\s+edition,\n\s+platformBrandName,\n\s+calendar: dateHints\.calendar,\n\s+timeZone: dateHints\.timeZone,/);
    expect(route).toContain('presentationSkinUrl:');
    // Iran keeps crediting the English platform name, as before.
    expect(route).toContain("edition === 'international' ? platformBrandName : platformBranding?.platform_name || ''");
  });

  it('the loader loads a skin only when the bootstrap names one, and never fails on it', () => {
    const loader = read('public/widget/loader.js');
    expect(loader).toContain('var presentationSkinCss = configData.presentationSkinUrl || "";');
    expect(loader).toContain('var templateSkinLoaded = !presentationSkinCss;');
    expect(loader).toMatch(/if \(presentationSkinCss\) \{/);
    expect(loader).not.toMatch(/fail\("template-skin"\)/);
  });

  it('the intl skin restyles the shared markup and the Iranian stylesheet is untouched', () => {
    const skin = read('public/widget/presentation-intl.css');
    expect(skin).toContain('--wy-surface: #f5f5f8;');
    expect(skin).toContain('--wy-text: #16142b;');
    expect(skin).not.toMatch(/webyar|web yar|وب/i);
    expect(read('public/widget/presentation-default.css')).not.toContain('presentation-intl');
    // The skin is pure CSS over the shared renderer: no imports, no rules
    // that reach outside the widget's shadow root.
    expect(skin).not.toMatch(/@import|:root\b|\bbody\b|\bhtml\b/);
  });

  it('intl messages: own-direction text, grouped bubbles, meta flush with the bubble', () => {
    const skin = read('public/widget/presentation-intl.css');
    const rule = (selector: string) => {
      const at = skin.indexOf(selector + ' {');
      expect(at, selector).toBeGreaterThan(-1);
      return skin.slice(at, skin.indexOf('}', at));
    };
    // Persian in an English widget (and the reverse) reads in its own direction.
    expect(rule('.msg-quote')).toMatch(/unicode-bidi: plaintext;[\s\S]*text-align: start;/);
    // Consecutive bubbles of one author tighten the corners on their joining side.
    expect(skin).toContain('.msg-row.visitor:not(.is-last) + .msg-row.visitor .msg.visitor { border-top-right-radius');
    expect(skin).toContain('.msg-row.operator:not(.is-last) + .msg-row.operator .msg.operator { border-top-left-radius');
    // Quote/copy buttons float beside the bubble, so the time aligns to its edge.
    expect(rule('.msg-actions')).toContain('position: absolute;');
    expect(rule('.msg-row.visitor .msg-actions')).toContain('right: 100%;');
    expect(rule('.msg-row.operator .msg-actions')).toContain('left: 100%;');
    // The operator avatar sits beside the last bubble, above the meta line.
    expect(skin).toContain('.msg-row:has(> .msg-col > .msg-footline) > .msg-avatar {');
  });

  // The owner asked for the same message-layout polish in WebYar's `default`
  // template. It lives at the end of presentation-default.css, and every
  // selector it sets is one the intl skin sets itself (same specificity,
  // loaded later), so RESPOK's look cannot move with it.
  it('default (WebYar) messages get the same polish, without reaching the intl skin', () => {
    const base = read('public/widget/presentation-default.css');
    const skin = read('public/widget/presentation-intl.css');
    const at = base.indexOf('/* ─── Message layout polish (the WebYar look)');
    expect(at).toBeGreaterThan(-1);
    const block = base.slice(at);
    const rule = (selector: string) => {
      const i = block.indexOf(selector + ' {');
      expect(i, selector).toBeGreaterThan(-1);
      return block.slice(i, block.indexOf('}', i));
    };
    expect(rule('.msg-quote')).toMatch(/unicode-bidi: plaintext;[\s\S]*text-align: start;/);
    expect(rule('.msg-actions')).toContain('position: absolute;');
    expect(rule('.msg-row.visitor .msg-actions')).toContain('right: 100%;');
    expect(rule('.msg-row.operator .msg-actions')).toContain('left: 100%;');
    expect(block).toContain('.msg-row:has(> .msg-col > .msg-footline) > .msg-avatar {');
    // WebYar's own colours (the kit's ink) on the operator bubble.
    expect(rule('.msg.operator')).toContain('color: #12141f;');
    // Every selector of the block is overridden by the intl skin.
    const selectors = (css: string) => new Set(
      css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')
        .map((r) => r.split('{')[0]).filter((s) => s.trim() && !/^\s*@/.test(s))
        .flatMap((s) => s.split(',').map((x) => x.replace(/\s+/g, ' ').trim())),
    );
    const own = selectors(skin);
    for (const sel of selectors(block)) expect(own.has(sel), sel).toBe(true);
  });
});

describe('chat widget dates (presentation-default.js)', () => {
  const REGISTRY = read('public/widget/presentation-registry.js');
  const RENDERER = read('public/widget/presentation-default.js');

  function renderer(config: Record<string, unknown>) {
    new Function(REGISTRY).call(window);
    new Function(RENDERER).call(window);
    const reg = (window as unknown as { __gs_presentation_registry: { resolve: (id: string) => { globalKey: string } } })
      .__gs_presentation_registry;
    const mod = (window as unknown as Record<string, { create: (env: unknown) => Record<string, (...a: unknown[]) => string> }>)[
      reg.resolve('default').globalKey
    ];
    return mod.create({
      t: (k: string) => k,
      escapeHtml: (v: unknown) => String(v == null ? '' : v),
      config: { attachments: { enabled: false }, composer: {}, readReceipts: { enabled: true }, ...config },
      locale: 'fa',
      primaryColor: '#3B82F6',
    });
  }

  function dayLabel(r: Record<string, (...a: unknown[]) => string>, iso: string): string {
    const html = r.messagesHtml({
      messages: [{ id: 'm1', sender: 'operator', senderType: 'operator', senderName: 'Sara', text: 'سلام', time: iso, status: 'sent' }],
    }, '', {});
    const m = html.match(/<div class="msg-day"><span>([^<]*)<\/span><\/div>/);
    return m ? m[1] : '';
  }

  const ISO = '2025-03-01T22:30:00Z'; // 2 Mar in Tehran (UTC+3:30), 1 Mar in UTC

  it('Iran (no hints, an older backend, or calendar jalali): Jalali in Tehran time, as before', () => {
    const expected = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tehran',
    }).format(new Date(ISO));
    expect(dayLabel(renderer({}), ISO)).toBe(expected);
    expect(dayLabel(renderer({ calendar: 'jalali', timeZone: 'Asia/Tehran' }), ISO)).toBe(expected);
  });

  it('International: Gregorian with Persian digits, in the visitor zone (or the hinted one)', () => {
    const local = new Intl.DateTimeFormat('fa-IR-u-ca-gregory', { year: 'numeric', month: 'long', day: 'numeric' })
      .format(new Date(ISO));
    expect(dayLabel(renderer({ calendar: 'gregorian', timeZone: null }), ISO)).toBe(local);
    const utc = new Intl.DateTimeFormat('fa-IR-u-ca-gregory', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    }).format(new Date(ISO));
    expect(dayLabel(renderer({ calendar: 'gregorian', timeZone: 'UTC' }), ISO)).toBe(utc);
    expect(local).not.toBe(new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' })
      .format(new Date(ISO)));
  });

  it('the thread list keeps Jalali unless the bootstrap says gregorian (runtime.js)', () => {
    const runtime = read('public/widget/runtime.js');
    expect(runtime).toContain("return ctx.config && ctx.config.calendar === 'gregorian' ? 'fa-IR-u-ca-gregory' : 'fa-IR-u-ca-persian';");
    expect(runtime).toContain("if (!calendar) return 'fa-IR';");
  });
});

describe('call widget templates on the server', () => {
  it('Iran (and unknown): stored `default` stays `default` with the same assets', () => {
    expect(resolveCallWidgetTemplateId('default')).toBe('default');
    expect(resolveCallWidgetTemplateId('default', 'iran')).toBe('default');
    expect(resolveCallWidgetTemplateId('intl', 'iran')).toBe('default');
    expect(resolveCallWidgetTemplateId('not-installed', null)).toBe('default');
    expect(callWidgetTemplateAssetKeys('default')).toEqual({
      registry: 'presentation-registry.js',
      script: 'presentation-default.js',
      style: 'presentation-default.css',
    });
    expect(isCallWidgetTemplateOffered('iran', 'default')).toBe(true);
    expect(isCallWidgetTemplateOffered('iran', 'intl')).toBe(false);
    expect(isCallWidgetTemplateOffered(null, 'intl')).toBe(false);
  });

  it('International: `intl` with its own stylesheet over the shared presentation script', () => {
    expect(resolveCallWidgetTemplateId('default', 'international')).toBe('intl');
    expect(callWidgetTemplateAssetKeys('intl')).toEqual({
      registry: 'presentation-registry.js',
      script: 'presentation-default.js',
      style: 'presentation-intl.css',
    });
    expect(isCallWidgetTemplateOffered('international', 'intl')).toBe(true);
    expect(isCallWidgetTemplateOffered('international', 'default')).toBe(false);
    expect(existsSync('public/call-widget/presentation-intl.css')).toBe(true);
  });

  it('a settings save accepts known ids only; the edition check follows', () => {
    expect(callWidgetTemplateIdSchema.safeParse('default').success).toBe(true);
    expect(callWidgetTemplateIdSchema.safeParse('intl').success).toBe(true);
    expect(callWidgetTemplateIdSchema.safeParse('../x').success).toBe(false);
    const route = read('server/routes/callCenter.ts');
    expect(route).toContain('isCallWidgetTemplateOffered(await getPlatformEditionOrNull(ctx.config), parsed.data.widget_template_id)');
  });

  it('the bootstrap sends the edition, and a credit only in the International edition', () => {
    const route = read('server/routes/callWidget.ts');
    expect(route).toContain('resolveCallWidgetTemplateId(ws.widget_template_id, edition)');
    expect(route).toMatch(/const intlBrand = edition === 'international'\n\s+\? await buildCallWidgetBrand\(config, ws\.workspace_id, getLoaderAssetBase\(req as ExpressRequest\)\)\n\s+: null;/);
    expect(route).toContain('calendar: dateHints.calendar,');
    expect(route).toContain('time_zone: dateHints.timeZone,');
    expect(route).toContain("...(poweredBy !== undefined ? { powered_by: poweredBy } : {}),");
  });
});

describe('call widget runtime: template and "powered by"', () => {
  const source = (name: string) => read(`public/call-widget/${name}`);

  function mount(extra: Record<string, unknown>, locale = 'en') {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/page', runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { eval(code: string): unknown; CallCenterWidget: { mount(o: unknown): void } };
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
        config: { widget_template_id: 'default', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [] },
        capabilities: { voice: true, video: false, callback: true },
        callback_policy: { enabled: true, show_when_online: true },
        recording: { effective_enabled: false },
        departments: { voice: [], video: [], callback: [] },
        i18n: { default_locale: locale, available_locales: [locale] },
        ...extra,
      },
    });
    const host = win.document.querySelector('#call-center-widget-host') as HTMLElement;
    const root = host.shadowRoot!.querySelector('.ccw-root') as HTMLElement;
    (root.querySelector('.ccw-launcher-btn') as HTMLButtonElement | null)?.click();
    return root;
  }

  it.each([
    ['en', 'Powered by Web Yar'],
    ['fa', 'قدرت گرفته از وب یار'],
    ['tr', 'Web Yar tarafından desteklenmektedir'],
  ])('Iran (no edition in the bootstrap) keeps the %s credit exactly: %s', (locale, text) => {
    for (const extra of [{}, { edition: 'iran' }, { edition: null }]) {
      const root = mount(extra, locale);
      const link = root.querySelector('.ccw-powered') as HTMLAnchorElement;
      expect(link.textContent).toBe(text);
      expect(link.getAttribute('href')).toBe('#');
      expect(root.classList.contains('ccw-presentation-default')).toBe(true);
      expect(root.classList.contains('ccw-presentation-intl')).toBe(false);
    }
  });

  it('International credits its own platform, per language, as a link when one is set', () => {
    const root = mount({
      edition: 'international',
      config: { widget_template_id: 'intl', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [] },
      powered_by: { brand: 'RESPOK', brands: { en: 'RESPOK', fa: 'رسپاک' }, url: 'https://respok.app' },
    }, 'fa');
    const link = root.querySelector('.ccw-powered') as HTMLAnchorElement;
    expect(link.textContent).toBe('قدرت گرفته از رسپاک');
    expect(link.getAttribute('href')).toBe('https://respok.app');
    expect(root.classList.contains('ccw-presentation-intl')).toBe(true);
    expect(root.textContent).not.toMatch(/Web Yar|وب یار/);
  });

  it('International with the credit switched off shows no line at all', () => {
    const root = mount({ edition: 'international', powered_by: null });
    expect(root.querySelector('.ccw-powered')).toBeNull();
    expect(root.textContent).not.toMatch(/Web Yar|Powered by/);
  });
});

describe('"powered by" with the platform logo (International template)', () => {
  const LOGO = 'https://app.respok.app/brand/intl/respok-thread-horizontal-color.svg';

  function footer(poweredBy: Record<string, unknown>, locale = 'en', strings: Record<string, string> = {}): string {
    new Function(read('public/widget/presentation-registry.js')).call(window);
    new Function(read('public/widget/presentation-default.js')).call(window);
    const reg = (window as unknown as { __gs_presentation_registry: { resolve: (id: string) => { globalKey: string } } })
      .__gs_presentation_registry;
    const mod = (window as unknown as Record<string, { create: (env: unknown) => Record<string, (...a: unknown[]) => string> }>)[
      reg.resolve('intl').globalKey
    ];
    const r = mod.create({
      t: (k: string) => strings[k] ?? k,
      escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
      config: { attachments: { enabled: false }, composer: {}, readReceipts: { enabled: true }, poweredBy, showPoweredBy: true },
      locale,
      primaryColor: '#3B82F6',
    });
    const html = r.homeHtml({
      rtl: false, isOnline: true, teamMembers: [], categories: [], articles: [], conversations: [],
      kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6', welcomeMessage: 'Hi', smartSurface: null,
    });
    return /<div class="wy-footer">[\s\S]*?<\/(a|span)><\/div>/.exec(html)?.[0] ?? '';
  }

  it('chat widget: the platform wording is used only in its own language, else the widget\'s translation', () => {
    // RESPOK's platform text is the Persian one inherited from WebYar; an English widget must not show it.
    expect(footer({ text: 'قدرت گرفته از', brand: 'RESPOK', url: null })).toContain('<span>Powered by RESPOK</span>');
    expect(footer({ text: 'قدرت گرفته از', brand: 'RESPOK', url: null }, 'tr', { poweredBy: 'Sağlayan' })).toContain('<span>Sağlayan RESPOK</span>');
    // A Persian widget keeps the Persian platform text (WebYar's case, unchanged).
    expect(footer({ text: 'قدرت گرفته از', brand: 'وب یار', url: null }, 'fa', { poweredBy: 'قدرت گرفته از' })).toContain('<span>قدرت گرفته از وب یار</span>');
    // An English platform text is not shown on a Persian widget.
    expect(footer({ text: 'Powered by', brand: 'RESPOK', url: null }, 'fa', { poweredBy: 'قدرت گرفته از' })).toContain('<span>قدرت گرفته از RESPOK</span>');
    // An English platform text on an English widget is used as written.
    expect(footer({ text: 'Built with', brand: 'RESPOK', url: null })).toContain('<span>Built with RESPOK</span>');
  });

  it('chat widget: Iran\'s credit (no logo) is the text exactly as before', () => {
    const html = footer({ text: '', brand: 'Web Yar', url: null });
    expect(html).toContain('<span class="wy-powered"><span>Powered by Web Yar</span></span>');
    expect(html).not.toContain('<img');
  });

  it('chat widget: International shows the label and the logo, alt = platform name, link kept', () => {
    const html = footer({ text: 'Powered by', brand: 'RESPOK', url: 'https://respok.app', logo: LOGO });
    expect(html).toContain('<span>Powered by</span><img class="wy-powered-logo" data-wy-brand-logo src="' + LOGO + '" alt="RESPOK"');
    expect(html).toContain('href="https://respok.app"');
    expect(html).not.toContain('Powered by RESPOK');
    // A relative or non-http logo is ignored (third-party pages need absolute URLs).
    expect(footer({ text: 'Powered by', brand: 'RESPOK', url: null, logo: '/brand/x.svg' })).toContain('<span>Powered by RESPOK</span>');
  });

  it('chat widget: Core swaps a logo that fails to load for the name; the skin sizes it', () => {
    const runtime = read('public/widget/runtime.js');
    expect(runtime).toContain("if (!img || !img.hasAttribute || !img.hasAttribute('data-wy-brand-logo')) return;");
    expect(read('public/widget/presentation-intl.css')).toMatch(/\.wy-powered \.wy-powered-logo \{[^}]*height: 14px;[^}]*vertical-align: middle;/);
    expect(read('server/routes/widget.ts')).toContain('.logo = `${assetBase}${INTL_BRAND.horizontal.light}`');
  });

  const cwSource = (name: string) => read(`public/call-widget/${name}`);
  function callWidget(extra: Record<string, unknown>, locale = 'en') {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/page', runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { eval(code: string): unknown; CallCenterWidget: { mount(o: unknown): void } };
    win.eval(cwSource('presentation-registry.js'));
    win.eval(cwSource('presentation-default.js'));
    win.eval(cwSource('runtime.js'));
    win.CallCenterWidget.mount({
      apiBase: 'https://api.example',
      origin: 'https://app.respok.app',
      preview: true,
      bootstrap: {
        status: 'ok', provider_ready: true, session: 'preview',
        config: { widget_template_id: 'intl', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [] },
        capabilities: { voice: true, video: false, callback: true },
        callback_policy: { enabled: true, show_when_online: true },
        recording: { effective_enabled: false },
        departments: { voice: [], video: [], callback: [] },
        i18n: { default_locale: locale, available_locales: [locale] },
        edition: 'international',
        ...extra,
      },
    });
    const root = (win.document.querySelector('#call-center-widget-host') as HTMLElement).shadowRoot!.querySelector('.ccw-root') as HTMLElement;
    (root.querySelector('.ccw-launcher-btn') as HTMLButtonElement | null)?.click();
    return { root, win };
  }

  it('call widget: the label then the logo, alt = platform name, absolute URL, link kept', () => {
    const { root } = callWidget({ powered_by: { brand: 'RESPOK', brands: { en: 'RESPOK' }, url: 'https://respok.app', logo: '/brand/intl/respok-thread-horizontal-color.svg' } });
    const link = root.querySelector('.ccw-powered') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://respok.app');
    const img = link.querySelector('img.ccw-powered-logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://app.respok.app/brand/intl/respok-thread-horizontal-color.svg');
    expect(img.getAttribute('alt')).toBe('RESPOK');
    expect(link.textContent).toBe('Powered by');
    expect(link.firstElementChild!.className).toBe('ccw-powered-label');
  });

  it('call widget: Turkish puts the logo first; Persian keeps its label before it (RTL)', () => {
    const tr = callWidget({ powered_by: { brand: 'RESPOK', brands: {}, url: null, logo: LOGO } }, 'tr').root.querySelector('.ccw-powered')!;
    expect(tr.firstElementChild!.tagName).toBe('IMG');
    expect(tr.textContent).toBe('tarafından desteklenmektedir');
    const fa = callWidget({ powered_by: { brand: 'RESPOK', brands: {}, url: null, logo: LOGO } }, 'fa').root.querySelector('.ccw-powered')!;
    expect(fa.firstElementChild!.textContent).toBe('قدرت گرفته از');
    expect(fa.lastElementChild!.tagName).toBe('IMG');
  });

  it('call widget: a logo that cannot load becomes the name', () => {
    const { root, win } = callWidget({ powered_by: { brand: 'RESPOK', brands: {}, url: null, logo: LOGO } });
    const img = root.querySelector('img.ccw-powered-logo')!;
    img.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('error'));
    const link = root.querySelector('.ccw-powered')!;
    expect(link.querySelector('img')).toBeNull();
    expect(link.textContent).toBe('Powered byRESPOK');
  });

  it('call widget: no logo, or a workspace\'s own text, keeps the text credit', () => {
    const noLogo = callWidget({ powered_by: { brand: 'RESPOK', brands: {}, url: null } }).root;
    expect(noLogo.querySelector('img.ccw-powered-logo')).toBeNull();
    expect(noLogo.querySelector('.ccw-powered')!.textContent).toBe('Powered by RESPOK');
    const custom = callWidget({
      powered_by: { brand: 'RESPOK', brands: {}, url: null, logo: LOGO },
      config: { widget_template_id: 'intl', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [], custom_texts: { en: { powered_by: 'By Acme' } } },
    }).root;
    expect(custom.querySelector('img.ccw-powered-logo')).toBeNull();
    expect(custom.querySelector('.ccw-powered')!.textContent).toBe('By Acme');
  });

  it('call widget: the server sends the kit\'s logo only abroad; the intl stylesheet sizes it', () => {
    const route = read('server/routes/callWidget.ts');
    expect(route).toContain('const logo = `${assetBase ?? \'\'}${INTL_BRAND.horizontal.light}`;');
    expect(read('public/call-widget/presentation-intl.css')).toMatch(/\.ccw-presentation-intl \.ccw-powered-logo \{[^}]*height: 14px;/);
  });
});
