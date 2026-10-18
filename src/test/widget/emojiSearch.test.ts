/**
 * The emoji picker's search (t1 06; issue #340, g5-2c), with the SHIPPED
 * runtime.js, runtime-ext.js, runtime-late.js, runtime-emoji.js and the real
 * t1 renderer and extras (coreFeaturesHarness.ts):
 *
 *  - the field (the extras') shows once the late pack is in, never focused
 *    by itself; the keywords (runtime-emoji.js, `config.modules.emoji`) are
 *    asked for on its first focus or input, never before, never twice;
 *  - a query in any of the three languages finds its emoji by the start of
 *    their words, whatever the Persian / Arabic letters, ZWNJ and digits it
 *    is typed with; what does not match is hidden, a group left empty too,
 *    and an emoji already shown in an earlier group (the frequent ones) is
 *    shown once; nothing found: the "no emoji found" line;
 *  - Enter puts the first one in the message, at the caret; Escape empties
 *    the field first, then closes the picker; reopened, the whole grid;
 *  - while the keywords load, and if they never come: the whole grid (and
 *    no field that finds nothing);
 *  - the keyword data covers every emoji t1 and Core draw, in en, fa and tr.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, click, flush, key, resetWindow, typeInto, type BootOptions } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

function start(opts: BootOptions & { preloaded?: boolean } = {}) {
  if (opts.preloaded !== false) {
    new Function(read('public/widget/presentation-t1-x.js')).call(window);
    new Function(read('public/widget/runtime-late.js')).call(window);
  }
  return boot({ renderer: 't1', config: { modules: { emoji: 'https://cdn.test/widget/runtime-emoji.0123abcd.js' } }, ...opts });
}
async function openPicker(h: ReturnType<typeof boot>) {
  await flush(30);
  h.runtime.setTab('chat');
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
  click(h.q('[data-emoji-btn]'));
  await flush(10);
}
const field = (h: ReturnType<typeof boot>) => h.q<HTMLInputElement>('[data-emoji-picker] [data-emoji-search]')!;
const shown = (h: ReturnType<typeof boot>) => Array.from(h.q('[data-emoji-picker]')!.querySelectorAll('[data-emoji-group]:not([hidden]) [data-emoji]:not([hidden])'))
  .map((b) => b.getAttribute('data-emoji'));
const groups = (h: ReturnType<typeof boot>) => Array.from(h.q('[data-emoji-picker]')!.querySelectorAll('[data-emoji-group]')).map((g) => !g.hasAttribute('hidden'));
const emojiAsks = (h: ReturnType<typeof boot>) => h.scripts.filter((s) => /runtime-emoji/.test(s));
async function search(h: ReturnType<typeof boot>, q: string) {
  field(h).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  typeInto(field(h), q);
  await flush(10);
}
const ALL = () => {
  const s = read('public/widget/presentation-t1-x.js');
  return [...(/var EMOJI = \[([\s\S]*?)\];/.exec(s)![1]).matchAll(/'([^']*)'/g)].flatMap((m) => m[1].split(' '));
};

describe('the field', () => {
  it('shows with the extras\' grid, unfocused; the keywords are asked for on its first use only', async () => {
    const h = start();
    await openPicker(h);
    const label = h.q('[data-emoji-picker] .ep-sr')!;
    expect(label.hasAttribute('hidden')).toBe(false);
    expect(h.shadow.activeElement).not.toBe(field(h));
    expect(emojiAsks(h)).toEqual([]);
    field(h).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await flush(10);
    expect(emojiAsks(h)).toEqual(['https://cdn.test/widget/runtime-emoji.0123abcd.js']);
    await search(h, 'قلب');
    await search(h, 'heart');
    expect(emojiAsks(h)).toHaveLength(1);
  });

  it('is not there before the late pack, nor for a renderer without the feature', async () => {
    const h = start({ preloaded: false, late: 'hold' });
    await flush(30);
    h.runtime.setTab('chat');
    await flush(30);
    expect(h.q('[data-emoji-search]')).toBeNull();
    expect(emojiAsks(h)).toEqual([]);
  });
});

describe('finding', () => {
  it('a Persian or an English word finds its emoji in its group, once; empty groups go', async () => {
    const h = start();
    await openPicker(h);
    await search(h, 'قلب');
    const hearts = shown(h);
    expect(hearts).toEqual(expect.arrayContaining(['😍', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '🖤', '💔', '💕', '💖', '🥰']));
    // ❤️ is in the frequent group and in the hearts: shown once, in the first.
    expect(hearts.filter((e) => e === '❤️')).toHaveLength(1);
    expect(h.q('[data-emoji-group="0"] [data-emoji="❤️"]')!.hasAttribute('hidden')).toBe(false);
    expect(h.q('[data-emoji-group="3"] [data-emoji="❤️"]')!.hasAttribute('hidden')).toBe(true);
    expect(groups(h)).toEqual([true, true, false, true, false, false]);
    expect(h.q('[data-emoji-picker]')!.classList.contains('is-searching')).toBe(true);
    await search(h, 'heart');
    expect(shown(h)).toEqual(expect.arrayContaining(['❤️', '💔', '💖']));
    await search(h, 'kalp');
    expect(shown(h)).toEqual(expect.arrayContaining(['❤️', '💔']));
  });

  it('by the start of words, every word of the query; Arabic letters, ZWNJ, vowel marks and digits as Persian', async () => {
    const h = start();
    await openPicker(h);
    const find = async (q: string) => { await search(h, q); return shown(h); };
    expect(await find('گرب')).toEqual(['🐱']);
    expect(await find('شكلات')).toEqual(['🍫']);
    expect(await find('چاي')).toEqual(expect.arrayContaining(['☕', '🍵']));
    expect(await find('توتفرنگی')).toEqual(['🍓']);
    expect(await find('توت‌فرنگی')).toEqual(['🍓']);
    expect(await find('۱۰۰')).toEqual(['💯']);
    expect(await find('١٠٠')).toEqual(['💯']);
    expect(await find('100')).toEqual(['💯']);
    expect(await find('قلب شکسته')).toEqual(['💔']);
    expect(await find('broken heart')).toEqual(['💔']);
    expect(await find('HEART')).toEqual(expect.arrayContaining(['❤️']));
    expect(await find('eart')).toEqual([]);
  });

  it('nothing found: the line says so; an empty field: the whole grid again', async () => {
    const h = start();
    await openPicker(h);
    await search(h, 'zzzz');
    expect(shown(h)).toEqual([]);
    expect(groups(h).every((g) => !g)).toBe(true);
    expect(h.q('[data-emoji-none]')!.hasAttribute('hidden')).toBe(false);
    await search(h, '');
    expect(shown(h)).toHaveLength(ALL().length);
    expect(h.q('[data-emoji-none]')!.hasAttribute('hidden')).toBe(true);
    expect(h.q('[data-emoji-picker]')!.classList.contains('is-searching')).toBe(false);
  });
});

describe('the keys', () => {
  it('Enter puts the first one in the message', async () => {
    const h = start();
    await openPicker(h);
    const input = h.q<HTMLTextAreaElement>('[data-msg-input]')!;
    typeInto(input, 'عالیه ');
    input.setSelectionRange(6, 6);
    await search(h, 'گربه');
    key(field(h), 'Enter');
    await flush(5);
    expect(input.value).toBe('عالیه 🐱');
    // An empty field picks nothing.
    await search(h, '');
    key(field(h), 'Enter');
    expect(input.value).toBe('عالیه 🐱');
  });

  it('Escape empties the field first (the picker stays), then closes the picker; reopened, the whole grid', async () => {
    const h = start();
    await openPicker(h);
    await search(h, 'قلب');
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    field(h).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(field(h).value).toBe('');
    expect(h.q('[data-emoji-picker]')!.hasAttribute('hidden')).toBe(false);
    expect(shown(h)).toHaveLength(ALL().length);
    key(field(h), 'Escape');
    expect(h.q('[data-emoji-picker]')!.hasAttribute('hidden')).toBe(true);
    // Closed with a query, opened again: the whole grid.
    click(h.q('[data-emoji-btn]'));
    await search(h, 'قلب');
    click(h.q('[data-emoji-btn]'));
    click(h.q('[data-emoji-btn]'));
    expect(field(h).value).toBe('');
    expect(shown(h)).toHaveLength(ALL().length);
  });
});

describe('without the keywords', () => {
  it('while they load, the whole grid', async () => {
    const h = start({ emoji: 'hold' });
    await openPicker(h);
    await search(h, 'قلب');
    expect(shown(h)).toHaveLength(ALL().length);
    h.releaseEmoji();
    await flush(10);
    expect(shown(h)).not.toHaveLength(ALL().length);
    expect(shown(h)).toContain('❤️');
  });

  it('if they never come: the whole grid, and the field goes', async () => {
    const h = start({ emoji: 'fail' });
    await openPicker(h);
    await search(h, 'قلب');
    await flush(10);
    expect(shown(h)).toHaveLength(ALL().length);
    expect(h.q('[data-emoji-picker] .ep-sr')!.hasAttribute('hidden')).toBe(true);
    expect(field(h).value).toBe('');
  });
});

describe('the keyword data (runtime-emoji.js)', () => {
  it('covers every emoji t1 and Core draw, in en, fa and tr', () => {
    const w = window as unknown as { __gs_mod_emoji?: { v: number; list: string; words: string[] } };
    new Function(read('public/widget/runtime-emoji.js')).call(window);
    const mod = w.__gs_mod_emoji!;
    expect(mod.v).toBe(1);
    const list = mod.list.split(' ');
    expect(new Set(list).size).toBe(list.length);
    const runtime = read('public/widget/runtime.js');
    const core = [...(/var EMOJI_LIST = \[([\s\S]*?)\];/.exec(runtime)![1]).matchAll(/'([^']*)'/g)].map((m) => m[1]);
    for (const e of new Set([...ALL(), ...core])) expect(list, e).toContain(e);
    expect(mod.words).toHaveLength(3);
    const [en, fa, tr] = mod.words.map((w2) => w2.split('|'));
    for (const lang of [en, fa, tr]) {
      expect(lang).toHaveLength(list.length);
      expect(lang.every((x) => x.trim().length > 0)).toBe(true);
    }
    expect(fa.every((x) => /[؀-ۿ]/.test(x))).toBe(true);
    expect(en.every((x) => /^[a-z0-9 +'-]+$/.test(x))).toBe(true);
    // Pure data: no network, no storage, and its licence named.
    const src = read('public/widget/runtime-emoji.js');
    expect(src).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|import\(/);
    expect(src).toMatch(/Unicode License/);
  });
});
