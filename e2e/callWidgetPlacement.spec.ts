/**
 * Where the call widget sits (build contract 00-contract §8.4, D4, D13,
 * D14): the eight placements of board 02 and their opening origins, and the
 * call widget beside the chat widget (the real chat loader,
 * public/widget/loader.js) on the same page, in both load orders.
 *
 * Owner decision 4: two widgets never share a corner. For every bottom
 * placement the call launcher (and its minimised bars) stands 16px above the
 * chat launcher when their spans meet; the open call panel keeps its corner
 * and covers the chat launcher; an open chat panel covers the call launcher,
 * which then drops back to its corner. On a phone both widgets hold the page
 * still while their panel is open (the one still open takes the hold over
 * when the other closes), and the page comes back where it was whichever
 * closes first.
 *
 * Local gate (not in CI): npx playwright test e2e/callWidgetPlacement.spec.ts --workers=1
 */
import { test, expect, type Browser } from '@playwright/test';
import {
  ACTIVE_SESSION_KEY, openCallSession,
  type CallSession, type CallWin, type ChatOptions, type SessionOptions,
} from './harness/callSession';
import { BRANDS, CALL_ID, DEMO, callStates, frozenNow, type Brand, type GeometrySpec, type JsonObject } from './harness/callScreensFixture';
import { resolveCallChromium } from './harness/callReference';

test.use({
  launchOptions: {
    executablePath: resolveCallChromium(),
    args: ['--autoplay-policy=no-user-gesture-required'],
  },
});

const DESKTOP = { width: 1440, height: 900 };
const TOL = 0.5;

async function withSession(browser: Browser, opts: SessionOptions, fn: (s: CallSession) => Promise<void>): Promise<void> {
  const s = await openCallSession(browser, opts);
  try {
    await fn(s);
    expect(s.log.errors, 'page errors and console errors').toEqual([]);
    expect(s.log.foreign, 'requests to other hosts').toEqual([]);
  } finally {
    await s.close();
  }
}

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
const meets = (a: Box, b: Box) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

// ─── the eight placements ────────────────────────────────────────────────
/** Distances of the launcher (and, open, of the panel and its origin) from the viewport's edges. */
async function geometry(s: CallSession, g: GeometrySpec): Promise<string[]> {
  const fail: string[] = [];
  const near = (name: string, got: number, want: number) => { if (Math.abs(got - want) > TOL) fail.push(`${name} ${got.toFixed(2)} (expected ${want})`); };
  const m = await s.page.evaluate((sel) => {
    const el = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector(`.ccw-launcher-wrap ${sel}`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom, width: r.width, vw: innerWidth, vh: innerHeight };
  }, g.launcher);
  if (!m) return [`launcher ${g.launcher} missing`];
  const e = g.expect;
  if (e.right !== undefined) near('right', m.right, e.right);
  if (e.left !== undefined) near('left', m.left, e.left);
  if (e.bottom !== undefined) near('bottom', m.bottom, e.bottom);
  if (e.top !== undefined) near('top', m.top, e.top);
  if (e.centerX) near('centre offset', m.left + m.width / 2 - m.vw / 2, 0);
  if (e.middleY) near('top (50% − 80px)', m.top, m.vh / 2 - 80);
  if (e.fullWidth) { near('left', m.left, 0); near('right', m.right, 0); }
  if (!g.origin) return fail;
  await s.open();
  const o = await s.page.evaluate(() => {
    const p = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-panel') as HTMLElement;
    const [x, y] = getComputedStyle(p).transformOrigin.split(' ').map(parseFloat);
    const r = p.getBoundingClientRect();
    return { x, y, w: p.offsetWidth, h: p.offsetHeight, left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom, vw: innerWidth, vh: innerHeight };
  });
  near('origin x', o.x, g.origin[0] * o.w);
  near('origin y', o.y, g.origin[1] * o.h);
  const pe = g.panel;
  if (pe) {
    near('panel width', o.w, 400);
    near('panel height', o.h, 660);
    if (pe.right !== undefined) near('panel right', o.right, pe.right);
    if (pe.left !== undefined) near('panel left', o.left, pe.left);
    if (pe.bottom !== undefined) near('panel bottom', o.bottom, pe.bottom);
    if (pe.top !== undefined) near('panel top', o.top, pe.top);
    if (pe.centerX) near('panel centre offset', o.left + o.w / 2 - o.vw / 2, 0);
    if (pe.edgeTop) near('panel top (max(20px, 50% − 330px))', o.top, Math.max(20, o.vh / 2 - 330));
  }
  // The launcher leaves while the panel is open (D13: also at the bottom centre), once its fade is over.
  const gone = await s.page.waitForFunction(() => {
    const w = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-launcher-wrap')!;
    return getComputedStyle(w).visibility === 'hidden';
  }, undefined, { timeout: 2_000 }).then(() => true, () => false);
  if (!gone) fail.push('the launcher stays while the panel is open');
  return fail;
}

