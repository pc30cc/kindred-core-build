/**
 * The call widget's Tier A visual gate (build contract 00-contract §8.2):
 * every P/M/C state of both brands, live widget against the reference
 * re-render made in the same Chromium at the same moment, at most 0.20% of
 * pixels different after the documented masks, box probes within ±0.5px;
 * the placements (G) by geometry; board 12's tokens computed in the live
 * widget; the other direction (WebYar in English, Respok in Persian) as the
 * mirror image of the drawn one. Plus the harness's own sanity: the diff,
 * the fake video, the boot in the three serving modes with no foreign
 * request, and (with a full handoff package) the reference against the
 * owner's acceptance PNGs.
 *
 * Local gate (not in CI): npx playwright test e2e/callWidgetScreens.spec.ts --workers=1
 *   CALL_SCREENS_MATRIX=1         also every preset accent, the light accent #F5D90A and radius sm/lg
 *                                 (the harness's --matrix runs; about 6 minutes per run)
 *   CALL_HANDOFF_PACKAGE=<dir>    the owner's unpacked handoff (with screens/panels) for the reproduction test
 *   CALL_SCREENS_OUT=<dir>        keep the PNGs and report.json (default: the test's output folder)
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  ACCENT_PRESETS, BRANDS, BRAND_INFO, INK, LIGHT_ACCENT, PIXEL_KINDS, callStates, onAccent, stageHoldK, stageTintK, type Brand, type Radius,
} from './harness/callScreensFixture';
import {
  LiveRenderer, buildCallWidgetScratch, compareCallScreens, formatResult, type Mode, type StateResult,
} from './harness/callScreens';
import { ReferenceRenderer, resolveCallChromium } from './harness/callReference';
import { PngDiffer } from './harness/pngDiff';
import { openCallSession, openFixtureState, type CallSession } from './harness/callSession';

/**
 * Every round of the build has come (round 6 removed the pending
 * allowance): a state that does not pass fails, whatever its round. A state
 * the renderer stops drawing (a screen that no longer opens or loses its
 * `data-screen`) is a regression.
 */
const PENDING_ALLOWED = false;
const FINAL_ROUND = 7;
const CURRENT_ROUND = Number(process.env.CALL_SCREENS_ROUND || FINAL_ROUND);
const MATRIX = !!process.env.CALL_SCREENS_MATRIX;

test.use({
  launchOptions: {
    executablePath: resolveCallChromium(),
    // The resumed queue's hold ringback starts without a gesture (the pill's level bars need audio.isActive()).
    args: ['--autoplay-policy=no-user-gesture-required'],
  },
});

/** How a result counts for the gate: ok, pending (allowed) or failed. */
function classify(r: Pick<StateResult, 'verdict' | 'due'>, round: number = CURRENT_ROUND, pendingAllowed: boolean = PENDING_ALLOWED): 'ok' | 'pending' | 'failed' {
  if (['pass', 'review', 'review-only', 'geometry-pass'].includes(r.verdict)) return 'ok';
  if (!pendingAllowed) return 'failed';
  return r.due.round > round ? 'pending' : 'failed';
}

test('the gate fails every state that does not pass, whatever its round (no pending allowance any more)', () => {
  const due = (round: number) => ({ round, lane: 'Lx' });
  // The gate as it runs: nothing is waited for.
  expect(PENDING_ALLOWED).toBe(false);
  expect(classify({ verdict: 'pending', due: due(6) })).toBe('failed');
  expect(classify({ verdict: 'pending', due: due(FINAL_ROUND + 1) })).toBe('failed');
  expect(classify({ verdict: 'fail', due: due(1) })).toBe('failed');
  expect(classify({ verdict: 'error', due: due(1) })).toBe('failed');
  expect(classify({ verdict: 'geometry-fail', due: due(1) })).toBe('failed');
  for (const ok of ['pass', 'review', 'review-only', 'geometry-pass'] as const) expect(classify({ verdict: ok, due: due(9) })).toBe('ok');
  // The rounds' rule, kept for a later redesign built in rounds: a due state fails, a later one waits.
  expect(classify({ verdict: 'pending', due: due(1) }, 1, true)).toBe('failed');
  expect(classify({ verdict: 'pending', due: due(2) }, 1, true)).toBe('pending');
  expect(classify({ verdict: 'fail', due: due(2) }, 2, true)).toBe('failed');
});

test('pngDiff: identical images, one changed pixel, a masked pixel, a size change', async ({ browser }) => {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 40, height: 30 } });
  const draw = async (html: string) => {
    await page.setContent(`<body style="margin:0;background:#fff">${html}</body>`);
    return page.screenshot();
  };
  const base = await draw('<div style="width:40px;height:30px;background:#0B7D6C"></div>');
  const dot = await draw('<div style="width:40px;height:30px;background:#0B7D6C;position:relative"><i style="position:absolute;left:5px;top:6px;width:1px;height:1px;background:#fff"></i></div>');
  const faint = await draw('<div style="width:40px;height:30px;background:#0E806F"></div>');
  await page.setViewportSize({ width: 41, height: 30 });
  const wider = await draw('<div style="width:41px;height:30px;background:#0B7D6C"></div>');
  await page.close();
  const differ = await PngDiffer.open(browser);
  try {
    expect((await differ.diff(base, base)).different).toBe(0);
    // A difference of 3 per channel is under the threshold (28).
    expect((await differ.diff(base, faint)).different).toBe(0);
    const one = await differ.diff(base, dot);
    expect([one.different, one.bbox]).toEqual([1, { x: 5, y: 6, width: 1, height: 1 }]);
    expect(one.share).toBeCloseTo(1 / 1200, 8);
    const masked = await differ.diff(base, dot, { masks: [{ x: 4, y: 5, width: 3, height: 3 }] });
    expect([masked.different, masked.counted]).toEqual([0, 1200 - 9]);
    const size = await differ.diff(base, wider);
    expect([size.sizeMatch, size.different]).toEqual([false, 30]);
    const heat = await differ.diff(base, dot, { heatmap: true });
    expect(heat.heatmap!.subarray(1, 4).toString('latin1')).toBe('PNG');
  } finally {
    await differ.close();
  }
});

