/**
 * Boots the SHIPPED visitor widget inside a real browser, with no dev stack.
 *
 * Every request — the widget assets included — is served through
 * `page.route`, so these specs exercise the same runtime.js the browser
 * loads in production while staying hermetic. Layout-sensitive behaviour
 * (scroll anchoring, composer geometry, file pickers) can only be tested
 * here: jsdom has no layout and no file chooser.
 */
import type { Page, Route } from '@playwright/test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const CSS = read('public/widget/runtime.css') + read('public/widget/presentation-default.css');

export const ORIGIN = 'http://widget.test';
/** getUserMedia only exists in a secure context, so mic specs boot from https. */
export const SECURE_ORIGIN = 'https://widget.test';

/**
 * Same resolution playwright.config.ts uses. Specs that override
 * `launchOptions` (to add fake-media flags) replace the config's block
 * wholesale, so they have to re-supply the executable themselves.
 */
export function resolveChromium(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (explicit) return explicit;
  for (const root of ['/opt/ms-playwright', '/opt/pw-browsers']) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      const candidate = path.join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Chromium flags that make getUserMedia resolve without a real microphone. */
export const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

/** 168x400 — CSS caps it at max-height 190px, so the bubble grows ~106px
 *  the moment it lands. */
export const TALL_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="168" height="400">'
  + '<rect width="168" height="400" fill="#4488cc"/></svg>';

export interface Msg {
  id: string;
  role: string;
  text: string;
  time: string;
  sender_avatar?: string | null;
  sender_name?: string;
  attachment?: { id: string; kind: string; mime_type: string; file_name: string; size_bytes: number };
}

export function thread(prefix: string, opts: { image?: boolean; avatar?: string | null } = {}): Msg[] {
  const now = new Date().toISOString();
  const out: Msg[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      id: `${prefix}-m${i}`, role: i % 2 ? 'agent' : 'visitor', time: now,
      sender_name: i % 2 ? 'Operator' : undefined,
      sender_avatar: i % 2 ? (opts.avatar ?? null) : null,
      text: `${prefix} message ${i + 1}, long enough to fill the panel and force a scrollbar`,
    });
  }
  const last: Msg = {
    id: `${prefix}-last`, role: 'agent', text: `${prefix} LAST MESSAGE`, time: now,
    sender_name: 'Operator', sender_avatar: opts.avatar ?? null,
  };
  if (opts.image) {
    last.attachment = { id: `${prefix}-att`, kind: 'image', mime_type: 'image/svg+xml',
      file_name: 'shot.svg', size_bytes: 2048 };
  }
  out.push(last);
  return out;
}

const hostPage = () => `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#eee}
.shell{position:relative;width:420px;height:680px}
${CSS.replace(/:host/g, '.shell')}
.panel{position:absolute!important;inset:0!important;transform:none!important;opacity:1!important;
pointer-events:auto!important;width:420px!important;height:680px!important;max-height:680px!important;}
</style></head><body><div class="shell" dir="rtl" id="shell"></div></body></html>`;

export interface RouteOpts {
  /** Conversation id → its messages. */
  threads: Record<string, Msg[]>;
  /** Status reported by GET /conversations for each thread (default 'open'). */
  statuses?: Record<string, string>;
  /** Delay before the authenticated media fetch resolves. */
  imageDelayMs?: number;
  /** Per-thread overrides for the row GET /conversations returns. */
  conversationRows?: Record<string, Record<string, unknown>>;
}

