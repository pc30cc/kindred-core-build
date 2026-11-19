/**
 * Smart Engagement's `ends_with` (src/lib/widget/smartEngine.ts and its
 * generated copy, public/widget/smart-engine.js, which the widget runs).
 *
 * A value one character shorter than the suffix, and without it, passed:
 * `lastIndexOf` is -1 and so is `length - suffix.length`. A rule for pages
 * ending in "/checkout" fired on "/checkou", one for ".ir" on "ir".
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { compareCondition } from '../../lib/widget/smartEngine';

type Compare = typeof compareCondition;

function shippedCompare(): Compare {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/', runScripts: 'outside-only' });
  const win = dom.window as unknown as { eval(src: string): void; __gs_smart_engine_module: { compareCondition: Compare } };
  win.eval(readFileSync(resolve(process.cwd(), 'public/widget/smart-engine.js'), 'utf8'));
  return win.__gs_smart_engine_module.compareCondition;
}

const CASES: Array<[string, string, boolean]> = [
  ['/checkout', '/checkout', true],
  ['/shop/checkout', '/checkout', true],
  ['/SHOP/CHECKOUT', '/checkout', true],
  ['/checkou', '/checkout', false],
  ['ir', '.ir', false],
  ['x', 'ab', false],
  ['', 'a', false],
  ['/checkout/', '/checkout', false],
  ['/checkout', '', false],
  ['abcabc', 'abc', true],
];

describe('ends_with', () => {
  for (const [name, compare] of [['the source', compareCondition], ['the shipped smart-engine.js', shippedCompare()]] as const) {
    it.each(CASES)(`${name}: %j ends with %j → %s`, (actual, suffix, expected) => {
      expect(compare(actual, 'ends_with', suffix)).toBe(expected);
    });
  }
});
