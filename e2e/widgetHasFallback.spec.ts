/**
 * The chat header's reply-time line (`default`): the online line while
 * someone answers, the away line (`.wy-sub-off`) in its place otherwise,
 * following Core's sr-only presence (`.presence .status-*`) through :has().
 *
 * A browser without :has() (Chrome/WebView < 105, Safari < 15.4, Firefox <
 * 121) drops a whole rule whose selector list holds one, so the away line's
 * own `display: none` stands in a rule of its own: there it keeps the online
 * line only, never both. Stood in for here by the real stylesheet with
 * :has( renamed to a pseudo-class no browser knows.
 * (templateRules.test.ts keeps every template stylesheet to that rule.)
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CSS = readFileSync(path.join(process.cwd(), 'public/widget/presentation-default.css'), 'utf8');

async function headerLines(page: Page, css: string, status: string): Promise<string[]> {
  return page.evaluate(([sheet, st]) => {
    const host = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = sheet;
    root.appendChild(style);
    const shell = document.createElement('div');
    shell.className = 'shell';
    shell.innerHTML = '<div class="panel"><div class="header wy-head wy-head-chat"><div class="wy-head-text">'
      + '<span class="wy-head-sub">online</span><span class="wy-head-sub wy-sub-off">away</span></div>'
      + `<div class="presence sr-only"><span class="status-${st}"></span></div></div></div>`;
    root.appendChild(shell);
    return Array.from(root.querySelectorAll('.wy-head-sub'))
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.textContent || '');
  }, [css, status] as const);
}

test('default: the header shows one reply-time line, with or without :has()', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  expect(await headerLines(page, CSS, 'online')).toEqual(['online']);
  expect(await headerLines(page, CSS, 'offline')).toEqual(['away']);
  expect(await headerLines(page, CSS, 'unavailable')).toEqual(['away']);
  const withoutHas = CSS.replace(/:has\(/g, ':no-such-pseudo(');
  expect(await headerLines(page, withoutHas, 'online')).toEqual(['online']);
  expect(await headerLines(page, withoutHas, 'offline')).toEqual(['online']);
});