test('fake video: the reference\'s feed frames play back pixel for pixel through a real <video>', async ({ browser }) => {
  test.setTimeout(120_000);
  const feeds = await new ReferenceRenderer(browser, 'webyar').exportFeeds();
  const differ = await PngDiffer.open(browser);
  try {
    for (const [name, png, w, h] of [['desktop', feeds.desktop, 400, 660], ['self', feeds.self, 98, 136], ['mvid', feeds.mvid, 188, 122],
      ['mobile', feeds.mobile, 390, 844], ['selfMobile', feeds.selfMobile, 108, 150]] as const) {
      const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 800, height: 900 } });
      await page.setContent(`<body style="margin:0;background:#000"><div id="box" style="width:${w}px;height:${h}px;overflow:hidden"></div></body>`);
      await page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        const cx = cv.getContext('2d')!;
        cx.drawImage(bmp, 0, 0);
        setInterval(() => cx.drawImage(bmp, 0, 0), 100);
        const v = document.createElement('video');
        v.autoplay = true; v.muted = true; v.playsInline = true;
        v.srcObject = cv.captureStream(30);
        v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
        document.getElementById('box')!.appendChild(v);
        await v.play();
      }, png.toString('base64'));
      await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).readyState >= 2);
      await page.waitForTimeout(300);
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
      await page.close();
      const r = await differ.diff(png, shot);
      expect(r.share, `${name}: ${r.different} px`).toBeLessThan(0.0005);
    }
  } finally {
    await differ.close();
  }
});

