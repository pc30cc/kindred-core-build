/**
 * A Smart Engagement rule end to end, in a real browser, with the REAL
 * loader.js and the REAL engine bundle (public/widget/smart-engine.js:
 * src/lib/widget/smartEngine.ts and, after it, src/lib/widget/smartClient.js),
 * every other request answered in memory.
 *
 * Smart Engagement's visitor side (the loop, the bubble, its styles) left the
 * loader, which every page view of every site downloads, for the engine
 * bundle, which only a site with active rules does. What must hold:
 *
 *   - a page with a rule asks for the bundle once and the bubble shows, laid
 *     out by the bubble's own sheet (put right after the loader's, before any
 *     template's), in the widget's language;
 *   - "shown" and, on its button, "cta_clicked" are reported for the rule,
 *     and the button opens the chat;
 *   - a rule's time on the page counts from the loader's start;
 *   - a page without rules asks for no engine at all.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chatWidgetTemplate } from '../shared/widgetTemplates';
import { resolveChromium } from './harness/widgetHarness';

test.use({ launchOptions: { executablePath: resolveChromium() } });

const root = process.cwd();
const ORIGIN = 'https://widget.test';
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const TYPES: Record<string, string> = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function rule(trigger: Record<string, unknown>) {
  return {
    id: '0c6b1c2e-1d2a-4e3b-9c4d-5e6f7a8b9c0d', name: 'Sizes', status: 'active', priority: 100, schema_version: 1, version: 1,
    trigger_config: trigger,
    audience_config: { match: 'all', conditions: [], groups: [] },
    content_config: { default_locale: 'en', locales: { en: { title: '', body: 'Need a hand with sizes?', cta_label: 'Chat with us' } } },
    presentation_config: { mode: 'launcher_nudge', action: 'open_chat', dismissible: true },
    schedule_config: { weekdays: [] },
    frequency_config: { mode: 'always' },
    behavior_config: { offline_mode: 'show', mobile_enabled: true },
  };
}

function config(smart: Record<string, unknown> | null) {
  const t = chatWidgetTemplate('intl')!;
  const w = (f: string | null) => (f ? `${ORIGIN}/widget/${f}` : null);
  return {
    enabled: true, workspaceId: WS, edition: 'international', templateId: 'intl', templateOptions: {}, locale: 'en',
    primaryColor: '#8B5CF6', workspaceName: 'Test store', brandName: 'Test store', welcomeMessage: 'Hi!',
    teamMembers: [{ name: 'Sara', avatar: null, online: true }],
    availability: { state: 'online', liveChatEnabled: true, next_open_at: null },
    features: { chat: true, knowledgeBase: false },
    attachments: { enabled: false }, composer: { emojiEnabled: false },
    aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
    prechatEnabled: false, position: 'bottom-right',
    runtimeUrl: w('runtime.js'), styleUrl: w('runtime.css'), callRuntimeUrl: w('runtime-call.js'),
    presentationRegistryUrl: w('presentation-registry.js'), presentationUrl: w(t.script), presentationStyleUrl: w(t.style),
    presentationSkinUrl: w(t.skin), presentationFontsUrl: w(t.fonts),
    modules: { chat: w('runtime-chat.js'), kb: w('runtime-kb.js') },
    ...(smart ? { smart } : {}),
  };
}

const HOST = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main style="height:1600px">Shop</main>
<script>window.__gs_id=${JSON.stringify(WS)};window.__gs_api_base=location.origin;window.__GS_WIDGET_TEST_HOOKS__=true;</script>
<script src="/widget/loader.js"></script></body></html>`;

interface Seen { files: string[]; events: Array<Record<string, unknown>>; engineAt: number }

async function route(page: Page, smart: Record<string, unknown> | null, opts: { engineDelayMs?: number } = {}): Promise<Seen> {
  const seen: Seen = { files: [], events: [], engineAt: 0 };
  await page.route('**/*', async (r: Route) => {
    const url = new URL(r.request().url());
    const p = url.pathname;
    const json = (body: unknown) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p.startsWith('/widget/')) {
      seen.files.push(p);
      const file = path.join(root, 'public', p);
      if (!existsSync(file)) return r.fulfill({ status: 404, body: '' });
      if (/smart-engine/.test(p)) {
        if (opts.engineDelayMs) await new Promise((res) => setTimeout(res, opts.engineDelayMs));
        seen.engineAt = Date.now();
      }
      return r.fulfill({ status: 200, contentType: TYPES[path.extname(p)] || 'application/octet-stream', body: readFileSync(file) });
    }
    if (p === '/api/widget/boot' || p === '/api/widget/bootstrap') {
      return json({ session_token: 't', workspace_id: WS, protocol: 3, availability: { state: 'online' }, config: config(smart) });
    }
    if (p === '/api/widget/smart/event') {
      seen.events.push(JSON.parse(r.request().postData() || '{}'));
      return json({ ok: true });
    }
    if (p.includes('/api/widget/conversations')) return json({ conversations: [] });
    if (p.includes('/api/realtime/connect')) return json({ vendor: 'polling_builtin' });
    if (p.includes('/api/widget/identity/me')) return json({ identified: false, visitor: null });
    if (p.includes('/api/')) return json({});
    return r.fulfill({ status: 200, contentType: 'text/html', body: HOST });
  });
  return seen;
}

