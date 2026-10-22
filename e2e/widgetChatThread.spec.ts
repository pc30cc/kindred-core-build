/**
 * The chat after the owner's screenshots of RESPOK's widget on respok.app
 * (2026-10-18), in Template 2 (t2-intl, RESPOK's site: en, #EF4444; t2,
 * WebYar's: fa, #8B5CF6) and, where it had the same defects, Template 1 (t1,
 * WebYar's site; t1-intl): the help bar, the visitor's bubble (its quote and
 * links too) and the text buttons read on any workspace colour; the bar
 * names the workspace with the operator answering small under it, a long
 * name ending in an ellipsis; a name over a run only where the team's side
 * changes hands; the typing and thinking rows' avatar sits on their bubble's
 * bottom; a message's actions show only on the line touched, hovered or
 * reached by a key; the emoji grid opens inside the message box.
 *
 * Real browser (the template harness launches its own Chromium, the phone
 * states with touch); no running stack. Every wait is on a condition.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderTemplateScreens, type ScreenOptions } from './harness/templateScreens';

type Variant = Omit<ScreenOptions, 'outDir'> & { workspace: string; sara: string; mehdi: string };
/** As production wears them. */
const VARIANTS: Variant[] = [
  {
    templateId: 't2-intl', locale: 'en', accent: '#EF4444', edition: 'international',
    templateOptions: { csat: true, transcriptEmail: true, logoDirection: 'thread', topics: [], askExamples: [] },
    workspace: 'Nilufar Store', sara: 'Sara', mehdi: 'Mehdi',
  },
  { templateId: 't2', locale: 'fa', accent: '#8B5CF6', edition: 'iran', workspace: 'فروشگاه نیلوفر', sara: 'سارا', mehdi: 'مهدی' },
];