for (const brand of BRANDS) {
  test(`${brand}: boots through the real loader in source, shipped and built modes, no foreign request, no page error`, async ({ browser }) => {
    test.setTimeout(240_000);
    const state = callStates(brand).find((s) => s.id === '02-P1-bottom-right-default')!;
    const build = buildCallWidgetScratch(brand);
    try {
      for (const mode of ['source', 'shipped', 'built'] as Mode[]) {
        const live = new LiveRenderer(browser, { brand, mode, dist: mode === 'built' ? build.dist : undefined });
        const shot = await live.shoot(state);
        const tag = `${brand} ${mode}`;
        expect(shot.foreign, `${tag}: foreign requests`).toEqual([]);
        expect(shot.errors, `${tag}: page errors`).toEqual([]);
        expect(['geometry', 'pending'], `${tag}: ${shot.reason || ''}`).toContain(shot.status);
        const files = shot.requests.map((r) => r.split('?')[0]);
        expect(files, tag).toContain('/call-widget/l.js');
        expect(files).toContain('/api/call-widget/bootstrap');
        for (const name of ['presentation-registry', 'presentation-default', 'runtime']) {
          const hashed = new RegExp(`^/call-widget/${name}\\.[0-9a-f]{12}\\.js$`);
          const fixed = `/call-widget/${name}.js`;
          if (mode === 'built') expect(files.some((f) => hashed.test(f)), `${tag}: ${name} by its hashed name`).toBe(true);
          else expect(files, tag).toContain(fixed);
        }
        expect(files.some((f) => f.startsWith('/widget/presentation-default-fonts')), `${tag}: the shared fonts stylesheet`).toBe(true);
      }
    } finally {
      build.cleanup();
    }
  });

  test(`${brand}: Tier A, every P/M/C state against the reference re-render, every placement by geometry`, async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const out = process.env.CALL_SCREENS_OUT || testInfo.outputPath('call-screens');
    const report = await compareCallScreens({ brand, mode: 'source', browser, out });
    expect(report.foreign, 'foreign requests').toEqual([]);
    const pixel = report.results.filter((r) => PIXEL_KINDS.has(r.kind));
    expect(pixel.length).toBe(46);
    expect(report.results.filter((r) => r.kind === 'G').length).toBe(8);
    const failed = report.results.filter((r) => classify(r) === 'failed');
    const review = report.results.filter((r) => r.verdict === 'review');
    testInfo.annotations.push(
      { type: 'review (0.05%–0.20%)', description: review.map((r) => `${r.id} ${((r.share || 0) * 100).toFixed(3)}%`).join('; ') || 'none' },
    );
    console.log(`\n${brand} Tier A (round ${CURRENT_ROUND}):\n${report.results.map((r) => `${classify(r).padEnd(8)} ${formatResult(r)}`).join('\n')}`);
    expect(failed.map(formatResult), `${brand}: states over the Tier A limits`).toEqual([]);
    if (!process.env.CALL_SCREENS_OUT) rmSync(out, { recursive: true, force: true });
  });

  // The matrix (contract §8.2): every other preset accent, the light accent (Ink on it) and radius sm/lg, each a run of
  // every P/M/C state against the reference re-rendered with the same accent (inline --a/--on-a) or data-r.
  const runs: Array<{ accent?: string; radius?: Radius }> = [
    ...[...ACCENT_PRESETS[brand].slice(1), LIGHT_ACCENT].map((accent) => ({ accent })),
    { radius: 'sm' }, { radius: 'lg' },
  ];
  for (const run of runs) {
    const tag = run.accent ? `accent ${run.accent}` : `radius ${run.radius}`;
    test(`${brand}: Tier A matrix, ${tag}`, async ({ browser }, testInfo) => {
      test.skip(!MATRIX, 'set CALL_SCREENS_MATRIX=1 for the accent and radius matrix');
      test.setTimeout(15 * 60_000);
      const out = process.env.CALL_SCREENS_OUT || testInfo.outputPath('call-screens');
      const states = callStates(brand).filter((s) => PIXEL_KINDS.has(s.kind)).map((s) => s.id);
      const report = await compareCallScreens({ brand, mode: 'source', browser, out, states, ...run });
      expect(report.foreign, 'foreign requests').toEqual([]);
      expect(report.results.length).toBe(46);
      const review = report.results.filter((r) => r.verdict === 'review');
      testInfo.annotations.push(
        { type: 'review (0.05%–0.20%)', description: review.map((r) => `${r.id} ${((r.share || 0) * 100).toFixed(3)}%`).join('; ') || 'none' },
      );
      console.log(`\n${brand} Tier A matrix ${tag}:\n${report.results.map((r) => `${classify(r).padEnd(8)} ${formatResult(r)}`).join('\n')}`);
      expect(report.results.filter((r) => classify(r) === 'failed').map(formatResult), `${brand} ${tag}: states over the Tier A limits`).toEqual([]);
      if (!process.env.CALL_SCREENS_OUT) rmSync(out, { recursive: true, force: true });
    });
  }

  test(`${brand}: board 12's tokens, computed in the live widget, are the design's for every accent and radius`, async ({ browser }) => {
    test.setTimeout(180_000);
    const design = readDesignTokens(brand);
    const problems: string[] = [];
    for (const accent of [...new Set([...ACCENT_PRESETS[brand], ...BOARD12_ACCENTS[brand], LIGHT_ACCENT])]) {
      const isDefault = accent === ACCENT_PRESETS[brand][0];
      // Respok's stage in a colour other than Ink (owner, 2026-10-19): board 12-02's stage tokens, held dark.
      const tintK = stageTintK(brand, isDefault ? null : accent);
      // WebYar's stage in a colour lighter than its lightest preset (round 7b): runtime.css's formulas, held at .195.
      const holdK = stageHoldK(brand, isDefault ? null : accent);
      const s = await openCallSession(browser, { brand, clock: 'fixed', boot: isDefault ? undefined : { config: { widget_theme: { primary: accent } } } });
      try {
        const live = await probeTokens(s.page, design.tokens, tintK ? stageTintFormulas(accent, tintK) : holdK ? stageHoldFormulas(accent, holdK) : {});
        const mark = await s.page.evaluate(() => {
          const root = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root') as HTMLElement;
          return { tint: root.classList.contains('tint'), hold: root.classList.contains('hold'), k: root.style.getPropertyValue('--a-k').trim() };
        });
        const k = tintK || holdK || '';
        if (mark.tint !== !!tintK || mark.hold !== !!holdK || mark.k !== k) {
          problems.push(`${accent} stage mark: tint ${mark.tint} hold ${mark.hold} --a-k "${mark.k}" (expected ${!!tintK} ${!!holdK} "${k}")`);
        }
        // Without color-mix() the stage stays Respok's fixed Ink, whatever the colour (D25 pattern).
        if (tintK) problems.push(...(await probeTintFallback(s.page)).map((p) => `${accent} without color-mix(): ${p}`));
        // Without color-mix() WebYar's held stage is runtime.css's own (D25's default teal there).
        if (holdK) problems.push(...(await probeHoldFallback(s)).map((p) => `${accent} without color-mix(): ${p}`));
        const light = onAccent(accent) !== '#FFFFFF';
        for (const [name, t] of Object.entries(design.tokens)) {
          if (name === '--font') continue;
          const got = live.tokens[name];
          if (!got) { problems.push(`${accent} ${name}: not defined on .ccw-root`); continue; }
          let want: ProbedValue;
          if (name === '--a') want = { ...got, colours: [hexRgba(accent)] };
          else if (name === '--on-a' || (name === '--core-ink' && t.css === 'var(--on-a)')) want = { ...got, colours: [hexRgba(onAccent(accent))] };
          // A light accent: links and icon tiles take Ink (contract §2.7 step 3, §8.3 #8).
          else if (name === '--a-ink' && light) want = live.tokens['--ink'];
          // Derived from the accent: the design's own formula, computed with the live accent.
          else if (got.formula) want = got.formula;
          // Fixed: the design's resolved value, whatever the accent.
          else want = got.resolved;
          const bad = compareProbed(got, want);
          if (bad) problems.push(`${accent} ${name}: ${bad}`);
        }
        // The design's fonts are Vazirmatn / DM Mono; production names IRANSans for Persian and Figtree for Respok (D3, §8.3 #1).
        const first = live.font.split(',')[0].replace(/["']/g, '').trim();
        const wantFont = BRAND_INFO[brand].locale === 'fa' ? 'IRANSans' : 'Figtree';
        if (first !== wantFont) problems.push(`${accent} font: ${live.font} (expected ${wantFont} first)`);
        if (isDefault) {
          for (const r of ['sm', 'md', 'lg'] as const) {
            const got = await s.page.evaluate(({ r: radius, names }) => {
              const root = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root') as HTMLElement;
              if (radius === 'md') root.removeAttribute('data-radius'); else root.setAttribute('data-radius', radius);
              const cs = getComputedStyle(root);
              return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
            }, { r, names: Object.keys(design.radius[r]) });
            for (const [n, v] of Object.entries(design.radius[r])) if (got[n] !== v) problems.push(`radius ${r} ${n}: ${got[n]} (design ${v})`);
          }
          // Browsers without color-mix() (contract D25): the @supports redefinitions give the same colours.
          problems.push(...(await probeFallbacks(s.page, brand)).map((p) => `without color-mix(): ${p}`));
        }
      } finally {
        await s.close();
      }
    }
    expect(problems).toEqual([]);
  });

  // Contract §8.2 "other direction": each brand's drawn direction is pixel-gated above; the other one (WebYar in
  // English, Respok in Persian) must be its mirror image.
  test(`${brand}: the other direction mirrors the drawn one (icons, buttons, dock, orb), in every panel screen`, async ({ browser }) => {
    test.setTimeout(300_000);
    const problems: string[] = [];
    let checked = 0;
    for (const id of MIRROR_STATES) {
      const st = callStates(brand).find((x) => x.id === id)!;
      const s = await openFixtureState(browser, brand, st);
      try {
        // No hover (a hovered star grows) in either direction.
        await s.page.mouse.move(1, 1);
        const drawn = await mirrorRects(s.page);
        const other = drawn.dir === 'rtl' ? 'en' : 'fa';
        await s.page.evaluate((loc) => {
          const c = (window as unknown as { CallCenterWidget: { locale: string; render: () => void } }).CallCenterWidget;
          c.locale = loc;
          c.render();
        }, other);
        await s.page.waitForFunction((dir) => document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root')!.getAttribute('dir') !== dir, drawn.dir);
        // A layout first, so the other language's faces are requested before waiting for them.
        await s.page.evaluate(() => {
          document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('#ccw-panel')!.getBoundingClientRect();
          return document.fonts.ready.then(() => undefined);
        });
        await s.page.waitForTimeout(400);
        const flipped = await mirrorRects(s.page);
        if (flipped.screen !== drawn.screen) problems.push(`${id}: screen ${drawn.screen} became ${flipped.screen}`);
        const r = compareMirror(drawn, flipped);
        checked += r.ok;
        problems.push(...r.bad.map((b) => `${id}: ${b}`));
        expect(s.log.errors, `${id}: page errors`).toEqual([]);
      } finally {
        await s.close();
      }
    }
    expect(checked, 'elements compared').toBeGreaterThan(150);
    expect(problems).toEqual([]);
  });
}

// ─── The other direction: mirror probe ───────────────────────────────────
/** Every panel screen the fixture drives without the reference's video frames (the video layout is the voice one's). */
const MIRROR_STATES = [
  '05-01-home', '05-02-precall-error', '05-03-returning', '06-04-connecting', '06-05-queue-third', '06-06-queue-next-offer',
  '07-07-joining', '07-08-voice', '08-10-transfer', '08-11-reconnect', '08-12-mic-blocked', '09-13-rating', '09-14-thanks',
  '09-15-error', '10-16-offline', '10-17-callback-step1', '10-18-callback-step2', '10-19-scheduled', '11-21-sheet', '11-22-queue',
];
/** Icons, buttons, dock and orb (digest-infra §7: text-width elements excluded, below). */
const MIRROR_SEL = [
  '.hd .lg', '.hd .ib', '.ctx .ib', '.lang', '.badge', '.opt', '.opt .oi', '.opt .go', '.cbr .it', '.cbr .ch', '.trust svg', '.orb',
  '.dock button', '.vdock .bt', '.pip', '.qc', '.ql2 .op', '.ql2 .pp', '.sumc .avw', '.sumc .ck', '.stars .star', '.okc',
  '.okc .bdg', '.ei', '.oi2', '.oi2 .moon', '.sw', '.known .av', '.known .ed', '.cpy', '.sumchip .it', '.sumchip .chg',
  '.seg button', '.days .chip', '.slots .chip', '.stp .bars', '.bnr svg', '.bnr .spn', '.xf .av', '.xf .to', '.xf .ar',
  '.addr .bar', '.addr .lk2', '.row2 .btn', '.acts .btn', '.vtop', '.tmr', '.ctm', '.mini-stars', '.cons .sw', '.permit .ics',
  '.grp .fr', '.msg svg', '.pill', '.hint', '.offer .btn', '.offer svg', '.who-c', '.rnote svg', '.net', '.pw', '.grab',
];
/**
 * Whose place depends on the width of a text (theirs or a neighbour's: a
 * label beside an icon, a button's caption, a line between two captions):
 * a single one changes sides, several on one row swap places.
 */
const MIRROR_ORDER_ONLY = new Set([
  '.acts .btn', '.row2 .btn', '.offer .btn', '.dock button', '.known .ed', '.sumchip .chg', '.ql2 .pp', '.rnote svg', '.net',
  '.trust svg', '.slots .chip', '.badge', '.lang',
]);
/** A browser's address bar, drawn as it is in every language (left to right): the same in both directions. */
const MIRROR_NONE = new Set(['.addr .bar', '.addr .lk2']);

interface MirrorShot { W: number; dir: string; screen: string; out: Record<string, number[][]> }

/** Panel-relative [x, y, w, h] of every visible MIRROR_SEL element of the screen on show. */
async function mirrorRects(page: Page): Promise<MirrorShot> {
  return page.evaluate((sels) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const p = sr.querySelector('#ccw-panel')!.getBoundingClientRect();
    const out: Record<string, number[][]> = {};
    for (const sel of sels) {
      out[sel] = [...sr.querySelectorAll(`.scr.on ${sel}`)]
        .filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('[hidden]'))
        .map((e) => {
          const r = e.getBoundingClientRect();
          return [r.left - p.left, r.top - p.top, r.width, r.height].map((v) => Math.round(v * 10) / 10);
        });
    }
    const scr = sr.querySelector('.scr.on') as HTMLElement | null;
    return { W: Math.round(p.width * 10) / 10, dir: sr.querySelector('.ccw-root')!.getAttribute('dir') || '', screen: scr?.dataset.screen || '', out };
  }, MIRROR_SEL);
}