/** The bubble as the visitor sees it (null: none yet). */
const bubble = (page: Page) => page.evaluate(() => {
  const shadow = document.querySelector('gs-widget')?.shadowRoot;
  const el = shadow?.querySelector('.smart-nudge:not(.leaving)') as HTMLElement | null;
  if (!shadow || !el) return null;
  const cs = getComputedStyle(el);
  const sheets = Array.from(shadow.children).filter((c) => c.tagName === 'STYLE' || c.tagName === 'LINK');
  const own = shadow.querySelector('style[data-gs-smart]');
  return {
    text: (el.querySelector('.smart-body') as HTMLElement).textContent,
    cta: (el.querySelector('[data-smart-cta]') as HTMLElement | null)?.textContent ?? null,
    role: el.getAttribute('role'), lang: el.lang, dir: el.dir,
    position: cs.position, radius: cs.borderTopLeftRadius, display: cs.display,
    visible: el.getBoundingClientRect().width > 0,
    sheetIndex: own ? sheets.indexOf(own) : -1,
    sheets: shadow.querySelectorAll('style[data-gs-smart]').length,
  };
});

test.describe('a Smart Engagement rule, from the engine bundle', () => {
  test('the bubble shows, styled by its own sheet, and its button opens the chat', async ({ page }) => {
    const seen = await route(page, { enabled: true, engineUrl: `${ORIGIN}/widget/smart-engine.js`, rules: [rule({ type: 'page_load' })] });
    await page.goto(`${ORIGIN}/host`);
    await expect.poll(() => bubble(page), { timeout: 10_000 }).not.toBeNull();
    const b = (await bubble(page))!;
    expect(b.text).toBe('Need a hand with sizes?');
    expect(b.cta).toBe('Chat with us');
    expect(b).toMatchObject({ role: 'status', lang: 'en', dir: 'ltr', position: 'absolute', radius: '16px', display: 'flex', visible: true });
    // Right after the loader's own sheet (index 0), once.
    expect(b.sheetIndex).toBe(1);
    expect(b.sheets).toBe(1);
    expect(seen.files.filter((f) => /smart/.test(f))).toEqual(['/widget/smart-engine.js']);
    await expect.poll(() => seen.events.map((e) => e.event_type)).toContain('shown');
    expect(seen.events.find((e) => e.event_type === 'shown')).toMatchObject({ workspace_id: WS, rule_id: '0c6b1c2e-1d2a-4e3b-9c4d-5e6f7a8b9c0d' });

    await page.locator('gs-widget [data-smart-cta]').click();
    await expect.poll(() => seen.events.map((e) => e.event_type)).toContain('cta_clicked');
    await page.locator('gs-widget .panel.visible').waitFor({ timeout: 15_000 });
  });

  test('a rule\'s time on the page counts from the loader\'s start, not from the bundle\'s arrival', async ({ page }) => {
    // The bundle answers after 3 s: the rule's 2 s on the page are over by
    // then, so the bubble shows on the first evaluation, at once (counted
    // from the bundle's arrival it would wait 2 s more).
    const seen = await route(page, { enabled: true, engineUrl: `${ORIGIN}/widget/smart-engine.js`, rules: [rule({ type: 'time_on_page', seconds: 2 })] }, { engineDelayMs: 3_000 });
    await page.goto(`${ORIGIN}/host`);
    await expect.poll(() => bubble(page), { timeout: 10_000, intervals: [100] }).not.toBeNull();
    expect(seen.engineAt).toBeGreaterThan(0);
    expect(Date.now() - seen.engineAt).toBeLessThan(1_500);
  });

  test('a page without rules asks for no engine', async ({ page }) => {
    const seen = await route(page, null);
    await page.goto(`${ORIGIN}/host`);
    await page.locator('gs-widget .launcher').waitFor({ state: 'visible' });
    await page.waitForTimeout(1_500);
    expect(seen.files.filter((f) => /smart/.test(f))).toEqual([]);
    expect(await bubble(page)).toBeNull();
  });
});