/** Runs `check` on each state right before its shot; every state must be checked. */
async function onStates(v: Variant, states: string[], check: (page: Page, state: string) => Promise<void>, accent = v.accent) {
  const out = mkdtempSync(path.join(os.tmpdir(), `chat-thread-${v.templateId}-`));
  const checked: string[] = [];
  try {
    await renderTemplateScreens({
      templateId: v.templateId, locale: v.locale, accent, edition: v.edition, templateOptions: v.templateOptions,
      outDir: out, states,
      beforeShot: async (page, state) => { await check(page, state); checked.push(state); },
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  expect(checked).toEqual(states);
}

// ─── WCAG 2 contrast of computed colours ────────────────────────────────
type Rgb = [number, number, number];
function rgb(css: string): Rgb {
  expect(css).toMatch(/^rgba?\(/);
  const [r, g, b] = css.match(/[\d.]+/g)!.map(Number);
  return [r, g, b];
}
/** A colour drawn at `alpha` over `bg`. */
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
const lum = (c: Rgb) => {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const wcag = (x: Rgb, y: Rgb) => {
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The ratio of the first line of text in `fill` (or in its `part`) to what
 * lies under it: `fill`'s own colour, or its sheen (`--a-hi` at the top, `--a`
 * from the gradient's stop down) where the line's top is, under a tinted box
 * between them if there is one; the text's ink with the opacities between it
 * and `fill`. Colours come out of a canvas as sRGB whatever their notation.
 */
async function inkOn(fill: Locator, part?: string) {
  /** Null while Core is painting the line again (the node read is gone: no box). */
  const read = () => fill.evaluate((el, sel) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const srgb = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data); };
    const tone = (v: string) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${v})`;
      el.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return srgb(c);
    };
    const root = sel ? el.querySelector(sel)! : el;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? 1 : 3) });
    const text = walker.nextNode()!;
    let alpha = 1, tint = [0, 0, 0, 0];
    for (let n = text.parentElement; n && n !== el; n = n.parentElement) {
      const k = getComputedStyle(n);
      alpha *= Number(k.opacity);
      if (!tint[3]) tint = srgb(k.backgroundColor);
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = el.getBoundingClientRect(), line = range.getClientRects()[0], c = getComputedStyle(el);
    if (!el.isConnected || !line) return null;
    const stop = / (\d+(?:\.\d+)?)%\)$/.exec(c.backgroundImage);
    return {
      ink: srgb(getComputedStyle(text.parentElement!).color), alpha, tint, image: c.backgroundImage, bg: srgb(c.backgroundColor),
      hi: tone('--a-hi'), a: tone('--a'), at: (line.top - box.top) / box.height, stop: stop ? Number(stop[1]) / 100 : 1,
    };
  }, part).catch(() => null);
  let got = await read();
  // Painted again under the read: read it once it is drawn.
  if (!got) await expect.poll(async () => (got = await read()) !== null).toBe(true);
  const seen = got!;
  const k = Math.min(seen.at / seen.stop, 1);
  let under = (seen.image === 'none' ? seen.bg.slice(0, 3) : [0, 1, 2].map((i) => seen.hi[i] + (seen.a[i] - seen.hi[i]) * k)) as Rgb;
  if (seen.tint[3]) under = over(seen.tint.slice(0, 3) as Rgb, under, seen.tint[3] / 255);
  const ink = over(seen.ink.slice(0, 3) as Rgb, under, seen.alpha * (seen.ink[3] / 255));
  return { ratio: wcag(ink, under), seen };
}

/** On a phone: reply to Sara's second line with a link, and wait for the sent bubble. */
async function replyWithLink(page: Page, en: boolean) {
  const line = page.locator('[data-chat-messages] .msg.operator').nth(1);
  await line.tap();
  await line.locator('xpath=..').locator('[data-msg-reply]').tap();
  const input = page.locator('[data-msg-input]');
  await expect(input).toBeFocused();
  await input.fill(`${en ? 'Yes, order 48213:' : 'بله، سفارش ۴۸۲۱۳:'} https://shop.example/o/48213`);
  await input.press('Enter');
  const mine = page.locator('[data-chat-messages] .msg.visitor').last();
  await expect(mine.locator('.msg-quote')).toBeVisible();
  await expect(mine.locator('.msg-link')).toBeVisible();
  // Sent (Core paints the line again once the server has it).
  await expect(page.locator('[data-chat-messages] .msg-row.visitor').last().locator('.msg-ticks:not(.is-sending)')).toBeAttached();
}

/**
 * On a phone: a link in a bubble, hovered (a tap on it hovers it), leaves its
 * line's actions hidden; the rest of the bubble still shows them. Revealed by
 * that tap, they made iOS Safari take it for a hover only and drop its click,
 * so the link opened on the second tap (iOS 26.4 Simulator, real touches,
 * 2026-10-22). Chromium has no such rule, so the styles are what is checked.
 */
async function linkKeepsActionsHidden(page: Page, en: boolean) {
  await replyWithLink(page, en);
  const mine = page.locator('[data-chat-messages] .msg.visitor').last();
  const actions = mine.locator('xpath=..').locator(':scope > .msg-actions');
  const state = () => actions.evaluate((g) => { const c = getComputedStyle(g); return `${c.opacity} ${c.pointerEvents}`; });
  await mine.locator('.msg-link').hover();
  await expect.poll(state).toBe('0 none');
  await mine.locator('.msg-quote').hover();
  await expect.poll(state).toBe('1 auto');
  await mine.locator('.msg-link').hover();
  await expect.poll(state).toBe('0 none');
}

/** The panel's `--a` as each accent comes out (the brand colour is the stylesheet's). */
const PANEL_ACCENT: Record<string, Record<string, string>> = {
  't2-intl': { '#EF4444': '#CB3939', '#FDE047': '#FDE047', '#1E1B4B': '#1E1B4B', '#3B82F6': '#16142B' },
  t2: { '#8B5CF6': '#7D53DF', '#FDE047': '#FDE047', '#1E1B4B': '#1E1B4B', '#3B82F6': '#0B7D6C' },
};

for (const v of VARIANTS) {
  for (const accent of Object.keys(PANEL_ACCENT[v.templateId as string])) {
    test(`${v.templateId} ${accent}: the help bar and the visitor's bubble read at 4.5:1 or more`, async () => {
      test.setTimeout(120_000);
      await onStates(v, ['mobile-help-open-empty', 'mobile-chat-operator'], async (page, state) => {
        const a = await page.locator('.wy-view:not(.wy-skeleton)').first()
          .evaluate((el) => getComputedStyle(el).getPropertyValue('--a').trim().toUpperCase());
        expect(a).toBe(PANEL_ACCENT[v.templateId as string][accent]);
        if (state === 'mobile-help-open-empty') {
          // Flat (the skin's Ink bar under the base's Ink text was 1:1).
          const bar = await page.locator('.cta').evaluate((el) => {
            const c = getComputedStyle(el);
            const line = (s: string) => {
              const k = getComputedStyle(el.querySelector(s)!);
              return { color: k.color, opacity: Number(k.opacity) };
            };
            return { bg: c.backgroundColor, image: c.backgroundImage, title: line('.tx'), sub: line('.tx small') };
          });
          expect(bar.image).toBe('none');
          for (const t of [bar.title, bar.sub]) {
            expect(wcag(over(rgb(t.color), rgb(bar.bg), t.opacity), rgb(bar.bg)), JSON.stringify(t)).toBeGreaterThanOrEqual(4.5);
          }
        } else {
          const bubble = await page.locator('.msg.visitor').first().evaluate((el) => {
            const c = getComputedStyle(el);
            // `--a` resolved: a probe in the bubble, out again before anything paints.
            const probe = document.createElement('i');
            probe.style.color = 'var(--a)';
            el.appendChild(probe);
            const fill = getComputedStyle(probe).color;
            probe.remove();
            return { bg: c.backgroundColor, image: c.backgroundImage, color: c.color, fill };
          });
          // The skin draws it flat; the base's sheen ends at 30 %, above the text.
          if (bubble.image !== 'none') expect(bubble.image).toMatch(/ 30%\)$/);
          const under = bubble.image === 'none' ? bubble.bg : bubble.fill;
          expect(wcag(rgb(bubble.color), rgb(under))).toBeGreaterThanOrEqual(4.5);
          // A mid-tone accent carries white (Ink on #EF4444 / #8B5CF6 did not read).
          if (accent === '#EF4444' || accent === '#8B5CF6') expect(bubble.color).toBe('rgb(255, 255, 255)');
        }
      }, accent);
    });
  }

  test(`${v.templateId}: the bar names the workspace, the operator small under it; a name only where the team's side changes hands`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator', 'mobile-chat-handover'], async (page, state) => {
      const seen = await page.evaluate(() => {
        const sh = document.getElementById('gs-host')!.shadowRoot!;
        const head = sh.querySelector('[data-chat-header]')!;
        const nm = head.querySelector('.nm')!, st = head.querySelector('.st')!;
        return {
          title: nm.textContent, line: st.textContent, dot: !!st.querySelector('.ondot'),
          smaller: parseFloat(getComputedStyle(st).fontSize) < parseFloat(getComputedStyle(nm).fontSize),
          labels: Array.from(sh.querySelectorAll('[data-chat-messages] .msg-sender-label')).map((l) => l.textContent),
        };
      });
      const answering = state === 'mobile-chat-operator' ? v.sara : v.mehdi;
      expect(seen).toEqual({
        title: v.workspace, line: answering, dot: true, smaller: true,
        // Sara answers all along: no name; the AI → Sara → Mehdi: both, once.
        labels: state === 'mobile-chat-operator' ? [] : [v.sara, v.mehdi],
      });
    });
  });

  test(`${v.templateId}: the typing and thinking rows sit their avatar on the bubble's bottom`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator', 'mobile-chat-ai-thinking'], async (page, state) => {
      const row = state === 'mobile-chat-operator' ? '.typing-row' : '.ai-thinking-row';
      if (state === 'mobile-chat-operator') {
        await page.evaluate((name) => (window as unknown as { __gsTyping: (p: unknown) => void }).__gsTyping({ actor: 'agent', name }), v.sara);
      }
      await expect(page.locator(`[data-chat-messages] ${row} .typing-bubble`)).toBeVisible();
      await expect.poll(() => page.locator(`[data-chat-messages] ${row}`).evaluate((r) => {
        const a = r.querySelector('.msg-avatar')!.getBoundingClientRect();
        const b = r.querySelector('.typing-bubble')!.getBoundingClientRect();
        return Math.abs(a.bottom - b.bottom) <= 1;
      })).toBe(true);
    });
  });

  test(`${v.templateId}: a message's actions show only on the line tapped, hovered or reached by a key`, async () => {
    test.setTimeout(120_000);
    /**
     * Each line's actions: 1 shown and taking the pointer, 0 hidden (on a
     * touch screen taking no taps; a mouse finds them where they are drawn),
     * -1 in between.
     */
    let touch = true;
    const groups = (page: Page) => page.evaluate((hiddenEvents) => Array.from(document.getElementById('gs-host')!.shadowRoot!
      .querySelectorAll('[data-chat-messages] .msg-actions')).map((g) => {
      const c = getComputedStyle(g);
      if (c.opacity === '1' && c.pointerEvents === 'auto') return 1;
      return c.opacity === '0' && c.pointerEvents === hiddenEvents ? 0 : -1;
    }), touch ? 'none' : 'auto');
    /** All hidden but the line holding `bubble`'s. */
    const only = async (page: Page, bubble: ReturnType<Page['locator']>) => {
      const i = await bubble.evaluate((b) => Array.from((b.getRootNode() as ShadowRoot).querySelectorAll('[data-chat-messages] .msg-actions'))
        .indexOf(b.closest('.msg-line')!.querySelector(':scope > .msg-actions')!));
      expect(i).toBeGreaterThanOrEqual(0);
      const n = (await groups(page)).length;
      return Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
    };
    await onStates(v, ['mobile-chat-operator', 'chat-operator'], async (page, state) => {
      touch = state === 'mobile-chat-operator';
      // At rest: every line's actions hidden.
      expect((await groups(page)).length).toBeGreaterThan(3);
      await expect.poll(async () => (await groups(page)).every((g) => g === 0)).toBe(true);
      if (state === 'mobile-chat-operator') {
        // A tap hovers the line it lands on (iOS and Android alike); another tap moves it.
        const second = page.locator('[data-chat-messages] .msg.operator').nth(1);
        await second.tap();
        const want = await only(page, second);
        await expect.poll(() => groups(page)).toEqual(want);
        const mine = page.locator('[data-chat-messages] .msg.visitor').last();
        await mine.tap();
        const wantMine = await only(page, mine);
        await expect.poll(() => groups(page)).toEqual(wantMine);
        // Beside the visitor's bubble, where nothing is drawn: none.
        const at = await mine.evaluate((b) => {
          const host = b.closest('[data-chat-messages]')!.getBoundingClientRect(), r = b.getBoundingClientRect();
          return { x: host.left + 12, y: r.top + r.height / 2 };
        });
        await page.touchscreen.tap(at.x, at.y);
        await expect.poll(async () => (await groups(page)).every((g) => g === 0)).toBe(true);
      } else {
        const second = page.locator('[data-chat-messages] .msg.operator').nth(1);
        await second.hover();
        await expect.poll(() => groups(page)).toEqual(await only(page, second));
        await page.mouse.move(0, 0);
        await expect.poll(async () => (await groups(page)).every((g) => g === 0)).toBe(true);
        // Straight onto a line's hidden actions, not over its bubble (the
        // way back after leaving a tall one sideways): they show, under the pointer.
        const reply = second.locator('xpath=..').locator('[data-msg-reply]');
        const at = await reply.evaluate((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await page.mouse.move(at.x, at.y);
        await expect.poll(() => groups(page)).toEqual(await only(page, second));
        expect(await reply.evaluate((b, p) => (b.getRootNode() as ShadowRoot).elementFromPoint(p.x, p.y)?.closest('[data-msg-reply]') === b, at)).toBe(true);
        await page.mouse.move(0, 0);
        await expect.poll(async () => (await groups(page)).every((g) => g === 0)).toBe(true);
        // The keyboard: back from the message field into the thread's last line.
        await page.locator('[data-msg-input]').focus();
        const inActions = () => page.evaluate(() => {
          const el = document.getElementById('gs-host')!.shadowRoot!.activeElement;
          return !!el && !!el.closest('.msg-actions');
        });
        for (let i = 0; i < 6 && !(await inActions()); i++) await page.keyboard.press('Shift+Tab');
        expect(await inActions()).toBe(true);
        const focused = page.locator('[data-chat-messages] .msg-actions :focus');
        await expect(focused).toHaveAttribute('aria-label', /.+/);
        await expect.poll(() => groups(page)).toEqual(await only(page, focused));
      }
    });
  });

  test(`${v.templateId}: the emoji grid opens inside the message box, which grows upward`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator'], async (page) => {
      const geo = () => page.evaluate(() => {
        const sh = document.getElementById('gs-host')!.shadowRoot!;
        const p = sh.querySelector('[data-emoji-picker]') as HTMLElement, wrap = p.parentElement!;
        // The room it takes in the box: the box with it, less the box
        // without it (put back in the same task, so nothing paints it).
        const s = p.style, prev = s.display;
        const withIt = wrap.getBoundingClientRect().height;
        s.display = 'none';
        const without = wrap.getBoundingClientRect().height;
        s.display = prev;
        const active = sh.activeElement as HTMLElement | null;
        return {
          hidden: p.hidden, first: wrap.matches('[data-input-wrap]') && wrap.firstElementChild === p,
          room: Math.round(withIt - without), top: wrap.getBoundingClientRect().top,
          input: sh.querySelector('[data-msg-input]')!.getBoundingClientRect().top,
          host: sh.querySelector('[data-chat-messages]')!.getBoundingClientRect().height,
          field: !!active && active.matches('[data-msg-input]'),
        };
      });
      const closed = await geo();
      expect(closed).toMatchObject({ hidden: true, first: true, room: 0 });
      await page.locator('[data-emoji-btn]').tap();
      // Open: the box grows upward by the grid (its top rises, the text
      // field stays where it was) and the thread gives up as much.
      await expect.poll(async () => {
        const g = await geo();
        return { hidden: g.hidden, first: g.first, tall: g.room > 100, top: Math.abs(closed.top - g.top - g.room) <= 2,
          input: Math.abs(g.input - closed.input) <= 1, host: Math.abs(closed.host - g.host - g.room) <= 2 };
      }).toEqual({ hidden: false, first: true, tall: true, top: true, input: true, host: true });
      await page.keyboard.press('Escape');
      await expect.poll(async () => {
        const g = await geo();
        return { hidden: g.hidden, room: g.room, field: g.field, top: Math.abs(g.top - closed.top) <= 1, host: Math.abs(g.host - closed.host) <= 1 };
      }).toEqual({ hidden: true, room: 0, field: true, top: true, host: true });
    });
  });

  test(`${v.templateId}: a keyboard-focused emoji's ring is drawn whole inside the grid`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['chat-operator'], async (page) => {
      await page.locator('[data-emoji-btn]').focus();
      await page.keyboard.press('Enter');
      const first = page.locator('[data-emoji-picker] button').first();
      await expect(first).toBeVisible();
      // After a key, a focus from script is a keyboard focus too (:focus-visible).
      await first.focus();
      const ring = await first.evaluate((b) => {
        const grid = b.closest('[data-emoji-picker]')!, g = grid.getBoundingClientRect(), r = b.getBoundingClientRect();
        const s = getComputedStyle(b), reach = Math.max(parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth), 0);
        // The grid scrolls: what is past its padding box is cut.
        const box = { top: g.top + grid.clientTop, left: g.left + grid.clientLeft };
        return {
          shown: b.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0,
          inside: r.top - reach >= box.top - 0.5 && r.left - reach >= box.left - 0.5
            && r.right + reach <= box.left + grid.clientWidth + 0.5 && r.bottom + reach <= box.top + grid.clientHeight + 0.5,
        };
      });
      expect(ring).toEqual({ shown: true, inside: true });
    });
  });

  test(`${v.templateId}: a long name on the bar ends in an ellipsis, and the typing dots after the operator's stay in view`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-long-names'], async (page) => {
      const bar = () => page.evaluate(() => {
        const head = document.getElementById('gs-host')!.shadowRoot!.querySelector('[data-chat-header]')!;
        const st = head.querySelector('.st')!, line = st.getBoundingClientRect();
        /** The box holding a line's words: cut short, with an ellipsis. */
        const words = (el: Element) => {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? 1 : 3) });
          const box = w.nextNode()!.parentElement!;
          return { ellipsis: getComputedStyle(box).textOverflow === 'ellipsis', cut: box.scrollWidth > box.clientWidth };
        };
        return {
          title: words(head.querySelector('.nm')!), line: words(st), typing: st.classList.contains('typ'),
          // Each dot drawn, inside the line's box.
          dots: Array.from(st.querySelectorAll('i:not(.ondot)')).map((i) => {
            const d = i.getBoundingClientRect();
            return d.width > 0 && d.left >= line.left - 0.5 && d.right <= line.right + 0.5;
          }),
        };
      });
      const cut = { ellipsis: true, cut: true };
      expect(await bar()).toEqual({ title: cut, line: cut, typing: false, dots: [] });
      await page.evaluate(() => (window as unknown as { __gsTyping: (p: unknown) => void }).__gsTyping({ actor: 'agent' }));
      await expect.poll(bar).toEqual({ title: cut, line: cut, typing: true, dots: [true, true, true] });
    });
  });

  test(`${v.templateId}: on a phone a tap on a link in a bubble leaves its line's actions hidden, so iOS opens it on that tap`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator'], (page) => linkKeepsActionsHidden(page, v.locale !== 'fa'));
  });

  test(`${v.templateId}: the visitor's reply reads whole: its quote, its text and a link in it at 4.5:1 or more`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator'], async (page) => {
      await replyWithLink(page, v.locale !== 'fa');
      const mine = page.locator('[data-chat-messages] .msg.visitor').last();
      for (const part of ['.msg-quote', '.msg-text', '.msg-link']) {
        const { ratio, seen } = await inkOn(mine, part);
        expect(ratio, `${part} ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  test(`${v.templateId}: the text buttons on the accent read at 4.5:1 or more`, async () => {
    test.setTimeout(150_000);
    /** Pre-chat's submit, the rating's, and "New conversation". */
    const BUTTON: Record<string, string> = { 'prechat-form-error': '.btn[data-prechat-submit]', 't2-rating': '[data-csat-submit]', 't2-conversations': '.fab' };
    await onStates(v, Object.keys(BUTTON), async (page, state) => {
      const button = page.locator(BUTTON[state]).first();
      await expect(button).toBeEnabled();
      const { ratio, seen } = await inkOn(button);
      expect(ratio, `${state} ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(4.5);
    }, v.accent);
  });
}

