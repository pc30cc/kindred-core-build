/**
 * Widget chat scroll — the newest message must be fully visible.
 *
 * This is a real-browser test on purpose: the bug it guards is a LAYOUT
 * TIMING bug, and jsdom has no layout at all (`scrollHeight` is always 0,
 * `ResizeObserver` does not exist), so a unit test structurally cannot see
 * it. An image attachment is fetched with an auth header, turned into a
 * blob URL and only THEN laid out — long after any fixed timer — and it
 * grows its bubble from the 84px loading box to as much as 190px. Before
 * the fix that left the newest message ~90px below the visible edge.
 *
 * It needs no dev stack: every request, including the widget assets, is
 * served from disk through `page.route`.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const CSS = read('public/widget/runtime.css') + read('public/widget/presentation-web-yar.css');

/** 168x400 — wider than tall is capped by CSS at max-height 190px, so the
 *  bubble grows ~106px the moment this lands. */
const TALL_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="168" height="400">'
  + '<rect width="168" height="400" fill="#4488cc"/></svg>';

const ORIGIN = 'http://widget.test';
const IMAGE_DELAY_MS = 700;

interface Msg {
  id: string; role: string; text: string; time: string;
  attachment?: { id: string; kind: string; mime_type: string; file_name: string; size_bytes: number };
}

function thread(prefix: string, withImage: boolean): Msg[] {
  const now = new Date().toISOString();
  const out: Msg[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ id: `${prefix}-m${i}`, role: i % 2 ? 'agent' : 'visitor', time: now,
      text: `${prefix} message ${i + 1}, long enough to fill the panel and force a scrollbar` });
  }
  const last: Msg = { id: `${prefix}-last`, role: 'agent', text: `${prefix} LAST MESSAGE`, time: now };
  if (withImage) {
    last.attachment = { id: `${prefix}-att`, kind: 'image', mime_type: 'image/svg+xml',
      file_name: 'shot.svg', size_bytes: 2048 };
  }
  out.push(last);
  return out;
}