/** `x_other ≈ W − x − w` (±1px, same width) or centred in both; order-only selectors flip their order and side. */
function compareMirror(a: MirrorShot, b: MirrorShot): { ok: number; bad: string[] } {
  const bad: string[] = [];
  let ok = 0;
  const centre = (r: number[], W: number) => r[0] + r[2] / 2 - W / 2;
  for (const sel of MIRROR_SEL) {
    const A = a.out[sel];
    const B = b.out[sel];
    if (A.length !== B.length) { bad.push(`${sel}: ${A.length} in ${a.dir}, ${B.length} in ${b.dir}`); continue; }
    if (MIRROR_NONE.has(sel)) {
      A.forEach((r, i) => { if (Math.abs(B[i][0] - r[0]) <= 1) ok++; else bad.push(`${sel}[${i}] moved: x ${r[0]} → ${B[i][0]} (drawn left to right in both)`); });
      continue;
    }
    if (MIRROR_ORDER_ONLY.has(sel)) {
      A.forEach((r, i) => {
        const ca = centre(r, a.W);
        const cb = centre(B[i], b.W);
        // A single one changes sides (or stays centred within 2px).
        if (A.length > 1 || (Math.abs(ca) <= 2 && Math.abs(cb) <= 2) || Math.sign(ca) === -Math.sign(cb)) ok++;
        else bad.push(`${sel}[${i}] on the same side: centre ${ca.toFixed(1)} → ${cb.toFixed(1)} from the middle`);
        // Two of them on one row swap places.
        for (let j = i + 1; j < A.length; j++) {
          if (Math.abs(r[1] - A[j][1]) > 2 || Math.abs(B[i][1] - B[j][1]) > 2 || Math.abs(r[0] - A[j][0]) < 1) continue;
          if (Math.sign(r[0] - A[j][0]) !== -Math.sign(B[i][0] - B[j][0])) bad.push(`${sel}[${i}] and [${j}] keep their order`);
        }
      });
      continue;
    }
    A.forEach((r, i) => {
      const want = a.W - r[0] - r[2];
      const same = Math.abs(B[i][2] - r[2]) <= 1;
      if ((same && Math.abs(B[i][0] - want) <= 1) || (Math.abs(centre(r, a.W)) <= 1 && Math.abs(centre(B[i], b.W)) <= 1)) ok++;
      else bad.push(`${sel}[${i}] ${a.dir} x ${r[0]} w ${r[2]} → ${b.dir} x ${B[i][0]} w ${B[i][2]} (the mirror is x ${want.toFixed(1)}${same ? '' : ', and the width differs'})`);
    });
  }
  return { ok, bad };
}

