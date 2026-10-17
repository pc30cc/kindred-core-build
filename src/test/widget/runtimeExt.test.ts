/**
 * runtime-ext.js: the renderer features as a lazy Core module
 * (docs/operations/WIDGET_TEMPLATE_RULES.md §2). runtime.js, which every
 * visitor downloads on a first open, keeps only the hook points; the
 * behaviours a renderer opts into (`features` from its create()) live in the
 * module, which only such a renderer requests.
 *
 *  - The two files agree: every `ext('<hook>')` Core calls is a hook the
 *    module returns (and the other way round), and the instance parts Core
 *    hands over positionally are the ones the module's create() names.
 *  - `default` (no features) never requests the module and is never held.
 *  - A renderer with features requests it once (by `config.modules.ext`,
 *    the canonical name after a 404), holds its first paint on the skeleton
 *    until it is in, at most 1.5 s, and repaints with it when it is late.
 *  - Data Core mapped before the module was in (the thread list) still gets
 *    the module's fields.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, flush, resetWindow, type BaseRenderer, type Renderer } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const RUNTIME = read('public/widget/runtime.js');
const EXT = read('public/widget/runtime-ext.js');

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const names = (list: string) => list.replace(/\/\/[^\n]*/g, '').split(',').map((s) => s.trim()).filter(Boolean);

describe('runtime.js and runtime-ext.js agree', () => {
  it('every hook Core calls is one the module returns, and none is left over', () => {
    const called = new Set([...RUNTIME.matchAll(/\bext\('(\w+)'/g)].map((m) => m[1]));
    const returned = EXT.slice(EXT.indexOf('// The hooks runtime.js runs'));
    const hooks = new Set([...returned.matchAll(/^ {6}(\w+): /gm)].map((m) => m[1]));
    expect(called.size).toBeGreaterThan(20);
    expect([...called].filter((n) => !hooks.has(n))).toEqual([]);
    expect([...hooks].filter((n) => !called.has(n))).toEqual([]);
  });

  it('Core passes the instance parts in the order the module\'s create() names them', () => {
    const passed = names(RUNTIME.match(/Ext = mod\.create\(([\s\S]*?)\);/)![1]);
    const params = names(EXT.match(/function create\(([\s\S]*?)\) \{/)![1]);
    // The same names on both sides, except the renderer (`P`) and the calls
    // made before the module was in.
    expect(params).toEqual(passed.map((n) => ({ Presentation: 'P', extCalls: 'earlyCalls' } as Record<string, string>)[n] || n));
  });

  it('the chat view parts (createChatUI `x`) are read in the order Core lists them', () => {
    const listed = names(RUNTIME.match(/x: \[([\s\S]*?)\],/)![1]);
    const read = [...EXT.matchAll(/var (\w+) = chatUI\.x\[(\d)\];/g)].map((m) => [Number(m[2]), m[1]] as const);
    expect(read.map(([i]) => i)).toEqual(listed.map((_, i) => i));
    expect(read.map(([, n]) => n)).toEqual(listed);
  });

  it('runtime.js keeps the hook points only: no feature is implemented there', () => {
    // Names of the feature code that moved; Core never needs them back.
    for (const name of [
      'feat(', 'searchCache', 'prechatSummary', 'homeAskDraft', 'paintTabBadges', 'setOperatorTypingVm',
      'paintChatHeader', 'startConversationWith', 'recSendWhenReady', 'data-kb-category', 'data-tab-badge',
      'data-emoji-tab', 'data-prechat-skip', 'data-rec-send', 'data-vn-rate', 'data-home-ask',
    ]) expect(RUNTIME.includes(name), name).toBe(false);
  });
});

/** A renderer built from `default` that declares `visitorName` (home greets by name). */
const named = (features: Record<string, boolean> = { visitorName: true }) => (base: BaseRenderer): Renderer => ({
  features,
  homeHtml: (vm: Record<string, unknown>) => base.homeHtml(vm) + `<p data-greeting>${String(vm.visitorName ?? '')}</p>`,
});
const IDENTIFIED = { identity_state: 'identified', contact: { name: 'علی رضایی' } };
const extScripts = (h: ReturnType<typeof boot>) => h.scripts.filter((s) => /runtime-ext/.test(s));

describe('loading the module', () => {
  it('default never requests it and paints at once', async () => {
    const h = boot({ renderer: 'default', ext: 'hold' });
    await flush(20);
    expect(extScripts(h)).toEqual([]);
    expect(h.lastCall('homeHtml')).toBeDefined();
  });

  it('a renderer with features requests it once, by the hashed URL /config names', async () => {
    const h = boot({ renderer: named(), identity: IDENTIFIED, config: { modules: { ext: 'https://cdn.test/widget/runtime-ext.0123abcd.js' } } });
    await flush(20);
    expect(extScripts(h)).toEqual(['https://cdn.test/widget/runtime-ext.0123abcd.js']);
    expect((h.lastCall('homeHtml')![0] as Record<string, unknown>).visitorName).toBe('علی');
  });

  it('a failed module (both names 404) releases the panel at once, without the features', async () => {
    const h = boot({ renderer: named(), identity: IDENTIFIED, ext: 'fail', config: { modules: { ext: 'https://cdn.test/widget/runtime-ext.0123abcd.js' } } });
    await flush(20);
    expect(extScripts(h)).toEqual([
      'https://cdn.test/widget/runtime-ext.0123abcd.js',
      'https://cdn.test/widget/runtime-ext.js?v=dev',
    ]);
    const vm = h.lastCall('homeHtml')![0] as Record<string, unknown>;
    expect(vm).not.toHaveProperty('visitorName');
  });

  it('the first paint holds the skeleton until the module is in, then paints with it', async () => {
    const h = boot({ renderer: named(), identity: IDENTIFIED, ext: 'hold' });
    await flush(20);
    expect(h.lastCall('homeHtml')).toBeUndefined();
    expect(h.body.querySelector('[data-greeting]')).toBeNull();
    expect(h.body.innerHTML).not.toBe('');
    h.releaseExt();
    await flush(5);
    expect(h.q('[data-greeting]')!.textContent).toBe('علی');
  });

  it('waits at most 1.5 s, then paints without it; a module that comes later repaints', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: named(), identity: IDENTIFIED, ext: 'hold' });
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.lastCall('homeHtml')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lastCall('homeHtml')).toBeDefined();
    expect(h.q('[data-greeting]')!.textContent).toBe('');
    h.releaseExt();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.q('[data-greeting]')!.textContent).toBe('علی');
  });

  it('a thread list that arrived before the module still carries its fields', async () => {
    const h = boot({
      renderer: named({ conversationOperator: true }),
      ext: 'hold',
      conversations: [{ id: 'c1', status: 'resolved', outbound: true, operatorName: 'سارا', operatorOnline: true }],
    });
    await flush(20);
    h.releaseExt();
    await flush(5);
    const row = (h.lastCall('homeHtml')![0] as { conversations: Array<Record<string, unknown>> }).conversations[0];
    expect(row).toMatchObject({ id: 'c1', lastFromVisitor: true, operatorName: 'سارا', operatorOnline: true });
  });
});