const HOST_PAGE = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#eee}
.shell{position:relative;width:420px;height:680px}
${CSS.replace(/:host/g, '.shell')}
.panel{position:absolute!important;inset:0!important;transform:none!important;opacity:1!important;
pointer-events:auto!important;width:420px!important;height:680px!important;max-height:680px!important;}
</style></head><body><div class="shell" dir="rtl" id="shell"></div></body></html>`;

async function routeAll(page: Page, threads: Record<string, Msg[]>) {
  await page.route('**/*', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (p.startsWith('/widget/')) {
      const file = path.join(root, 'public', p);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
        status: 200,
        contentType: p.endsWith('.css') ? 'text/css' : 'application/javascript',
        body: readFileSync(file, 'utf8'),
      });
    }
    if (p.includes('/api/widget/attachments/')) {
      // Deliberately slow, exactly like the real authenticated media fetch.
      await new Promise((r) => setTimeout(r, IMAGE_DELAY_MS));
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: TALL_IMAGE });
    }
    if (p.includes('/api/widget/conversations')) {
      return json({
        conversations: Object.keys(threads).map((id) => ({
          id, status: 'open', preview: id, unreadCount: 0,
          updatedAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(),
        })),
      });
    }
    if (p.includes('/api/widget/identity/history')) {
      const first = Object.keys(threads)[0];
      return json({ conversation_id: first, messages: threads[first] });
    }
    if (p.includes('/api/widget/history')) {
      const cid = new URL(route.request().url()).searchParams.get('conversation_id') || '';
      return json({ messages: threads[cid] || [] });
    }
    if (p.includes('/api/widget/poll')) {
      const cid = new URL(route.request().url()).searchParams.get('conversation_id') || Object.keys(threads)[0];
      return json({ conversation_id: cid, messages: threads[cid] || [] });
    }
    if (p.includes('/api/realtime/connect')) return json({ vendor: 'polling_builtin' });
    if (p.includes('/api/widget/identity/me')) return json({ identified: false, visitor: null });
    if (p.includes('/api/')) return json({});
    return route.fulfill({ status: 200, contentType: 'text/html', body: HOST_PAGE });
  });
}

async function boot(page: Page, resumeCid?: string) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__GS_WIDGET_TEST_HOOKS__ = true;
  });
  await page.goto(`${ORIGIN}/host`);
  if (resumeCid) {
    await page.evaluate((cid) => {
      sessionStorage.setItem('gs:view:ws', JSON.stringify({ tab: 'chat', conversationId: cid }));
    }, resumeCid);
    await page.reload();
  }
  for (const f of ['presentation-registry.js', 'presentation-web-yar.js', 'runtime-chat.js', 'runtime.js']) {
    await page.addScriptTag({ url: `${ORIGIN}/widget/${f}` });
  }
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const shell = document.getElementById('shell') as HTMLElement;
    const launcher = document.createElement('button');
    shell.appendChild(launcher);
    const runtime = w.__gs_runtime as {
      init: (c: Record<string, unknown>, s: Record<string, unknown>) => Record<string, unknown>;
    };
    const inst = runtime.init(
      { workspaceId: 'ws', _apiBase: '', _assetBase: '', _sessionToken: 't', locale: 'fa',
        aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
        features: { chat: true }, prechatEnabled: false,
        attachments: { enabled: true }, composer: {} },
      { shadowRoot: shell, shellEl: shell, launcher, setUnread() {} });
    w.__inst = inst;
    (inst.open as () => void)();
  });
}

/** How far the newest message's bottom edge sits past the visible area. */
async function bottomState(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.wy-chat-scroll') as HTMLElement | null;
    if (!host) return { rows: 0, overflowPx: 0, distanceFromBottom: 0, imageHeight: 0 };
    const rows = host.querySelectorAll('.msg-row');
    const last = rows[rows.length - 1] as HTMLElement | undefined;
    const img = document.querySelector('.msg-att-image img') as HTMLElement | null;
    return {
      rows: rows.length,
      overflowPx: last ? Math.round(last.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom) : 0,
      distanceFromBottom: Math.round(host.scrollHeight - host.scrollTop - host.clientHeight),
      imageHeight: img ? Math.round(img.getBoundingClientRect().height) : 0,
    };
  });
}

test.describe('widget chat opens scrolled to the newest message', () => {
  test('an image that lands late does not push the newest message out of view', async ({ page }) => {
    await routeAll(page, { c1: thread('c1', true) });
    await boot(page, 'c1');

    await expect.poll(async () => (await bottomState(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(1);
    // Wait for the slow attachment to arrive and lay out at its real height.
    await expect.poll(async () => (await bottomState(page)).imageHeight, { timeout: 15_000 })
      .toBeGreaterThan(150);
    await page.waitForTimeout(500);

    const state = await bottomState(page);
    // Positive overflow means part of the last message is below the fold.
    expect(state.overflowPx).toBeLessThanOrEqual(0);
    expect(state.distanceFromBottom).toBeLessThanOrEqual(1);
  });

  test('a text-only thread opens flush with its last message', async ({ page }) => {
    await routeAll(page, { c1: thread('c1', false) });
    await boot(page, 'c1');

    await expect.poll(async () => (await bottomState(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const state = await bottomState(page);
    expect(state.overflowPx).toBeLessThanOrEqual(0);
    expect(state.distanceFromBottom).toBeLessThanOrEqual(1);
  });

  // NOTE: this one passes on the pre-fix runtime too. Re-entering a thread
  // repaints the surface (skeleton, then content), and replacing innerHTML
  // resets scrollTop, which makes the scroll listener recompute "stuck to
  // bottom" as true by accident. `resetScrollAnchor()` makes that intent
  // explicit instead of incidental; this test locks the behaviour so a future
  // change to the repaint path cannot quietly take it away.
  test('opening another thread starts at ITS newest message, not where the last one was scrolled', async ({ page }) => {
    await routeAll(page, { c1: thread('c1', false), c2: thread('c2', false) });
    await boot(page, 'c1');
    await expect.poll(async () => (await bottomState(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(1);

    // The visitor scrolls up to re-read something in this thread…
    await page.evaluate(() => {
      const host = document.querySelector('.wy-chat-scroll') as HTMLElement;
      host.scrollTop = 0;
      host.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(150);
    expect((await bottomState(page)).distanceFromBottom).toBeGreaterThan(50);

    // …and then opens a different one.
    await page.evaluate(() => {
      const w = window as unknown as { __inst: { __test: { openConversation: (c: string) => void } } };
      w.__inst.__test.openConversation('c2');
    });
    await expect.poll(async () => (await bottomState(page)).distanceFromBottom, { timeout: 15_000 })
      .toBeLessThanOrEqual(1);
    expect((await bottomState(page)).overflowPx).toBeLessThanOrEqual(0);
  });
});