// ─── Template 1, where it had the same defects (owner, 2026-10-18) ──────
// WebYar's site wears t1 (fa, #8B5CF6); t1-intl is its RESPOK skin (en,
// #EF4444). The visitor's text and the help center's "start a chat" button
// on the accent, the bar's names, the names over the runs and the thinking
// row's avatar; the actions on a phone are a guard (t1 already showed them
// only on the line tapped) and the emoji grid was already in the box.
const T1_VARIANTS: Variant[] = [
  { templateId: 't1', locale: 'fa', accent: '#8B5CF6', edition: 'iran', workspace: 'فروشگاه نیلوفر', sara: 'سارا', mehdi: 'مهدی' },
  {
    templateId: 't1-intl', locale: 'en', accent: '#EF4444', edition: 'international', templateOptions: { logoDirection: 'thread' },
    workspace: 'Nilufar Store', sara: 'Sara', mehdi: 'Mehdi',
  },
];
const T1_PANEL_ACCENT: Record<string, Record<string, string>> = {
  t1: { '#8B5CF6': '#7D53DF', '#FDE047': '#FDE047', '#1E1B4B': '#1E1B4B', '#3B82F6': '#0B7D6C' },
  't1-intl': { '#EF4444': '#CB3939', '#FDE047': '#FDE047', '#1E1B4B': '#1E1B4B', '#3B82F6': '#16142B' },
};