// ─── Board 12: tokens ────────────────────────────────────────────────────
/**
 * The brand colours board 12-02 ("any brand colour") draws besides the
 * presets. Respok's board tints its mini stages with each colour; production
 * does too since the owner's request of 2026-10-19 (tokens.json still notes
 * the fixed Ink stage of the first handoff), held dark (stageTintFormulas);
 * at Ink and with no colour the stage stays tokens.json's fixed Ink.
 */
const BOARD12_ACCENTS: Record<Brand, string[]> = {
  webyar: ['#0E7490'],
  respok: ['#2563EB', '#7C3AED', '#DB2777', '#D9480F', '#111827'],
};
type Rgba = [number, number, number, number];
interface DesignToken { css: string; resolved: string }
/** A token used the way the widget uses it: the computed text without its colours (the shape) and the colours, as sRGB bytes. */
interface ProbedValue { shape: string; colours: Rgba[] }
interface ProbedToken extends ProbedValue {
  /** The design's css for the token computed in the same root (its var(--a) is the live accent); only for accent-derived tokens. */
  formula?: ProbedValue;
  /** The design's resolved value (tokens.json), computed the same way. */
  resolved: ProbedValue;
}

function hexRgba(hex: string): Rgba {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 255];
}

/** null when the shapes match and every colour is within 2 per channel (OKLab rounding), else what differs. */
function compareProbed(got: ProbedValue, want: ProbedValue | undefined): string | null {
  if (!want) return 'nothing to compare with';
  const fmt = (v: ProbedValue) => `${v.shape} [${v.colours.map((c) => `rgba(${c.join(',')})`).join(' ')}]`;
  const same = got.shape === want.shape && got.colours.length === want.colours.length
    && got.colours.every((c, i) => c.every((x, k) => Math.abs(x - want.colours[i][k]) <= 2));
  return same ? null : `${fmt(got)}, design ${fmt(want)}`;
}

/**
 * Respok's stage tokens for a colour other than Ink (owner, 2026-10-19): board
 * 12-02's, held dark. The colour is first scaled to a luminance of .15 (an
 * oklab mix with black at `k`, the renderer's `--a-k`), then mixed into a
 * near-black (Ink's darkest without its violet) for the two upper stops and
 * into Ink's darkest for the last; the glow is board 12-02's light mix with
 * white. Written out here rather than read from the skin, so the probe pins
 * the numbers (callWidgetTheme.test.ts proves their contrast for any colour).
 */
function stageTintFormulas(accent: string, k: string): Record<string, string> {
  const st = `color-mix(in oklab, ${accent} ${k}, #000)`;
  return {
    '--s1': `color-mix(in oklab, ${st} 40%, #0C0C10)`,
    '--s2': `color-mix(in oklab, ${st} 20%, #0C0C10)`,
    '--s3': `color-mix(in oklab, ${st} 8%, #0D0C1C)`,
    '--glow': `color-mix(in oklab, ${st} 55%, #fff)`,
  };
}

/**
 * WebYar's stage tokens for a colour lighter than its lightest preset (owner,
 * 2026-10-19, round 7b): the colour is first scaled to a luminance of .195
 * (an oklab mix with black at `k`, the renderer's `--a-k`), then runtime.css's
 * own stage formulas (the design's: 42% in #5CF2D6, 60% / 30% / 12% in its
 * green-blacks) take it in place of the colour. Written out here rather than
 * read from the skin, so the probe pins the numbers (callWidgetTheme.test.ts
 * proves their contrast for any colour).
 */
function stageHoldFormulas(accent: string, k: string): Record<string, string> {
  const st = `color-mix(in oklab, ${accent} ${k}, #000)`;
  return {
    '--glow': `color-mix(in oklab, ${st} 42%, #5CF2D6)`,
    '--s1': `color-mix(in oklab, ${st} 60%, #03110F)`,
    '--s2': `color-mix(in oklab, ${st} 30%, #03100E)`,
    '--s3': `color-mix(in oklab, ${st} 12%, #020807)`,
  };
}

/** The `@supports (color: color-mix(…))` blocks of a call-widget stylesheet, as written. */
function colorMixBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (let at = css.indexOf('@supports (color: color-mix('); at >= 0; at = css.indexOf('@supports (color: color-mix(', at + 1)) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { blocks.push(css.slice(at, i + 1)); break; }
    }
  }
  return blocks;
}