export async function routeAll(page: Page, opts: RouteOpts) {
  const { threads, statuses = {}, imageDelayMs = 700, conversationRows = {} } = opts;
  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
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
    // Upload handshake: init issues an id, upload accepts the bytes. Both
    // have to work for an attachment to reach the 'ready' state that makes
    // it sendable.
    if (p.endsWith('/api/widget/attachments/init')) {
      return json({ attachment_id: 'att-1' });
    }
    if (p.endsWith('/upload') && p.includes('/api/widget/attachments/')) {
      return json({ ok: true });
    }
    if (p.includes('/api/widget/attachments/')) {
      await new Promise((r) => setTimeout(r, imageDelayMs));
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: TALL_IMAGE });
    }
    if (p.includes('/api/widget/conversations')) {
      return json({
        conversations: Object.keys(threads).map((id) => ({
          id, status: statuses[id] ?? 'open', preview: id, unreadCount: 0,
          updatedAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(),
          ...(conversationRows[id] ?? {}),
        })),
      });
    }
    if (p.includes('/api/widget/identity/history')) {
      const first = Object.keys(threads)[0];
      return json({ conversation_id: first, messages: threads[first] });
    }
    if (p.includes('/api/widget/history')) {
      const cid = url.searchParams.get('conversation_id') || '';
      return json({ messages: threads[cid] || [] });
    }
    if (p.includes('/api/widget/poll')) {
      const cid = url.searchParams.get('conversation_id') || Object.keys(threads)[0];
      return json({ conversation_id: cid, messages: threads[cid] || [] });
    }
    if (p.includes('/api/realtime/connect')) return json({ vendor: 'polling_builtin' });
    if (p.includes('/api/widget/identity/me')) return json({ identified: false, visitor: null });
    if (p.includes('/api/')) return json({});
    return route.fulfill({ status: 200, contentType: 'text/html', body: hostPage() });
  });
}

export interface BootOpts {
  /** Origin to boot from — https when the test needs a secure context. */
  origin?: string;
  /** Seed the per-tab continuity hint, i.e. simulate a reload mid-conversation. */
  resumeCid?: string;
  /** Widget config overrides merged into the defaults. */
  config?: Record<string, unknown>;
  /** Leave the panel closed (default: open it). */
  keepClosed?: boolean;
}

export async function boot(page: Page, opts: BootOpts = {}) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__GS_WIDGET_TEST_HOOKS__ = true;
  });
  const origin = opts.origin ?? ORIGIN;
  await page.goto(`${origin}/host`);
  if (opts.resumeCid) {
    await page.evaluate((cid) => {
      sessionStorage.setItem('gs:view:ws', JSON.stringify({ tab: 'chat', conversationId: cid }));
    }, opts.resumeCid);
    await page.reload();
  }
  for (const f of ['presentation-registry.js', 'presentation-default.js', 'runtime-chat.js', 'runtime.js']) {
    await page.addScriptTag({ url: `${origin}/widget/${f}` });
  }
  await page.evaluate(({ config, keepClosed }) => {
    const w = window as unknown as Record<string, unknown>;
    const shell = document.getElementById('shell') as HTMLElement;
    const launcher = document.createElement('button');
    shell.appendChild(launcher);
    const runtime = w.__gs_runtime as {
      init: (c: Record<string, unknown>, s: Record<string, unknown>) => Record<string, unknown>;
    };
    const inst = runtime.init(
      {
        workspaceId: 'ws', _apiBase: '', _assetBase: '', _sessionToken: 't', locale: 'fa',
        aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
        features: { chat: true }, prechatEnabled: false,
        attachments: { enabled: true, maxSizeMb: 10, allowedMimes: ['image/png'], voiceNotesEnabled: true },
        composer: { emojiEnabled: true },
        ...config,
      },
      { shadowRoot: shell, shellEl: shell, launcher, setUnread() {} });
    w.__inst = inst;
    if (!keepClosed) (inst.open as () => void)();
  }, { config: opts.config ?? {}, keepClosed: !!opts.keepClosed });
}

/** How far the newest message's bottom edge sits past the visible area. */
export async function bottomState(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.wy-chat-scroll') as HTMLElement | null;
    if (!host) return { rows: 0, overflowPx: 0, distanceFromBottom: 0, imageHeight: 0 };
    const rows = host.querySelectorAll('.msg-row');
    const last = rows[rows.length - 1] as HTMLElement | undefined;
    const img = document.querySelector('.msg-att-image img') as HTMLElement | null;
    return {
      rows: rows.length,
      overflowPx: last
        ? Math.round(last.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom) : 0,
      distanceFromBottom: Math.round(host.scrollHeight - host.scrollTop - host.clientHeight),
      imageHeight: img ? Math.round(img.getBoundingClientRect().height) : 0,
    };
  });
}

/** Which view the panel currently shows. */
export const activeView = (page: Page) =>
  page.evaluate(() => document.querySelector('.panel')?.getAttribute('data-view') ?? null);