for (const brand of BRANDS) {
  test.describe(`${brand}: the eight placements (1440×900 and a phone)`, () => {
    for (const st of callStates(brand).filter((x) => x.kind === 'G')) {
      test(`${st.id}`, async ({ browser }) => {
        const mobile = !!st.live.mobile;
        await withSession(browser, { brand, mobile, viewport: mobile ? undefined : DESKTOP, boot: st.live.boot }, async (s) => {
          const g = st.geometry!;
          const missing = await s.page.evaluate((cls) => {
            const w = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-launcher-wrap')!;
            return cls.filter((c) => !w.classList.contains(c));
          }, g.wrapClasses);
          expect(missing, 'placement classes on the wrap').toEqual([]);
          expect(await geometry(s, g), JSON.stringify(st.live.boot)).toEqual([]);
        });
      });
    }
  });
}

// ─── two widgets ─────────────────────────────────────────────────────────
interface Stack { gap: number; overlap: boolean; stack: string; call: Box; chat: Box }

/** The call launcher (or bar) against the chat launcher, once both stand still (the stack is measured on a frame). */
async function stack(s: CallSession): Promise<Stack> {
  let last = '';
  let r: Stack | null = null;
  for (let i = 0; i < 25; i++) {
    await s.frames(2);
    const call = (await s.rect('.ccw-launcher-wrap > *'))!;
    const chat = (await s.rect('.launcher', 'chat'))!;
    const st = await s.page.evaluate(() => (document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-launcher-wrap') as HTMLElement).style.getPropertyValue('--ccw-stack'));
    r = { gap: chat.y - call.bottom, overlap: meets(call, chat), stack: st, call, chat };
    const key = JSON.stringify(r);
    if (key === last) break;
    last = key;
  }
  return r!;
}

function expectStacked(r: Stack, label: string): void {
  expect(Math.abs(r.gap - 16), `${label}: call bottom = chat top − 16 (gap ${r.gap.toFixed(2)}, call ${JSON.stringify(r.call)}, chat ${JSON.stringify(r.chat)})`).toBeLessThanOrEqual(TOL);
  expect(r.overlap, `${label}: no overlap`).toBe(false);
}

const iso = (brand: Brand, agoMs: number) => new Date(frozenNow(brand) - agoMs).toISOString();

for (const brand of BRANDS) {
  for (const first of ['call', 'chat'] as const) {
    test.describe(`${brand}: beside the chat widget, ${first} loaded first`, () => {
      const both = (more: Partial<SessionOptions> & { chat?: ChatOptions } = {}): SessionOptions => ({ brand, first, chat: {}, viewport: DESKTOP, ...more });

      test('same side (right): 16px above the chat launcher, no overlap', async ({ browser }) => {
        await withSession(browser, both(), async (s) => { expectStacked(await stack(s), 'right'); });
      });

      test('same side (left)', async ({ browser }) => {
        await withSession(browser, both({ boot: { config: { widget_position: 'left' } }, chat: { position: 'bottom-left' } }), async (s) => {
          expectStacked(await stack(s), 'left');
        });
      });

      test('on a phone (the chat 12px from the corner): the pill stacks', async ({ browser }) => {
        await withSession(browser, both({ viewport: undefined, mobile: true }), async (s) => {
          const r = await stack(s);
          expect(r.chat.bottom, 'the chat at 12px').toBeCloseTo(844 - 12, 0);
          expectStacked(r, 'phone');
          expect(await s.w('.ccw-launcher-wrap .ln-p').count(), 'the pill').toBe(1);
        });
      });

      test('a chat launcher of another size (scale 1.4, then a pill with its label)', async ({ browser }) => {
        await withSession(browser, both({ chat: { fab: { scale: 1.4 } } }), async (s) => {
          const r = await stack(s);
          expect(r.chat.height, 'the bigger chat launcher').toBeGreaterThan(70);
          expectStacked(r, 'scale 1.4');
        });
        await withSession(browser, both({ chat: { fab: { shape: 'pill', icon: 'bubble', label: brand === 'webyar' ? 'گفتگو با ما' : 'Chat with us' }, fabStyle: true } }), async (s) => {
          await s.page.waitForFunction(() => !!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.launcher.fx-pill'));
          const r = await stack(s);
          expect(r.chat.width, 'the pill is wider than the round button').toBeGreaterThan(r.chat.height);
          expectStacked(r, 'pill');
        });
      });

      test('a minimised bar (Se in the queue, Sf in a call) stacks too, though wider', async ({ browser }) => {
        await withSession(browser, both({
          boot: { active_call: { call_id: CALL_ID, session: 'sess-call', call_type: 'voice', state: 'queued', created_at: iso(brand, 47_000), queue_position: 3 } },
          sessionStorage: { [ACTIVE_SESSION_KEY]: 'sess-call' },
          call: { state: 'queued', call_type: 'voice', agent: null, name: null, started_at: null, position: 3, eta: 180, recording_state: null },
          liveKit: { present: [{ id: 'op-a' }] },
        }), async (s) => {
          await s.waitScreen('queue');
          await s.w('.scr.on [data-action=minimize]').first().click();
          await s.waitOpen(false);
          await expect(s.w('.ccw-launcher-wrap .mc')).toBeVisible();
          expectStacked(await stack(s), 'Se');
          // The operator answers: the bar becomes Sf (a call), still above the chat.
          s.server.call = { ...s.server.call!, state: 'active', agent: 'ref-a', name: DEMO[brand].operatorName, started_at: iso(brand, 5_000), position: null, eta: null };
          await s.page.clock.runFor(5_000);
          await s.page.waitForFunction(() => !!document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-launcher-wrap .mc .wvs'), undefined, { timeout: 10_000 });
          expectStacked(await stack(s), 'Sf');
        });
      });
    });
  }

  test.describe(`${brand}: beside the chat widget`, () => {
    test('bottom centre on a narrow phone with the chat at the corner: stacked when the spans meet, never overlapping', async ({ browser }, info) => {
      // 360px: WebYar's Persian pill reaches the chat's corner; Respok's English one only on a 320px screen.
      const width = brand === 'webyar' ? 360 : 320;
      await withSession(browser, { brand, chat: {}, mobile: true, viewport: { width, height: 740 }, boot: { config: { widget_position: 'bottom_center' } } }, async (s) => {
        const r = await stack(s);
        const meet = r.call.right + 16 > r.chat.x && r.chat.right + 16 > r.call.x;
        info.annotations.push({ type: 'centre', description: `${width}px: call ${r.call.x.toFixed(1)}–${r.call.right.toFixed(1)}, chat ${r.chat.x}–${r.chat.right}, meet ${meet}` });
        expect(meet, `the spans meet at ${width}px (widened by 16px)`).toBe(true);
        expectStacked(r, 'centre');
      });
    });

    test('mobile_bar on a phone with the chat: the pill, stacked', async ({ browser }) => {
      await withSession(browser, { brand, chat: {}, mobile: true, boot: { config: { launcher_style: 'mobile_bar' } } }, async (s) => {
        await expect(s.w('.ccw-launcher-wrap .ln-p')).toBeVisible();
        expect(await s.w('.ccw-launcher-wrap .mbar').count(), 'no full-width bar under the chat launcher').toBe(0);
        expectStacked(await stack(s), 'mobile_bar');
      });
    });

    test('different corners, a top placement, the edge tab: no stacking', async ({ browser }) => {
      const boots: JsonObject[] = [
        { config: { widget_position: 'left' } },
        { config: { widget_position: 'top_right' } },
        { config: { launcher_style: 'edge_tab', widget_position: 'right' } },
      ];
      for (const boot of boots) {
        await withSession(browser, { brand, chat: {}, viewport: DESKTOP, boot }, async (s) => {
          const r = await stack(s);
          expect(r.stack || '0px', JSON.stringify(boot)).toBe('0px');
          expect(r.overlap, JSON.stringify(boot)).toBe(false);
        });
      }
    });

    test('the chat panel open: the call launcher drops back to its corner, under the chat panel', async ({ browser }) => {
      await withSession(browser, { brand, chat: {}, viewport: DESKTOP }, async (s) => {
        expectStacked(await stack(s), 'before');
        await s.chat('.launcher').click();
        await s.page.waitForFunction(() => !!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.launcher.open'), undefined, { timeout: 10_000 });
        const r = await stack(s);
        expect(r.stack, 'stack 0').toBe('0px');
        expect(Math.round(DESKTOP.height - r.call.bottom), 'at its corner offset').toBe(22);
        const top = await s.page.evaluate((b) => document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.tagName.toLowerCase(), r.call);
        expect(top, 'the chat panel covers the call launcher').toBe('gs-widget');
        // Closed again: back above the chat launcher.
        await s.page.evaluate(() => (window as unknown as { __gs: { push(c: string[]): void } }).__gs.push(['close']));
        await s.page.waitForFunction(() => !document.querySelector('gs-widget')?.shadowRoot?.querySelector('.launcher.open'));
        await s.waitChat();
        expectStacked(await stack(s), 'after');
      });
    });

    test('the call panel open: at its corner (not stacked), above the chat launcher', async ({ browser }) => {
      await withSession(browser, { brand, chat: {}, viewport: DESKTOP }, async (s) => {
        await s.w('.ccw-launcher-wrap .ccw-launcher-btn').first().click();
        await s.waitOpen(true);
        const p = (await s.rect('#ccw-panel'))!;
        expect([Math.round(DESKTOP.width - p.right), Math.round(DESKTOP.height - p.bottom)], 'the corner offsets').toEqual([22, 22]);
        const chat = (await s.rect('.launcher', 'chat'))!;
        expect(meets(p, chat), 'the panel covers the chat launcher\'s corner').toBe(true);
        const top = await s.page.evaluate((b) => document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.id, chat);
        expect(top, 'the call panel is on top').toBe('call-center-widget-host');
        const z = await s.page.evaluate(() => getComputedStyle(document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('#ccw-panel')!).zIndex);
        expect(z).toBe('2147483647');
      });
    });
  });
}

// ─── the page held by two phone panels ───────────────────────────────────
test.describe('two phone panels hold the page; it comes back whichever closes first', () => {
  type Who = 'call' | 'chat';
  const orders: Array<{ open: [Who, Who]; close: [Who, Who] }> = [
    { open: ['chat', 'call'], close: ['chat', 'call'] },
    { open: ['chat', 'call'], close: ['call', 'chat'] },
    { open: ['call', 'chat'], close: ['call', 'chat'] },
    { open: ['call', 'chat'], close: ['chat', 'call'] },
  ];
  for (const o of orders) {
    test(`open ${o.open.join(' then ')}, close ${o.close.join(' then ')}`, async ({ browser }, info) => {
      await withSession(browser, { brand: 'webyar', chat: {}, mobile: true, tall: true }, async (s) => {
        await s.page.evaluate(() => window.scrollTo(0, 900));
        const act = async (who: Who, open: boolean) => {
          if (who === 'call') {
            await s.page.evaluate((want) => { const c = (window as unknown as CallWin).CallCenterWidget; if (c.open !== want) c.toggleOpen(); }, open);
            await s.waitOpen(open);
          } else {
            await s.page.evaluate((cmd) => (window as unknown as { __gs: { push(c: string[]): void } }).__gs.push([cmd]), open ? 'open' : 'close');
            await s.page.waitForFunction((want) => !!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.shell.gs-mobile-open') === want, open, { timeout: 10_000 });
          }
          await s.page.waitForTimeout(150);
        };
        const body = () => s.page.evaluate(() => ({ position: document.body.style.position, top: document.body.style.top, scroll: Math.round(scrollY) }));
        await act(o.open[0], true);
        await act(o.open[1], true);
        expect((await body()).position, 'held while both are open').toBe('fixed');
        await act(o.close[0], false);
        // The panel still open keeps the page held, whichever widget took the hold first (each takes it over
        // when the other lets go), where it was.
        const between = await body();
        info.annotations.push({ type: 'page while the second panel is open', description: JSON.stringify(between) });
        expect([between.position, between.top], `${o.close[1]}'s panel still open: the page stays held`).toEqual(['fixed', '-900px']);
        await act(o.close[1], false);
        expect(await body(), 'the page is free again, where it was').toEqual({ position: '', top: '', scroll: 900 });
      });
    });
  }
});

