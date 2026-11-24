// TEMPORARY diagnostic (PR #430 only): which faces draw 05-01-home's badge, live and in the reference.
import { test, type Page } from '@playwright/test';
import { ReferenceRenderer } from './harness/callReference';
import { openFixtureState } from './harness/callSession';
import { callStates } from './harness/callScreensFixture';
import { resolveCallChromium } from './harness/callReference';

test.use({ launchOptions: { executablePath: resolveCallChromium(), args: ['--autoplay-policy=no-user-gesture-required'] } });

async function describe(page: Page, expr: string, tag: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const list = await cdp.send('Runtime.evaluate', { expression: `(() => { const b = ${expr}; return b ? [b, ...b.querySelectorAll('*')] : []; })()` });
  const props = await cdp.send('Runtime.getProperties', { objectId: list.result.objectId!, ownProperties: true });
  for (const p of props.result) {
    if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
    const info = await cdp.send('Runtime.callFunctionOn', {
      objectId: p.value.objectId, returnByValue: true,
      functionDeclaration: 'function () { const r = this.getBoundingClientRect(); const cs = getComputedStyle(this); return { el: this.tagName.toLowerCase() + (this.className && typeof this.className === "string" ? "." + this.className.split(" ").join(".") : ""), text: [...this.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("|"), x: +r.x.toFixed(2), w: +r.width.toFixed(2), ff: cs.fontFamily, fw: cs.fontWeight, fs: cs.fontSize, ls: cs.letterSpacing, ws: cs.wordSpacing, lang: this.closest("[lang]")?.getAttribute("lang") }; }',
    });
    const { nodeId } = await cdp.send('DOM.requestNode', { objectId: p.value.objectId });
    let fonts = '';
    try { fonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts.map((f) => `${f.familyName}${f.isCustomFont ? '(web)' : '(sys)'}×${f.glyphCount}`).join(', '); } catch (e) { fonts = String(e); }
    console.log(`${tag} ${JSON.stringify(info.result.value)} fonts=[${fonts}]`);
  }
}

test('font debug: 05-01-home badge', async ({ browser }) => {
  test.setTimeout(120_000);
  const state = callStates('webyar').find((s) => s.id === '05-01-home')!;
  const s = await openFixtureState(browser, 'webyar', state);
  await s.page.evaluate(() => document.fonts.ready.then(() => undefined));
  await s.page.waitForTimeout(500);
  await describe(s.page, `document.getElementById('call-center-widget-host').shadowRoot.querySelector('.scr.on .badge')`, 'LIVE');
  await s.close();
  const ref = new ReferenceRenderer(browser, 'webyar');
  const page: Page = await (ref as unknown as { open(f: string, o: object): Promise<Page> }).open(state.ref.page, { pristine: false, motion: false });
  await describe(page, `document.querySelectorAll(${JSON.stringify(state.ref.frame)})[${state.ref.index}].querySelector('.badge')`, 'REF ');
});