/**
 * A browser without color-mix() ignores the skin's `@supports (color:
 * color-mix(…))` block, where the tinted stage lives. The skin is put back
 * into the shadow root without that block (in its place in the cascade, the
 * served sheet switched off): a tinted root must then draw exactly the stage
 * of an untinted one (Respok's fixed Ink: its tokens and its three-layer
 * ground with the indigo light), and before the swap it must not.
 */
async function probeTintFallback(page: Page): Promise<string[]> {
  const skin = readFileSync(path.join(process.cwd(), 'public/call-widget', BRAND_INFO.respok.skin), 'utf8');
  const blocks = colorMixBlocks(skin);
  if (blocks.length !== 1) return [`${blocks.length} @supports (color: color-mix()) blocks in the skin (expected 1)`];
  const without = skin.replace(blocks[0], '');
  return page.evaluate((css) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const root = sr.querySelector('.ccw-root') as HTMLElement;
    const ground = sr.querySelector('.dk.stage-bg') as HTMLElement | null;
    if (!ground) return ['no .dk.stage-bg'];
    const read = () => {
      const cs = getComputedStyle(root);
      return { s1: cs.getPropertyValue('--s1').trim(), s2: cs.getPropertyValue('--s2').trim(), s3: cs.getPropertyValue('--s3').trim(),
        glow: cs.getPropertyValue('--glow').trim(), bg: getComputedStyle(ground).backgroundImage };
    };
    const link = [...sr.querySelectorAll('link[rel=stylesheet]')].find((l) => /presentation-intl/.test((l as HTMLLinkElement).href)) as HTMLLinkElement | undefined;
    if (!link?.sheet) return ['no presentation-intl stylesheet in the shadow root'];
    const tinted = read();
    const st = document.createElement('style');
    st.textContent = css;
    link.after(st);
    link.sheet.disabled = true;
    const fallback = read();
    root.classList.remove('tint');
    const ink = read();
    root.classList.add('tint');
    st.remove();
    link.sheet.disabled = false;
    const problems: string[] = [];
    if (tinted.bg === ink.bg) problems.push('the tinted stage draws the Ink stage even with color-mix()');
    if (JSON.stringify(fallback) !== JSON.stringify(ink)) problems.push(`${JSON.stringify(fallback)} instead of the Ink stage ${JSON.stringify(ink)}`);
    if ([ink.s1, ink.s2, ink.s3].join(' ').toUpperCase() !== '#2E2A5E #1A1838 #0D0C1C') problems.push(`Ink stage tokens ${ink.s1} ${ink.s2} ${ink.s3}`);
    if (!/rgb\(59, 53, 118\)/.test(ink.bg)) problems.push(`the Ink ground without its indigo light: ${ink.bg}`);
    if (JSON.stringify(read()) !== JSON.stringify(tinted)) problems.push('the served skin did not come back');
    return problems;
  }, without);
}

/**
 * The same for WebYar's held stage (round 7b), in two steps. First the skin
 * goes back into the shadow root without its one `@supports (color:
 * color-mix(…))` block (the served sheet switched off): a held root must then
 * draw exactly the stage of an unheld one in the same colour, and before the
 * swap it must not. Then a browser without color-mix() at all: runtime.css,
 * the panel stylesheet and the skin go back with their color-mix() conditions
 * flipped (every `@supports not (…)` block applies, every `@supports (…)`
 * block does not): with `hold` and `--a-k` still on the root, the stage must
 * be D25's default teal (runtime.css's fallback tokens, the panel's fallback
 * ground), the same as an unheld root's. The panel is opened first, so the
 * stage ground (`.stage-bg`, a rule of the panel stylesheet) is drawn and
 * compared too.
 */
