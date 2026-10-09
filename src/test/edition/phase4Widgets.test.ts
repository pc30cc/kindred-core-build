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

  it('the intl skin restyles tokens only and the Iranian stylesheet is untouched', () => {
    const skin = read('public/widget/presentation-intl.css');
    expect(skin).toContain('--wy-surface: #f5f5f8;');
    expect(skin).toContain('--wy-text: #16142b;');
    expect(skin).not.toMatch(/webyar|web yar|وب/i);
    expect(read('public/widget/presentation-default.css')).not.toContain('presentation-intl');
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
    expect(route).toMatch(/const intlBrand = edition === 'international'\n\s+\? await buildCallWidgetBrand\(config, ws\.workspace_id\)\n\s+: null;/);
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
