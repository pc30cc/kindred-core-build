/**
 * Editions phase 5 — the brand in text (shared/brand.ts). The Iranian
 * edition (and an edition not known yet) reads WebYar's own words exactly as
 * before; the International edition reads the platform's own name, site and
 * support address, never a WebYar word.
 *
 * fixtures/iranBrandLines.json pairs every source line that now carries a
 * brand token with the line it replaced (taken from the tree before this
 * change): filled for the Iranian edition, each must give back that line byte
 * for byte.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import fixture from './fixtures/iranBrandLines.json';
import {
  IRAN_BRAND,
  brandContactFromDomains,
  brandNameFor,
  brandTokensFor,
  fillBrandTokens,
} from '../../../shared/brand';
import { I18nProvider, useTranslation } from '@/i18n';
import en from '@/i18n/locales/en';
import { __resetBrandForTests, brandTokens, setPlatformBrand, BRAND_CACHE_KEY } from '@/lib/brand';
import { __resetEditionForTests, EDITION_CACHE_KEY } from '@/lib/edition';
import { LEGAL_CHROME, LEGAL_DOCUMENTS, CONTACT_PAGE } from '@/pages/public/legal/legalDocuments';
import { contactMailto } from '@/pages/public/legal/contactForm';
import LegalPage from '@/pages/public/legal/LegalPage';
import {
  __setPushBrandForTests,
  renderContent,
  renderEmailContent,
  renderTeamContent,
} from '../../../server/services/push/dispatch';
import { DEFAULT_TEMPLATES, defaultPushTemplates, renderTemplate, PUSH_PLATFORM_DEFAULTS } from '../../../server/services/push/platformSettings';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const TOKEN_RE = /\{\{(brand|brandLatin|brandPlugin|supportEmail|siteUrl)\}\}/;

type FixtureLine = { locale: string; source: string; iran: string };
const FIXTURE = fixture as Record<string, FixtureLine[]>;

describe('shared/brand.ts', () => {
  it('Iran and an unknown edition: WebYar\'s exact strings, whatever the identity says', () => {
    const identity = { names: { en: 'RESPOK', fa: 'رسپاک' }, siteUrl: 'https://respok.app', supportEmail: 'help@respok.app' };
    for (const edition of ['iran', null, undefined] as const) {
      expect(brandTokensFor(edition, 'en', identity)).toEqual({
        brand: 'Webyar', brandLatin: 'Webyar', brandPlugin: 'Web Yar', supportEmail: 'info@webyar.ai', siteUrl: 'https://webyar.ai',
      });
      expect(brandTokensFor(edition, 'fa', identity).brand).toBe('وب‌یار');
      expect(brandTokensFor(edition, 'tr-TR', identity).brand).toBe('Webyar');
    }
    expect(IRAN_BRAND.brand.fa).toBe('وب‌یار');
  });

  it('International: the platform\'s own identity and never a WebYar word', () => {
    const identity = { names: { en: 'RESPOK', fa: 'رسپاک' }, siteUrl: 'https://respok.app', supportEmail: null };
    const fa = brandTokensFor('international', 'fa', identity);
    expect(fa).toEqual({
      brand: 'رسپاک', brandLatin: 'RESPOK', brandPlugin: 'RESPOK', supportEmail: 'support@respok.app', siteUrl: 'https://respok.app',
    });
    expect(brandTokensFor('international', 'tr', identity).brand).toBe('RESPOK');
    const bare = brandTokensFor('international', 'en', { names: {}, siteUrl: null, supportEmail: null });
    expect(Object.values(bare).join(' ')).not.toMatch(/webyar|web yar|وب/i);
  });

  it('fills every token and nothing else', () => {
    const tokens = brandTokensFor('international', 'en', { names: { en: 'Acme' }, siteUrl: 'https://acme.test', supportEmail: 'a@acme.test' });
    expect(fillBrandTokens('{{brand}}/{{brandLatin}}/{{brandPlugin}} {{supportEmail}} {{siteUrl}} {{page}} {{platform}}', tokens))
      .toBe('Acme/Acme/Acme a@acme.test https://acme.test {{page}} {{platform}}');
    expect(brandNameFor({ fa: 'x' }, 'en')).toBe('x');
  });

  it('derives the site and support address from platform_domains', () => {
    expect(brandContactFromDomains({ primary_domain: 'respok.app' })).toEqual({ site_url: 'https://respok.app', support_email: 'support@respok.app' });
    expect(brandContactFromDomains({ canonical_base_url: 'https://www.respok.app/x', primary_domain: 'other.test' }))
      .toEqual({ site_url: 'https://www.respok.app', support_email: 'support@respok.app' });
    expect(brandContactFromDomains(null)).toEqual({ site_url: null, support_email: null });
    expect(brandContactFromDomains({ primary_domain: 'not a domain' })).toEqual({ site_url: null, support_email: null });
  });
});

describe('Iranian text is byte-identical (fixture of every replaced line)', () => {
  it.each(Object.keys(FIXTURE))('%s', (file) => {
    const source = read(file);
    const lines = FIXTURE[file];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(source.split('\n'), `${file}: line no longer present`).toContain(line.source);
      if (file.endsWith('call-widget/runtime.js')) {
        // The call widget's own `{brand}` (public/call-widget/runtime.js IRAN_POWERED_BY_BRAND).
        const iran = { en: 'Web Yar', fa: 'وب یار', tr: 'Web Yar' }[line.locale as 'en' | 'fa' | 'tr'];
        expect(line.source.replace('{brand}', iran)).toBe(line.iran);
      } else {
        expect(fillBrandTokens(line.source, brandTokensFor('iran', line.locale))).toBe(line.iran);
      }
    }
  });

  it.each(['en', 'fa', 'tr'])('every brand token in the %s locale is covered by the fixture', (locale) => {
    const file = `src/i18n/locales/${locale}.ts`;
    const covered = new Set(FIXTURE[file].map((l) => l.source));
    const tokenLines = read(file).split('\n').filter((l) => TOKEN_RE.test(l));
    expect(tokenLines.filter((l) => !covered.has(l))).toEqual([]);
  });

  it('no locale names WebYar outside repository paths and file names', () => {
    for (const locale of ['en', 'fa', 'tr']) {
      const offenders = read(`src/i18n/locales/${locale}.ts`).split('\n').filter((l) =>
        /Webyar|Web Yar|وب‌یار|https:\/\/webyar\.ai/.test(l)
        && !/ios\/Webyar|Webyar\.xcodeproj|Webyar-Android|apple@webyar\.ai/.test(l));
      expect(offenders, locale).toEqual([]);
    }
  });
});

describe('t() fills the brand per edition', () => {
  function Probe({ k }: { k: string }) {
    const { t } = useTranslation();
    return <span data-testid="out">{t(k as never)}</span>;
  }

  beforeEach(() => {
    localStorage.clear();
    __resetEditionForTests();
    __resetBrandForTests();
  });

  it('Iran / unknown: today\'s words', () => {
    render(<I18nProvider initialLocale="en" initialTranslations={en}><Probe k="notifications.permissionNeededHelp" /></I18nProvider>);
    expect(screen.getByTestId('out').textContent)
      .toBe('Allow notifications and Webyar will tell you about a new message while you are in another window.');
    act(() => setPlatformBrand({ edition: 'iran', localized: [{ locale: 'en', platform_name: 'Something Else' }] }));
    expect(screen.getByTestId('out').textContent)
      .toBe('Allow notifications and Webyar will tell you about a new message while you are in another window.');
  });

  it('International: the platform\'s own name, live when the config arrives, and cached', () => {
    render(<I18nProvider initialLocale="en" initialTranslations={en}><Probe k="commerceAuthorize.expired" /></I18nProvider>);
    act(() => setPlatformBrand({
      edition: 'international',
      localized: [{ locale: 'en', platform_name: 'RESPOK' }],
      siteUrl: 'https://respok.app',
      supportEmail: 'support@respok.app',
    }));
    expect(screen.getByTestId('out').textContent)
      .toBe('This pairing link has expired — go back to your WordPress admin and click "Connect to RESPOK" again.');
    expect(brandTokens('en').brand).toBe('RESPOK');
    expect(JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || '{}').names).toEqual({ en: 'RESPOK' });
  });

  it('a cached International edition is used before the config arrives (first paint)', () => {
    localStorage.setItem(EDITION_CACHE_KEY, 'international');
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify({ names: { en: 'RESPOK' }, siteUrl: 'https://respok.app', supportEmail: null }));
    __resetBrandForTests();
    expect(brandTokens('en')).toMatchObject({ brand: 'RESPOK', supportEmail: 'support@respok.app', siteUrl: 'https://respok.app' });
  });
});

describe('legal pages', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetEditionForTests();
    __resetBrandForTests();
  });

  it('Iran: the chrome, documents and contact read exactly as before', () => {
    const iran = brandTokensFor('iran', 'en');
    expect(fillBrandTokens(LEGAL_CHROME.brand, iran)).toBe('Webyar');
    expect(fillBrandTokens(LEGAL_CHROME.copyright, iran)).toBe('© 2026 Webyar — All rights reserved.');
    expect(fillBrandTokens(LEGAL_DOCUMENTS.privacy.pageTitle, iran)).toBe('Privacy Policy | Webyar');
    expect(fillBrandTokens(CONTACT_PAGE.pageTitle, iran)).toBe('Contact | Webyar');
    expect(new URL(contactMailto({ name: 'Emma', email: 'e@x.test', subject: 'Hi', message: 'Hello there' })).pathname)
      .toBe('info@webyar.ai');
    const raw = JSON.stringify([LEGAL_CHROME, LEGAL_DOCUMENTS, CONTACT_PAGE]);
    expect(raw).not.toMatch(/Webyar|webyar\.ai/);
  });

  it('International: the platform\'s own name and address on the page', () => {
    localStorage.setItem(EDITION_CACHE_KEY, 'international');
    setPlatformBrand({ edition: 'international', localized: [{ locale: 'en', platform_name: 'RESPOK' }], siteUrl: 'https://respok.app', supportEmail: 'support@respok.app' });
    render(<MemoryRouter><LegalPage doc="privacy" /></MemoryRouter>);
    const text = document.body.textContent || '';
    expect(text).toContain('RESPOK');
    expect(text).toContain('support@respok.app');
    expect(text).not.toMatch(/Webyar|webyar/);
  });
});

describe('push copy', () => {
  beforeEach(() => __setPushBrandForTests(null));

  it('Iran / unknown: the privacy copy and default templates exactly as before', () => {
    expect(renderContent({ conversationId: 'c', workspaceId: 'w' } as never, 'new_message', false, null, 'en'))
      .toEqual({ title: 'Webyar', body: 'New message in Webyar' });
    const fa = renderContent({ conversationId: 'c', workspaceId: 'w' } as never, 'new_message', false, null, 'fa');
    expect(fa.title).toContain('Webyar');
    expect(fa.body).toContain('پیام جدید در وب‌یار');
    expect(renderEmailContent({} as never, false, 'tr').body).toContain("Webyar'da yeni e-posta");
    expect(renderTeamContent({}, false, 'en').title).toBe('Webyar');
    expect(defaultPushTemplates('iran')).toBe(DEFAULT_TEMPLATES);
    expect(defaultPushTemplates(null)).toBe(DEFAULT_TEMPLATES);
    expect(DEFAULT_TEMPLATES.new_message.privateTitle).toEqual({ default: 'Webyar', en: 'Webyar', fa: 'Webyar', tr: 'Webyar' });
    const withPolicy = renderContent({ conversationId: 'c', workspaceId: 'w', senderName: 'Sara', text: 'hi' } as never, 'new_message', false, PUSH_PLATFORM_DEFAULTS, 'en');
    expect(withPolicy.title).toBe('Webyar');
  });

  it('International: the platform\'s own name, never WebYar\'s', () => {
    __setPushBrandForTests({ edition: 'international', names: { en: 'RESPOK', fa: 'رسپاک' } });
    expect(renderContent({ conversationId: 'c', workspaceId: 'w' } as never, 'new_message', false, null, 'en'))
      .toEqual({ title: 'RESPOK', body: 'New message in RESPOK' });
    expect(renderContent({ conversationId: 'c', workspaceId: 'w' } as never, 'new_message', false, null, 'fa').body)
      .toContain('پیام جدید در رسپاک');
    const intlDefaults = defaultPushTemplates('international');
    expect(intlDefaults.new_message.privateTitle).toEqual({ default: '{{brand}}', en: '{{brand}}', fa: '{{brand}}', tr: '{{brand}}' });
    const rendered = renderTemplate({ ...PUSH_PLATFORM_DEFAULTS, templates: intlDefaults }, 'mention', 'en', false, { brand: 'RESPOK' }, 'international');
    expect(rendered.title).toBe('RESPOK');
    expect(JSON.stringify(intlDefaults)).not.toContain('Webyar');
  });
});

describe('index.html and the boot script', () => {
  const html = read('index.html');

  const headScript = /<script>\s*(\(function \(\) \{\s*var BOOT_TIMEOUT_MS[\s\S]*?)<\/script>/.exec(html)![1];
  const splashScript = /<script>\s*(\/\/ International mode[\s\S]*?)<\/script>/.exec(html)![1];
  const splashMarkup = /<div id="boot-splash"[\s\S]*?\n {4}<\/div>/.exec(html)![0];
  type BootWindow = Window & { __PLATFORM_BOOT__?: unknown; __wyApplySplash?: () => void };
  const w = window as BootWindow;

  /** index.html's head, then its body, as the browser runs them (no network). */
  function page(storage: Record<string, string>) {
    localStorage.clear();
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    delete w.__PLATFORM_BOOT__;
    delete w.__wyApplySplash;
    document.documentElement.className = '';
    document.title = '';
    document.head.innerHTML = '<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    new Function(headScript)();
    const script = document.head.querySelector('script[src$="/api/platform/public/boot.js"]') as HTMLScriptElement | null;
    document.body.innerHTML = splashMarkup;
    new Function(splashScript)();
    const splash = () => document.getElementById('boot-splash')!;
    return {
      script,
      pending: () => document.documentElement.classList.contains('wy-boot-pending'),
      intl: () => !!splash().querySelector('.wy-loader.wy-intl'),
      /** WebYar's brand kit (shared/webyarBrand.ts): the Iranian edition only. */
      kit: () => !!splash().querySelector('svg.wy-kit-loader'),
      label: () => splash().getAttribute('aria-label'),
    };
  }

  afterEach(() => vi.useRealTimers());

  it('a returning visitor uses the cache and never asks the API', () => {
    const iran = page({ [EDITION_CACHE_KEY]: 'iran' });
    expect(iran.script).toBeNull();
    expect(iran.pending()).toBe(false);
    expect(iran.intl()).toBe(false);
    // The Iranian edition wears WebYar's brand kit from the first paint.
    expect(iran.kit()).toBe(true);
    expect(iran.label()).toBe('وب‌یار');
    expect(document.querySelector('link[rel="icon"]')!.getAttribute('href')).toBe('/brand/webyar/favicon.svg');
    expect(document.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href')).toBe('/brand/webyar/apple-touch-icon.png');
    const intl = page({ [EDITION_CACHE_KEY]: 'international', [BRAND_CACHE_KEY]: JSON.stringify({ names: { en: 'RESPOK' } }) });
    expect(intl.script).toBeNull();
    expect(intl.intl()).toBe(true);
    expect(intl.kit()).toBe(false);
    expect(intl.label()).toBe('RESPOK');
    expect(document.body.innerHTML).not.toContain('/brand/webyar/');
    expect(document.head.innerHTML).not.toContain('/brand/webyar/');
  });

  it('a first visit loads boot.js asynchronously — never document.write — and keeps the brand area empty meanwhile', () => {
    expect(html).not.toContain('document.write');
    const p = page({});
    expect(p.script).not.toBeNull();
    expect(p.script!.async).toBe(true);
    expect(p.pending()).toBe(true);
    expect(html).toContain('html.wy-boot-pending #boot-splash > * { visibility: hidden; }');
  });

  it('International boot data dresses the splash with the platform brand and is remembered', () => {
    const p = page({});
    w.__PLATFORM_BOOT__ = { edition: 'international', names: { en: 'RESPOK' }, titles: { en: 'RESPOK' }, defaultLocale: 'en', siteUrl: 'https://respok.app', supportEmail: 'support@respok.app' };
    p.script!.onload!(new Event('load'));
    expect(p.pending()).toBe(false);
    expect(p.intl()).toBe(true);
    expect(p.label()).toBe('RESPOK');
    expect(document.querySelector('link[rel="icon"]')!.getAttribute('href')).toBe('/brand/intl/favicon.svg');
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('international');
    expect(localStorage.getItem('wy-default-locale')).toBe('en');
    expect(document.title).toBe('RESPOK');
  });

  it('Iranian boot data dresses the splash with WebYar\'s brand kit', () => {
    const p = page({});
    w.__PLATFORM_BOOT__ = { edition: 'iran', names: { fa: 'وب‌یار' } };
    p.script!.onload!(new Event('load'));
    expect(p.pending()).toBe(false);
    expect(p.intl()).toBe(false);
    expect(p.kit()).toBe(true);
    expect(p.label()).toBe('وب‌یار');
    const foot = document.querySelector('#boot-splash .wy-footer')!;
    expect([...foot.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      '/brand/webyar/webyar-logo-fa-color.svg',
      '/brand/webyar/webyar-logo-fa-on-dark.svg',
    ]);
    expect(document.querySelector('meta[property="og:image"]')!.getAttribute('content')).toBe('/brand/webyar/og-image-1200x630.png');
    expect(document.querySelector('link[rel="mask-icon"]')!.getAttribute('color')).toBe('#0B7D6C');
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('iran');
  });

  it('a failed boot.js falls back to the default splash at once (no kit while the edition is unknown)', () => {
    const p = page({});
    p.script!.onerror!(new Event('error'));
    expect(p.pending()).toBe(false);
    expect(p.intl()).toBe(false);
    expect(p.kit()).toBe(false);
    expect(p.label()).toBe('WEBYAR AI');
    expect(document.head.innerHTML).not.toContain('/brand/webyar/');
  });

  it('a hanging boot.js falls back after the timeout; a late answer is only remembered', () => {
    vi.useFakeTimers();
    const p = page({});
    vi.advanceTimersByTime(1499);
    expect(p.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(p.pending()).toBe(false);
    expect(p.intl()).toBe(false);
    w.__PLATFORM_BOOT__ = { edition: 'international', names: { en: 'RESPOK' } };
    p.script!.onload!(new Event('load'));
    expect(p.intl()).toBe(false); // no switch on show
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('international'); // next visit
  });

  it('keeps the Iranian splash markup as it was ("WEBYAR AI", the AI suffix)', () => {
    expect(html).toContain('<div id="boot-splash" class="wy-launch" role="status" aria-label="WEBYAR AI">');
    expect(html).toContain('<div class="wy-footer" aria-hidden="true"><span class="wy-name">WEBYAR</span><span class="wy-ai">AI</span></div>');
  });

  it('the International splash takes the platform name from the brand cache', () => {
    expect(html).toContain("if (name) splash.setAttribute('aria-label', name);");
  });

  it('the server answers boot.js as a script (server/routes/platformPublic.ts)', () => {
    const route = read('server/routes/platformPublic.ts');
    expect(route).toContain("platformPublicRouter.get('/boot.js'");
    expect(route).toContain("res.type('application/javascript');");
    expect(route).toContain('window.__PLATFORM_BOOT__=');
  });
});

describe('start.sh rewrites are obsolete (docs/operations/EDITIONS.md)', () => {
  it('no hard-coded Persian toast remains in the AI agent settings or the update prompt', () => {
    for (const file of ['src/lib/pwa.ts', 'src/pages/app/ai-agent/SettingsPage.tsx']) {
      const src = read(file);
      for (const s of ['نسخه جدید در دسترس است', 'تازه‌سازی', 'ارسال پیام معرفی فعال شد', 'ارسال پیام معرفی غیرفعال شد', 'پیام معرفی ذخیره شد', 'ذخیره‌سازی ناموفق بود']) {
        expect(src, `${file}: ${s}`).not.toContain(s);
      }
    }
  });

  it('the International edition starts in the platform\'s default language, not the deployment file\'s', () => {
    const i18n = read('src/i18n/index.tsx');
    expect(i18n).toContain("if (cachedEdition() === 'international') {");
  });
});