async function probeHoldFallback(s: CallSession): Promise<string[]> {
  const source = (file: string) => readFileSync(path.join(process.cwd(), 'public/call-widget', file), 'utf8');
  const skin = source(BRAND_INFO.webyar.skin);
  const blocks = colorMixBlocks(skin);
  if (blocks.length !== 1) return [`${blocks.length} @supports (color: color-mix()) blocks in the skin (expected 1)`];
  const MIX = 'color: color-mix(in oklab, red, red)';
  const noMix = ['runtime.css', 'presentation-default-panel.css', BRAND_INFO.webyar.skin].map((file) => ({
    file: file.replace(/\.css$/, ''),
    css: source(file).split(`@supports not (${MIX})`).join('@supports (display: block)').split(`@supports (${MIX})`).join('@supports (display: never-r7b)'),
  }));
  const d25Block = /@supports not \(color: color-mix\(in oklab, red, red\)\) \{([\s\S]*?)\n\}/.exec(source('runtime.css'));
  if (!d25Block) return ['no @supports not (color: color-mix()) block in runtime.css'];
  const d25: Record<string, string> = {};
  for (const n of ['s1', 's2', 's3', 'glow']) {
    const m = new RegExp(`--${n}:\\s*(#[0-9A-Fa-f]{6});`).exec(d25Block[1]);
    if (!m) return [`runtime.css's fallback has no --${n}`];
    d25[n] = m[1];
  }
  await s.open();
  return s.page.evaluate(({ css, sheets, d25: teal }) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const root = sr.querySelector('.ccw-root') as HTMLElement;
    const ground = sr.querySelector('.dk.stage-bg') as HTMLElement | null;
    if (!ground) return ['no .dk.stage-bg'];
    const read = () => {
      const cs = getComputedStyle(root);
      return { s1: cs.getPropertyValue('--s1').trim(), s2: cs.getPropertyValue('--s2').trim(), s3: cs.getPropertyValue('--s3').trim(),
        glow: cs.getPropertyValue('--glow').trim(), bg: getComputedStyle(ground).backgroundImage };
    };
    const links = [...sr.querySelectorAll('link[rel=stylesheet]')] as HTMLLinkElement[];
    const link = links.find((l) => /\/presentation-default(\.[0-9a-f]{12})?\.css(\?|$)/.test(l.href));
    if (!link?.sheet) return ['no presentation-default stylesheet in the shadow root'];
    if (!links.some((l) => /presentation-default-panel/.test(l.href) && l.sheet)) return ['the panel stylesheet did not load'];
    const held = read();
    const st = document.createElement('style');
    st.textContent = css;
    link.after(st);
    link.sheet.disabled = true;
    const fallback = read();
    root.classList.remove('hold');
    const plain = read();
    root.classList.add('hold');
    st.remove();
    link.sheet.disabled = false;
    const problems: string[] = [];
    if (!/gradient/.test(held.bg)) problems.push(`no stage ground: ${held.bg}`);
    if (held.s1 === plain.s1 || held.glow === plain.glow || held.bg === plain.bg) problems.push('the held stage draws the unheld stage even with color-mix()');
    if (JSON.stringify(fallback) !== JSON.stringify(plain)) problems.push(`${JSON.stringify(fallback)} instead of runtime.css's stage ${JSON.stringify(plain)}`);
    if (JSON.stringify(read()) !== JSON.stringify(held)) problems.push('the served skin did not come back');
    // No color-mix() at all, each sheet in its place in the cascade.
    const swapped = sheets.map(({ file, css: text }) => {
      const l = links.find((x) => new URL(x.href).pathname.split('/').pop()!.startsWith(`${file}.`));
      if (!l?.sheet) return null;
      const copy = document.createElement('style');
      copy.textContent = text;
      l.after(copy);
      l.sheet.disabled = true;
      return { l, copy };
    });
    const k = root.style.getPropertyValue('--a-k').trim();
    const stillHeld = root.classList.contains('hold');
    const tealHeld = read();
    root.classList.remove('hold');
    const tealPlain = read();
    root.classList.add('hold');
    for (const w of swapped) if (w) { w.copy.remove(); w.l.sheet!.disabled = false; }
    if (swapped.some((w) => !w)) return [...problems, `no <link> for ${sheets.filter((_, i) => !swapped[i]).map((x) => `${x.file}.css`).join(', ')} in the shadow root`];
    if (!stillHeld || !k) problems.push(`without color-mix() the root lost its mark (hold ${stillHeld}, --a-k "${k}")`);
    const want = [teal.s1, teal.s2, teal.s3, teal.glow].join(' ').toUpperCase();
    if ([tealHeld.s1, tealHeld.s2, tealHeld.s3, tealHeld.glow].join(' ').toUpperCase() !== want) {
      problems.push(`held stage tokens without color-mix(): ${tealHeld.s1} ${tealHeld.s2} ${tealHeld.s3} ${tealHeld.glow} (D25: ${want})`);
    }
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
    for (const n of ['s1', 's2', 's3'] as const) if (!tealHeld.bg.includes(`rgb(${rgb(teal[n])})`)) problems.push(`held ground without color-mix() lacks --${n} ${teal[n]}: ${tealHeld.bg}`);
    if (!tealHeld.bg.includes(`rgba(${rgb(teal.glow)}, `)) problems.push(`held ground without color-mix() lacks D25's glow ${teal.glow}: ${tealHeld.bg}`);
    if (JSON.stringify(tealHeld) !== JSON.stringify(tealPlain)) problems.push(`held ${JSON.stringify(tealHeld)} instead of the unheld D25 stage ${JSON.stringify(tealPlain)}`);
    if (JSON.stringify(read()) !== JSON.stringify(held)) problems.push('the served sheets did not come back');
    return problems;
  }, { css: skin.replace(blocks[0], ''), sheets: noMix, d25 });
}

/** The brand's tokens.json (committed with the handoff, D30). */
function readDesignTokens(brand: Brand): { tokens: Record<string, DesignToken>; radius: Record<Radius, Record<string, string>> } {
  const file = path.join(process.cwd(), 'docs/call-widget-handoff', brand, 'template-1-call-center/tokens.json');
  return JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, DesignToken>; radius: Record<Radius, Record<string, string>> };
}

/**
 * Each token used the way the widget uses it (a colour, a gradient, a shadow,
 * an easing, a length) on a probe element inside `.ccw-root`, next to the
 * design's formula and resolved value on probes in the same root; colours are
 * read back through a canvas as 8-bit sRGB, so `oklab()` and `rgb()`
 * serialisations compare by value.
 */
