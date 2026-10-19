/**
 * A phone turned while the chat panel is open (the owner's iPhone, 2026-10-19):
 *
 *  - in landscape (844×390) the panel stayed the desktop box (400×720 from
 *    the corner anchor): only the hero and the top of the first card showed,
 *    the rest was off screen and could not be scrolled to;
 *  - turned back to portrait it was a floating card with the page around it
 *    instead of the full-screen panel of a fresh open.
 *
 * The REAL loader.js boots here (it owns the phone shell, `.gs-mobile-open`),
 * with the template's files as /config names them, every request answered
 * in memory. For every chat template of both editions: open in portrait,
 * turn to landscape, turn back; the panel fills the screen each time, and in
 * landscape its content scrolls instead of being cut off.
 *
 * Also the home help card with no articles (t1): the room above the search
 * field equals the room below it.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chatWidgetTemplate } from '../shared/widgetTemplates';

const root = process.cwd();
const ORIGIN = 'https://widget.test';
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
/** Screenshots for a human to look at (optional): SHOTS_DIR=/some/folder. */
const SHOTS = process.env.SHOTS_DIR || '';

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const TEMPLATES = ['default', 't1', 't2', 'intl', 't1-intl', 't2-intl'] as const;

const TYPES: Record<string, string> = {
  '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const ARTICLES = [
  { id: 'a1', slug: 'track', title: 'How do I track my order?', excerpt: '', category_id: 'c1', sort_order: 0, locale: 'en' },
  { id: 'a2', slug: 'ship', title: 'Shipping time and cost', excerpt: '', category_id: 'c1', sort_order: 1, locale: 'en' },
];

function config(templateId: string, locale: string) {
  const t = chatWidgetTemplate(templateId)!;
  const w = (f: string | null) => (f ? `${ORIGIN}/widget/${f}` : null);
  const intl = templateId === 'intl' || templateId.endsWith('-intl');
  return {
    enabled: true,
    workspaceId: WS,
    edition: intl ? 'international' : 'iran',
    templateId,
    templateOptions: {},
    locale,
    primaryColor: '#8B5CF6',
    workspaceName: 'Test store',
    brandName: 'Test store',
    welcomeMessage: 'Hi! How can we help?',
    teamMembers: [{ name: 'Sara', avatar: null, online: true }],
    availability: { state: 'online', liveChatEnabled: true, next_open_at: null },
    features: { chat: true, knowledgeBase: true },
    attachments: { enabled: true, maxSizeMb: 10, allowedMimes: ['image/png'], voiceNotesEnabled: false },
    composer: { emojiEnabled: true },
    aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
    prechatEnabled: false,
    position: 'bottom-right',
    runtimeUrl: w('runtime.js'),
    styleUrl: w('runtime.css'),
    callRuntimeUrl: w('runtime-call.js'),
    presentationRegistryUrl: w('presentation-registry.js'),
    presentationUrl: w(t.script),
    presentationStyleUrl: w(t.style),
    presentationSkinUrl: w(t.skin),
    presentationFontsUrl: w(t.fonts),
    modules: {
      chat: w('runtime-chat.js'),
      kb: w('runtime-kb.js'),
      ...(t.coreFeatures ? { ext: w('runtime-ext.js'), emoji: w('runtime-emoji.js') } : {}),
      ...(t.coreFeatures && t.extras ? { late: w('runtime-late.js'), extras: w(t.extras) } : {}),
    },
  };
}