for (const v of T1_VARIANTS) {
  for (const accent of Object.keys(T1_PANEL_ACCENT[v.templateId as string])) {
    test(`${v.templateId} ${accent}: the visitor's bubble and the help center's button read at 4.5:1 or more`, async () => {
      test.setTimeout(120_000);
      await onStates(v, ['mobile-help-open-empty', 'mobile-chat-operator'], async (page, state) => {
        const a = await page.locator('.wy-view:not(.wy-skeleton)').first()
          .evaluate((el) => getComputedStyle(el).getPropertyValue('--a').trim().toUpperCase());
        expect(a).toBe(T1_PANEL_ACCENT[v.templateId as string][accent]);
        const sel = state === 'mobile-help-open-empty' ? '.kb-empty .btn-p' : '.msg.visitor';
        // The text's first line box and the sheen over it: `--a-hi` at the
        // top, `--a` from 30 % down. Colours come out of a canvas as sRGB
        // whatever their notation (the stops are color-mix()es).
        const seen = await page.locator(sel).first().evaluate((el) => {
          const ctx = document.createElement('canvas').getContext('2d')!;
          const srgb = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)); };
          const tone = (v: string) => {
            const probe = document.createElement('i');
            probe.style.color = `var(${v})`;
            el.appendChild(probe);
            const c = getComputedStyle(probe).color;
            probe.remove();
            return srgb(c);
          };
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? 1 : 3) });
          const range = document.createRange();
          range.selectNodeContents(walker.nextNode()!);
          const box = el.getBoundingClientRect(), line = range.getClientRects()[0];
          const c = getComputedStyle(el);
          return { color: srgb(c.color), image: c.backgroundImage, hi: tone('--a-hi'), a: tone('--a'), at: (line.top - box.top) / box.height };
        });
        expect(seen.image).toMatch(/ 30%\)$/);
        const k = Math.min(seen.at / 0.3, 1);
        const under = [0, 1, 2].map((i) => seen.hi[i] + (seen.a[i] - seen.hi[i]) * k) as Rgb;
        expect(wcag(seen.color as Rgb, under), JSON.stringify(seen)).toBeGreaterThanOrEqual(4.5);
        // A mid-tone accent carries white (Ink on #8B5CF6 was 4.24:1, on #EF4444 Lc 39).
        if (accent === v.accent) expect(seen.color).toEqual([255, 255, 255]);
      }, accent);
    });
  }

  test(`${v.templateId}: the bar names the workspace, the operator small under it; a name only where the team's side changes hands`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator', 'mobile-chat-handover'], async (page, state) => {
      const seen = await page.evaluate(() => {
        const sh = document.getElementById('gs-host')!.shadowRoot!;
        const head = sh.querySelector('[data-chat-header]')!;
        const hn = head.querySelector('.hn')!, hs = head.querySelector('.hs')!;
        return {
          title: hn.textContent, line: hs.textContent, dot: !!head.querySelector('.who .av .pr:not(.off)'),
          smaller: parseFloat(getComputedStyle(hs).fontSize) < parseFloat(getComputedStyle(hn).fontSize),
          labels: Array.from(sh.querySelectorAll('[data-chat-messages] .msg-sender-label')).map((l) => l.textContent),
        };
      });
      expect(seen).toEqual({
        title: v.workspace, line: state === 'mobile-chat-operator' ? v.sara : v.mehdi, dot: true, smaller: true,
        // Sara answers all along: no name; the AI → Sara → Mehdi: both, once.
        labels: state === 'mobile-chat-operator' ? [] : [v.sara, v.mehdi],
      });
    });
  });

  test(`${v.templateId}: the thinking and typing rows sit their avatar on the bubble's bottom`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator', 'mobile-chat-ai-thinking'], async (page, state) => {
      const row = state === 'mobile-chat-operator' ? '.typing-row' : '.ai-thinking-row';
      if (state === 'mobile-chat-operator') {
        await page.evaluate((name) => (window as unknown as { __gsTyping: (p: unknown) => void }).__gsTyping({ actor: 'agent', name }), v.sara);
      }
      await expect(page.locator(`[data-chat-messages] ${row} .typing-bubble`)).toBeVisible();
      await expect.poll(() => page.locator(`[data-chat-messages] ${row}`).evaluate((r) => {
        const a = r.querySelector('.msg-avatar')!.getBoundingClientRect();
        const b = r.querySelector('.typing-bubble')!.getBoundingClientRect();
        return Math.abs(a.bottom - b.bottom) <= 1;
      })).toBe(true);
    });
  });

  test(`${v.templateId}: on a phone a message's actions stay hidden until its line is tapped, and only that line's show`, async () => {
    test.setTimeout(120_000);
    /** Each line's actions: 1 shown and taking taps, 0 hidden and taking none (-1 in between). */
    const groups = (page: Page) => page.evaluate(() => Array.from(document.getElementById('gs-host')!.shadowRoot!
      .querySelectorAll('[data-chat-messages] .msg-actions')).map((g) => {
      const c = getComputedStyle(g);
      if (c.opacity === '1' && c.pointerEvents === 'auto') return 1;
      return c.opacity === '0' && c.pointerEvents === 'none' ? 0 : -1;
    }));
    const only = async (page: Page, bubble: ReturnType<Page['locator']>) => {
      const i = await bubble.evaluate((b) => Array.from((b.getRootNode() as ShadowRoot).querySelectorAll('[data-chat-messages] .msg-actions'))
        .indexOf(b.closest('.msg-line')!.querySelector(':scope > .msg-actions')!));
      expect(i).toBeGreaterThanOrEqual(0);
      const n = (await groups(page)).length;
      return Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
    };
    await onStates(v, ['mobile-chat-operator'], async (page) => {
      expect((await groups(page)).length).toBeGreaterThan(3);
      await expect.poll(async () => (await groups(page)).every((g) => g === 0)).toBe(true);
      const second = page.locator('[data-chat-messages] .msg.operator').nth(1);
      await second.tap();
      const want = await only(page, second);
      await expect.poll(() => groups(page)).toEqual(want);
      const mine = page.locator('[data-chat-messages] .msg.visitor').last();
      await mine.tap();
      const wantMine = await only(page, mine);
      await expect.poll(() => groups(page)).toEqual(wantMine);
    });
  });

  test(`${v.templateId}: on a phone a tap on a link in a bubble leaves its line's actions hidden, so iOS opens it on that tap`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator'], (page) => linkKeepsActionsHidden(page, v.locale !== 'fa'));
  });

  test(`${v.templateId}: the visitor's reply reads whole: its quote, its text and a link in it at 4.5:1 or more`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['mobile-chat-operator'], async (page) => {
      await replyWithLink(page, v.locale !== 'fa');
      const mine = page.locator('[data-chat-messages] .msg.visitor').last();
      // The quote's author over its words, the text, the link's card.
      for (const part of ['.msg-quote', '.msg-text', '.msg-link']) {
        const { ratio, seen } = await inkOn(mine, part);
        expect(ratio, `${part} ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}