async function probeTokens(page: Page, tokens: Record<string, DesignToken>, extra: Record<string, string> = {}): Promise<{ tokens: Record<string, ProbedToken>; font: string }> {
  const names = Object.keys(tokens).filter((n) => n !== '--font');
  // Accent-derived tokens have a formula; Respok's --a "css" is prose (the workspace's primary), handled by the caller.
  // `extra`: formulas the design states outside tokens.json (Respok's tinted stage), over tokens.json's.
  const formulas = {
    ...Object.fromEntries(names.filter((n) => n !== '--a' && /var\(--a[-)]/.test(tokens[n].css)).map((n) => [n, tokens[n].css])),
    ...extra,
  };
  const resolved = Object.fromEntries(names.map((n) => [n, tokens[n].resolved]));
  return page.evaluate(({ names: list, formulas: f, resolved: res }) => {
    const root = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root') as HTMLElement;
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;visibility:hidden';
    root.appendChild(box);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    const bytes = (colour: string) => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = '#000';
      cx.fillStyle = colour;
      cx.fillRect(0, 0, 1, 1);
      return [...cx.getImageData(0, 0, 1, 1).data] as [number, number, number, number];
    };
    const COLOUR = /(?:rgba?|oklab|oklch|lab|lch|hwb|color)\([^()]*\)/g;
    const propFor = (v: string) => (/gradient\(/.test(v) ? 'background-image'
      : /cubic-bezier\(|linear\(|^ease/.test(v) ? 'transition-timing-function'
        : /\dpx\s+-?\d/.test(v) ? 'box-shadow'
          : /^-?[\d.]+px$/.test(v) ? 'width' : 'color');
    const use = (prop: string, value: string) => {
      const i = document.createElement('i');
      // Important: reduced motion's `.ccw-root * { transition: … !important }` would hide an easing.
      i.style.setProperty(prop, value, 'important');
      box.appendChild(i);
      const text = getComputedStyle(i).getPropertyValue(prop);
      i.remove();
      return { shape: text.replace(COLOUR, 'C'), colours: (text.match(COLOUR) || []).map(bytes) };
    };
    const rootCs = getComputedStyle(root);
    const out: Record<string, unknown> = {};
    for (const n of list) {
      const raw = rootCs.getPropertyValue(n).trim();
      if (!raw) continue;
      const prop = propFor(raw);
      out[n] = { ...use(prop, `var(${n})`), formula: f[n] ? use(prop, f[n]) : undefined, resolved: use(prop, res[n]) };
    }
    box.remove();
    return { tokens: out as never, font: rootCs.fontFamily };
  }, { names, formulas, resolved });
}

/**
 * What a browser without color-mix() shows (contract D25): the declarations
 * of every `@supports not (color: color-mix(…))` block of the page-load
 * stylesheets (runtime.css, then the brand's skin) put into the shadow root
 * as plain rules, in the same order and with the same selectors, so they
 * take part in the cascade as they would there. Every token they redefine
 * must keep its colours (±2 per channel) at the default accent.
 */
async function probeFallbacks(page: Page, brand: Brand): Promise<string[]> {
  const blocks: Array<{ file: string; rules: string }> = [];
  for (const file of ['runtime.css', BRAND_INFO[brand].skin]) {
    const css = readFileSync(path.join(process.cwd(), 'public/call-widget', file), 'utf8');
    const re = /@supports not \(color: color-mix\(in oklab, red, red\)\) \{([\s\S]*?)\n\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) blocks.push({ file: file.replace(/\.css$/, ''), rules: m[1] });
  }
  if (!blocks.some((b) => b.file === 'runtime')) return ['no @supports not (color: color-mix()) block in runtime.css'];
  const names = [...new Set(blocks.map((b) => b.rules).join('\n').match(/--[a-z0-9-]+(?=\s*:)/g) || [])];
  return page.evaluate(({ blocks: list0, names: list }) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const root = sr.querySelector('.ccw-root') as HTMLElement;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    const bytes = (colour: string) => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = '#000';
      cx.fillStyle = colour;
      cx.fillRect(0, 0, 1, 1);
      return [...cx.getImageData(0, 0, 1, 1).data];
    };
    const COLOUR = /(?:rgba?|oklab|oklch|lab|lch|hwb|color)\([^()]*\)/g;
    const read = () => {
      const box = document.createElement('div');
      root.appendChild(box);
      const out: Record<string, { shape: string; colours: number[][] }> = {};
      for (const n of list) {
        const raw = getComputedStyle(root).getPropertyValue(n).trim();
        const prop = /gradient\(/.test(raw) ? 'background-image' : /\dpx\s+-?\d/.test(raw) ? 'box-shadow' : 'color';
        const i = document.createElement('i');
        i.style.setProperty(prop, `var(${n})`, 'important');
        box.appendChild(i);
        const text = getComputedStyle(i).getPropertyValue(prop);
        out[n] = { shape: text.replace(COLOUR, 'C').replace(/\s+/g, ' '), colours: (text.match(COLOUR) || []).map(bytes) };
      }
      box.remove();
      return out;
    };
    const before = read();
    // Each block right after its own stylesheet's <link>, where the browser would apply it.
    const links = [...sr.querySelectorAll('link[rel=stylesheet]')] as HTMLLinkElement[];
    const added = list0.map((b) => {
      const link = links.find((l) => new URL(l.href).pathname.split('/').pop()!.startsWith(`${b.file}.`));
      const st = document.createElement('style');
      st.textContent = b.rules;
      if (link) link.after(st);
      return { st, found: !!link, file: b.file };
    });
    const after = read();
    for (const a of added) a.st.remove();
    const missing = added.filter((a) => !a.found).map((a) => `no <link> for ${a.file}.css in the shadow root`);
    if (missing.length) return missing;
    const problems: string[] = [];
    for (const n of list) {
      const a = before[n];
      const b = after[n];
      const same = a.shape === b.shape && a.colours.length === b.colours.length
        && a.colours.every((c, i) => c.every((x, k) => Math.abs(x - b.colours[i][k]) <= 2));
      if (!same) problems.push(`${n}: ${JSON.stringify(b)} instead of ${JSON.stringify(a)}`);
    }
    return problems;
  }, { blocks, names });
}

test('the reference reproduces the owner\'s acceptance PNGs (digest-infra §0.1)', async ({ browser }) => {
  const pkg = process.env.CALL_HANDOFF_PACKAGE;
  test.skip(!pkg || !existsSync(path.join(pkg, 'webyar/template-1-call-center/screens/panels')), 'set CALL_HANDOFF_PACKAGE to the unpacked handoff (with screens/panels)');
  test.setTimeout(20 * 60_000);
  const differ = await PngDiffer.open(browser);
  try {
    for (const brand of BRANDS as Brand[]) {
      const renderer = new ReferenceRenderer(browser, brand, pkg);
      const shares: Array<[string, number]> = [];
      for (const s of callStates(brand)) {
        const file = path.join(pkg!, brand, 'template-1-call-center/screens/panels', `${s.panel}.png`);
        const r = await differ.diff(readFileSync(file), await renderer.reproduce(s));
        shares.push([s.panel, r.share]);
      }
      // Re-rendered in this Chromium, every panel stays within animation-phase noise (≤ 0.94% measured).
      expect(shares.filter(([, v]) => v > 0.01), `${brand}: panels over 1%`).toEqual([]);
      expect(shares.filter(([, v]) => v < 0.0005).length, `${brand}: panels under 0.05%`).toBeGreaterThanOrEqual(50);
    }
  } finally {
    await differ.close();
  }
});