/** A long host page, so a body scroll lock and a page behind the panel would both show. */
const HOST = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px sans-serif;background:#e8e4f6}section{height:600px;border-bottom:1px solid #999;padding:16px}</style>
</head><body>${Array.from({ length: 6 }, (_, i) => `<section>Host page section ${i + 1}</section>`).join('')}
<script>window.__gs_id=${JSON.stringify(WS)};window.__gs_api_base=location.origin;window.__GS_WIDGET_TEST_HOOKS__=true;</script>
<script src="/widget/loader.js"></script></body></html>`;

async function route(page: Page, templateId: string, opts: { articles: boolean; locale: string }) {
  await page.route('**/*', async (r: Route) => {
    const url = new URL(r.request().url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p.startsWith('/widget/') || p.startsWith('/brand/')) {
      const file = path.join(root, 'public', p);
      if (!existsSync(file)) return r.fulfill({ status: 404, body: '' });
      return r.fulfill({ status: 200, contentType: TYPES[path.extname(p)] || 'application/octet-stream', body: readFileSync(file) });
    }
    if (p === '/api/widget/boot' || p === '/api/widget/bootstrap') {
      return json({
        session_token: 't', workspace_id: WS, protocol: 3, availability: { state: 'online' },
        config: config(templateId, opts.locale),
      });
    }
    if (p.includes('/api/widget/kb/categories')) {
      return json({
        locale: opts.locale,
        categories: opts.articles ? [{ id: 'c1', name: 'Orders', slug: 'orders', description: '', icon: 'box', sort_order: 1 }] : [],
        articles: opts.articles ? ARTICLES.map((a) => ({ ...a, locale: opts.locale })) : [],
      });
    }
    if (p.includes('/api/widget/conversations')) return json({ conversations: [] });
    if (p.includes('/api/realtime/connect')) return json({ vendor: 'polling_builtin' });
    if (p.includes('/api/widget/identity/me')) return json({ identified: false, visitor: null });
    if (p.includes('/api/')) return json({});
    return r.fulfill({ status: 200, contentType: 'text/html', body: HOST });
  });
}

/** Where the panel is, what holds it, and whether its content can reach its end. */
const measure = (page: Page) => page.evaluate(() => {
  const shadow = document.querySelector('gs-widget')!.shadowRoot!;
  const shell = shadow.querySelector('.shell') as HTMLElement;
  const panel = shadow.querySelector('.panel') as HTMLElement;
  const r = panel.getBoundingClientRect();
  const vv = window.visualViewport;
  // Every scroller in the panel can bring its last pixel into the panel.
  const scrollers = [...panel.querySelectorAll('*')].filter((el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY) && (el as HTMLElement).clientHeight > 0;
  }) as HTMLElement[];
  let clipped = 0;
  // The panel's own children that end past the panel without a scroller to reach them.
  for (const el of [...panel.querySelectorAll('*')] as HTMLElement[]) {
    const b = el.getBoundingClientRect();
    if (!b.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (b.bottom > r.bottom + 1 && !scrollers.some((s) => s.contains(el))) clipped++;
  }
  // A scroller whose content runs past it: scrolled to its end, its last
  // child is inside the panel (put back at once, nothing paints it).
  let unreachable = 0;
  for (const s of scrollers) {
    if (s.scrollHeight <= s.clientHeight + 1 || !s.lastElementChild) continue;
    const top = s.scrollTop;
    s.scrollTop = s.scrollHeight;
    if (s.lastElementChild.getBoundingClientRect().bottom > r.bottom + 1) unreachable++;
    s.scrollTop = top;
  }
  return {
    mobileOpen: shell.classList.contains('gs-mobile-open'),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    screen: { w: Math.round(vv ? vv.width : innerWidth), h: Math.round(vv ? vv.height : innerHeight) },
    radius: getComputedStyle(panel).borderTopLeftRadius,
    clipped,
    unreachable,
    scrolls: scrollers.some((s) => s.scrollHeight > s.clientHeight + 1),
    bodyLocked: document.body.style.position === 'fixed',
  };
});

async function openPanel(page: Page) {
  const launcher = page.locator('gs-widget .launcher');
  await launcher.waitFor({ state: 'visible' });
  await launcher.click();
  await page.locator('gs-widget .panel.visible').waitFor();
  // The home view painted (not a skeleton) and the fonts in.
  await page.waitForFunction(() => {
    const s = document.querySelector('gs-widget')!.shadowRoot!;
    return !!s.querySelector('.panel [data-view], .panel .wy-view-home, .panel .home-root') && !s.querySelector('.panel .wy-skeleton');
  }, undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(400);
}

async function turn(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  // iOS and Chromium both settle the viewport over a few frames.
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.use({ viewport: PORTRAIT, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });

for (const templateId of TEMPLATES) {
  const locale = templateId.includes('intl') ? 'en' : 'fa';
  test(`${templateId}: portrait → landscape → portrait, the panel is the screen each time`, async ({ page }) => {
    test.setTimeout(60_000);
    await route(page, templateId, { articles: true, locale });
    await page.goto(`${ORIGIN}/host`);
    await openPanel(page);
    const fresh = await measure(page);
    await shot(page, `${templateId}--1-portrait`);
    expect(fresh.mobileOpen).toBe(true);
    expect(fresh.rect).toEqual({ x: 0, y: 0, w: PORTRAIT.width, h: PORTRAIT.height });
    expect(fresh.radius).toBe('0px');

    await turn(page, LANDSCAPE);
    const land = await measure(page);
    await shot(page, `${templateId}--2-landscape`);
    expect(land.mobileOpen, 'still the phone shell in landscape').toBe(true);
    expect(land.rect).toEqual({ x: 0, y: 0, w: LANDSCAPE.width, h: LANDSCAPE.height });
    expect(land.radius).toBe('0px');
    expect(land.clipped, 'nothing cut off below the panel').toBe(0);
    expect(land.unreachable, 'scrolled to its end, every scroller shows its last row').toBe(0);
    // t1 and t2's home is taller than a landscape phone: it scrolls (the
    // desktop box cut it off instead). default's home fits.
    if (templateId !== 'default' && templateId !== 'intl') expect(land.scrolls, 'the home scrolls').toBe(true);
    expect(land.bodyLocked).toBe(true);

    // Anything that re-reads the open state in landscape (here the public
    // API's open, on the iPhone a runtime event) must keep the phone shell:
    // it used to drop `.gs-mobile-open` there, for good.
    await page.evaluate(() => (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs.push(['open']));
    await page.waitForTimeout(200);
    expect((await measure(page)).mobileOpen).toBe(true);

    await turn(page, PORTRAIT);
    const back = await measure(page);
    await shot(page, `${templateId}--3-portrait-again`);
    expect(back).toEqual(fresh);
  });
}

// The help card on t1's home: with no articles under the search field, the
// room below the field matches the room above it (it had 12px over 4px).
// With articles the card is as it was: the list's rows bring their own room.
const helpCard = (page: Page) => page.evaluate(() => {
  const s = document.querySelector('gs-widget')!.shadowRoot!;
  const card = s.querySelector('.cd.hc') as HTMLElement;
  const field = card.querySelector('.sr') as HTMLElement;
  const c = card.getBoundingClientRect();
  const f = field.getBoundingClientRect();
  return {
    above: Math.round(f.top - c.top), below: Math.round(c.bottom - f.bottom),
    rows: card.querySelectorAll('.ls > *').length, fieldMargin: getComputedStyle(field).marginBottom,
    paddingBottom: getComputedStyle(card).paddingBottom,
  };
});
for (const templateId of ['t1', 't1-intl'] as const) {
  const locale = templateId === 't1' ? 'fa' : 'en';
  test(`${templateId}: the home help card with no articles is balanced around its search field`, async ({ page }) => {
    await route(page, templateId, { articles: false, locale });
    await page.goto(`${ORIGIN}/host`);
    await openPanel(page);
    await shot(page, `${templateId}--help-card-empty`);
    const card = await helpCard(page);
    expect(card.rows).toBe(0);
    expect(card.above).toBe(12);
    expect(card.below).toBe(card.above);
  });
  test(`${templateId}: the home help card with articles keeps its look`, async ({ page }) => {
    await route(page, templateId, { articles: true, locale });
    await page.goto(`${ORIGIN}/host`);
    await openPanel(page);
    await expect.poll(async () => (await helpCard(page)).rows).toBe(ARTICLES.length);
    await shot(page, `${templateId}--help-card-articles`);
    const card = await helpCard(page);
    expect(card.fieldMargin).toBe('0px');
    expect(card.paddingBottom).toBe('4px');
  });
}
