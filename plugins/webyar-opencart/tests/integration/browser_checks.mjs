#!/usr/bin/env node
/**
 * TEST ONLY: the Web Yar settings page in a REAL browser, clicked the way an
 * owner clicks it — every button's form, the autosave switch, the confirm
 * dialog — against a real local OpenCart admin. (admin_checks.py posts to
 * the actions directly; this proves the page's own forms reach them.)
 *
 *   node browser_checks.mjs <4|3> <base> <shot.png>
 *
 * Needs the repository's playwright (and a Chromium it can find).
 */
import { chromium } from 'playwright';

const [major, base, shot] = [Number(process.argv[2]), process.argv[3].replace(/\/$/, ''), process.argv[4]];
const route = major === 4 ? 'extension/webyar/module/webyar' : 'extension/module/webyar';
const sep = major === 4 ? '.' : '/';
const results = [];
const check = (name, ok, detail) => results.push({ check: name, ok: !!ok, ...(ok ? {} : { detail }) });

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
await page.goto(`${base}/admin/index.php?route=common/login`);
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'Admin12345!');
await page.click('button[type=submit]');
await page.waitForURL(/user_token=/);
const token = new URL(page.url()).searchParams.get('user_token');
await page.goto(`${base}/admin/index.php?route=${route}&user_token=${token}`);
await page.locator('.wy').waitFor();

const actions = await page.$$eval('.wy form[data-wy-ajax]', (forms) => forms.map((f) => f.action));
check('every form posts with the session token', actions.length >= 4 && actions.every((a) => new URL(a).searchParams.get('user_token') && !a.includes('&amp;')), actions);

/** Clicks and returns the JSON the action answered, or its text if it was not JSON. */
async function click(locator, method) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`${route}${sep}${method}`) && r.request().method() === 'POST', { timeout: 30000 }),
    locator.click(),
  ]);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return { notJson: body.slice(0, 200) };
  }
}

let res = await click(page.locator('.wy-save button[form="wy-settings"]'), 'save');
check('Save answers JSON success', res.success, res);
await page.waitForTimeout(300);
check('Save shows a success toast', await page.locator('#wy-toast.show.ok').count() === 1);

res = await click(page.locator('.wy-store').first().locator('.wy-switch span'), 'save');
check('the widget switch saves by itself', res.success, res);
await page.locator('.wy-store').first().locator('.wy-switch span').click(); // back on
await page.waitForTimeout(800);

res = await click(page.locator('form[action*="' + sep + 'update"] button'), 'update');
check('Check for updates answers JSON', !res.notJson && (res.success || res.error), res);

res = await click(page.locator('form[action*="' + sep + 'test"] button').first(), 'test');
check('Check connection answers JSON', !res.notJson && (res.success || res.error), res);

// Disconnect asks first; dismissing sends nothing.
let asked = 0;
page.once('dialog', (d) => { asked++; d.dismiss(); });
const before = results.length;
await page.locator('form[action*="' + sep + 'disconnect"] button').last().click();
await page.waitForTimeout(800);
check('Disconnect asks for confirmation', asked === 1 && results.length === before);

await page.screenshot({ path: shot, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ opencart: major, passed: results.length - failed.length, failed: failed.length, results }, null, 1));
process.exit(failed.length ? 1 : 0);
