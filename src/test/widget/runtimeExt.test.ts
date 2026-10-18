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
 *    the module's fields, also when the module comes after the 1.5 s wait.
 *  - A template's descriptor says whether its renderer declares features
 *    (`coreFeatures`): the bootstrap names the module for those templates
 *    only, and the loader fetches it with their files
 *    (src/test/widget/loaderOpenIntent.test.ts, templateCatalogConfig.test.ts).
 *  - The late pack (the renderer's extras + runtime-late.js): asked for
 *    only by a renderer whose descriptor names extras, after its first paint
 *    (a skeleton is none; the next idle moment; at once in the chat view or
 *    for a control that needs it), by the canonical names after a failed
 *    hashed URL, applied together or not at all (an id or version that is
 *    not the renderer's refuses both), with one repaint when the renderer
 *    missed a surface meanwhile; `default` and `intl` never ask. The late
 *    module's handlers run after runtime-ext's own on the same hooks.
 *  - t1's emoji grid comes with its extras: the button opens the picker
 *    once they are in, asks for them at once on a first press, and goes if
 *    they fail or hold no grid. A pack already on the page is applied before
 *    the first paint when it is the renderer's own.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, click, flush, resetWindow, type BaseRenderer, type Renderer } from './coreFeaturesHarness';
import { CHAT_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';
import { chatTemplateOptionKeys } from '../../../shared/chatTemplateCatalog';

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
      // The late features (runtime-late.js): reactions, steps, away, queue.
      'data-msg-react', 'toggleReaction', '/reactions', 'data-prechat-step', 'prechatStepsHtml', 'offline-email',
      'client_message_id: req', 'awayReply', '/api/widget/queue', 'data-ph-away',
      // Round 4: instant answers, the order card, the emoji search, download progress, the author.
      'kb-suggest', 'suggestArticles', 'data-kb-suggest', 'order_status', 'data-emoji-search', 'runtime-emoji', 'dl-on', 'author_name',
    ]) expect(RUNTIME.includes(name), name).toBe(false);
  });
});

describe('which templates build on the module', () => {
  it('a descriptor\'s `coreFeatures` is exactly whether its renderer declares features', () => {
    const w = window as unknown as Record<string, unknown>;
    w.MediaRecorder = function () {};
    new Function(read('public/widget/presentation-registry.js')).call(window);
    const registry = w.__gs_presentation_registry as { resolve: (id: string) => { globalKey: string } };
    const ids = Object.keys(CHAT_WIDGET_TEMPLATES) as Array<keyof typeof CHAT_WIDGET_TEMPLATES>;
    expect(ids.filter((id) => CHAT_WIDGET_TEMPLATES[id].coreFeatures)).toEqual(['t1', 't2', 't1-intl', 't2-intl']);
    for (const id of ids) {
      new Function(read(`public/widget/${CHAT_WIDGET_TEMPLATES[id].script}`)).call(window);
      const mod = w[registry.resolve(id).globalKey] as { create: (env: Record<string, unknown>) => Record<string, unknown> };
      const r = mod.create({
        t: (k: string) => k, escapeHtml: (v: unknown) => String(v), linkifyHtml: (v: unknown) => String(v), linkLabel: '',
        config: { templateId: id }, locale: 'fa', primaryColor: '#3B82F6',
        capabilities: { kbNeutral: true, csat: false, reactions: false, orderCard: false, prechatSteps: false, instantAnswers: false },
      });
      expect(!!r.features, id).toBe(CHAT_WIDGET_TEMPLATES[id].coreFeatures);
    }
  });

  it('a descriptor\'s `closedNotice` (the server writes the closed line) is exactly its renderer\'s `features.closedNotice`', () => {
    const w = window as unknown as Record<string, unknown>;
    w.MediaRecorder = function () {};
    new Function(read('public/widget/presentation-registry.js')).call(window);
    const registry = w.__gs_presentation_registry as { resolve: (id: string) => { globalKey: string } };
    const ids = Object.keys(CHAT_WIDGET_TEMPLATES) as Array<keyof typeof CHAT_WIDGET_TEMPLATES>;
    expect(ids.filter((id) => CHAT_WIDGET_TEMPLATES[id].closedNotice)).toEqual(['t2', 't2-intl']);
    for (const id of ids) {
      new Function(read(`public/widget/${CHAT_WIDGET_TEMPLATES[id].script}`)).call(window);
      const mod = w[registry.resolve(id).globalKey] as { create: (env: Record<string, unknown>) => { features?: Record<string, boolean> } };
      const r = mod.create({ t: (k: string) => k, config: { templateId: id }, locale: 'fa' });
      const f = r.features || {};
      expect(!!f.closedNotice, id).toBe(CHAT_WIDGET_TEMPLATES[id].closedNotice);
      // The server rates (services/conversationRatings.ts csatEnabledFor) and
      // mails a transcript (visitorTranscript.ts) for the template's own
      // options: exactly the templates whose renderer draws the card (under
      // its own closed line) or the ⋯ menu that asks for them.
      const options = chatTemplateOptionKeys(id);
      expect(!!f.csat, `${id} csat`).toBe(options.includes('csat'));
      if (f.csat) expect(f.closedNotice, `${id} csat needs its line`).toBe(true);
      expect(!!(f.csat || f.chatMenu), `${id} transcript`).toBe(options.includes('transcriptEmail'));
    }
  });

  it('a descriptor\'s `reactions` (the inbox offers React) is exactly its renderer\'s `features.reactions` with Core\'s capabilities', () => {
    const w = window as unknown as Record<string, unknown>;
    w.MediaRecorder = function () {};
    new Function(read('public/widget/presentation-registry.js')).call(window);
    const registry = w.__gs_presentation_registry as { resolve: (id: string) => { globalKey: string } };
    // The capabilities runtime.js passes (one literal, pinned by previewParity.test.ts).
    const caps = new Function(`return ${/capabilities: (\{ kbNeutral: [^}]*\})/.exec(RUNTIME)![1]};`)() as Record<string, boolean>;
    expect(caps.reactions).toBe(true);
    const ids = Object.keys(CHAT_WIDGET_TEMPLATES) as Array<keyof typeof CHAT_WIDGET_TEMPLATES>;
    const flag = (id: keyof typeof CHAT_WIDGET_TEMPLATES) => !!(CHAT_WIDGET_TEMPLATES[id] as { reactions?: boolean }).reactions;
    expect(ids.filter(flag)).toEqual(['t2', 't2-intl']);
    for (const id of ids) {
      new Function(read(`public/widget/${CHAT_WIDGET_TEMPLATES[id].script}`)).call(window);
      const mod = w[registry.resolve(id).globalKey] as { create: (env: Record<string, unknown>) => { features?: Record<string, boolean> } };
      const r = mod.create({ t: (k: string) => k, config: { templateId: id }, locale: 'fa', capabilities: caps });
      expect(!!(r.features || {}).reactions, id).toBe(flag(id));
    }
  });

  it('a descriptor\'s `extras` is the registry\'s, exactly when its renderer can take extras, and that file is the renderer\'s', () => {
    const w = window as unknown as Record<string, unknown>;
    w.MediaRecorder = function () {};
    new Function(read('public/widget/presentation-registry.js')).call(window);
    const registry = w.__gs_presentation_registry as { resolve: (id: string) => { globalKey: string; extras?: string } };
    const ids = Object.keys(CHAT_WIDGET_TEMPLATES) as Array<keyof typeof CHAT_WIDGET_TEMPLATES>;
    expect(ids.filter((id) => CHAT_WIDGET_TEMPLATES[id].extras)).toEqual(['t1', 't2', 't1-intl', 't2-intl']);
    for (const id of ids) {
      const t = CHAT_WIDGET_TEMPLATES[id];
      const d = registry.resolve(id);
      expect(d.extras ?? null, id).toBe(t.extras);
      new Function(read(`public/widget/${t.script}`)).call(window);
      const mod = w[d.globalKey] as { id: string; create: (env: Record<string, unknown>) => Record<string, unknown> };
      const r = mod.create({ t: (k: string) => k, config: { templateId: id }, locale: 'fa' });
      expect(typeof r.extend === 'function', id).toBe(!!t.extras);
      // Only a template whose renderer declares features gets runtime-ext.js, which brings the extras.
      if (t.extras) expect(t.coreFeatures, id).toBe(true);
      if (!t.extras) continue;
      delete w.__gs_mod_extras;
      new Function(read(`public/widget/${t.extras}`)).call(window);
      const extras = w.__gs_mod_extras as { id: string; v: number };
      // The renderer's id (a skin over it wears the same file), and it takes the file.
      expect(extras.id, id).toBe(mod.id);
      expect((r.extend as (m: unknown, dry?: boolean) => number)(extras, true), id).toBe(1);
    }
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
    expect(h.panel.classList.contains('ext-off')).toBe(false);
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
    // …and says so (`.ext-off`), so the template sets its feature controls aside.
    expect(h.panel.classList.contains('ext-off')).toBe(true);
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
    expect(h.panel.classList.contains('ext-off')).toBe(false);
  });

  it('waits at most 1.5 s, then paints without it; a module that comes later repaints', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: named(), identity: IDENTIFIED, ext: 'hold' });
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.lastCall('homeHtml')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lastCall('homeHtml')).toBeDefined();
    expect(h.q('[data-greeting]')!.textContent).toBe('');
    expect(h.panel.classList.contains('ext-off')).toBe(true);
    h.releaseExt();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.q('[data-greeting]')!.textContent).toBe('علی');
    expect(h.panel.classList.contains('ext-off')).toBe(false);
  });

  it('a module later than the wait still gets what Core saw meanwhile: the thread list carries its fields', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({
      renderer: named({ conversationOperator: true }),
      ext: 'hold',
      conversations: [{ id: 'c1', status: 'resolved', outbound: true, operatorName: 'سارا', operatorOnline: true }],
    });
    await vi.advanceTimersByTimeAsync(1600);
    const first = h.lastCall('homeHtml')![0] as { conversations: Array<Record<string, unknown>> };
    expect(first.conversations[0]).not.toHaveProperty('operatorName');
    h.releaseExt();
    await vi.advanceTimersByTimeAsync(50);
    const row = (h.lastCall('homeHtml')![0] as { conversations: Array<Record<string, unknown>> }).conversations[0];
    expect(row).toMatchObject({ id: 'c1', lastFromVisitor: true, operatorName: 'سارا', operatorOnline: true });
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

// ─── The late pack ──────────────────────────────────────────────────────

type Dict = Record<string, unknown>;
const LATE_URL = 'https://cdn.test/widget/runtime-late.0123abcd.js';
const EXTRAS_URL = 'https://cdn.test/widget/presentation-tx-x.0123abcd.js';
const lateScripts = (h: ReturnType<typeof boot>) => h.scripts.filter((s) => /runtime-late|-x\./.test(s));
const homeCalls = (h: ReturnType<typeof boot>) => h.calls.filter((c) => c.surface === 'homeHtml').length;

/**
 * A renderer from `default` that takes extras as t1 and t2 do (`extend`,
 * id 'tx', contract version 1); with `ask`, home asks for one extras
 * surface (`cardHtml`), which draws nothing until they are in.
 */
const withExtras = (opts: { ask?: boolean; features?: Record<string, boolean> } = {}) => (base: BaseRenderer): Renderer => {
  let X: Record<string, (...a: unknown[]) => string> | null = null;
  let missed = false;
  const x = (name: string, args: unknown[]) => {
    if (X && X[name]) return X[name](...args);
    missed = true;
    return '';
  };
  return {
    features: opts.features || { tabs: true },
    extend: (mod: Dict, dry?: boolean) => {
      if (!mod || mod.id !== 'tx' || mod.v !== 1 || typeof mod.create !== 'function') return 0;
      if (dry) return 1;
      X = X || (mod.create as (h: Dict) => Record<string, (...a: unknown[]) => string>)({});
      const m = missed;
      missed = false;
      return m ? 2 : 1;
    },
    homeHtml: (vm: Dict) => base.homeHtml(vm) + (opts.ask ? `<div data-late-slot>${x('cardHtml', [vm])}</div>` : ''),
  };
};
const EXTRAS = { id: 'tx', v: 1, create: () => ({ cardHtml: () => '<b data-card>card</b>' }) };
const lateConfig = { modules: { ext: 'https://cdn.test/widget/runtime-ext.0123abcd.js', late: LATE_URL, extras: EXTRAS_URL } };

describe('the late pack: who asks for it, and when', () => {
  it('default and intl never ask for it, and paint and call the API exactly as without it', async () => {
    for (const templateId of ['default', 'intl']) {
      const plain = boot({ renderer: 'default', config: { templateId } });
      await flush(30);
      const before = { scripts: plain.scripts, fetches: plain.fetches, html: plain.panel.innerHTML };
      resetWindow();
      vi.restoreAllMocks();
      // Even a bootstrap that named the pack's files changes nothing.
      const named = boot({ renderer: 'default', config: { templateId, modules: { late: LATE_URL, extras: EXTRAS_URL } } });
      await flush(30);
      expect(lateScripts(named), templateId).toEqual([]);
      expect(named.scripts, templateId).toEqual(before.scripts);
      expect(named.fetches, templateId).toEqual(before.fetches);
      expect(named.panel.innerHTML, templateId).toBe(before.html);
      resetWindow();
      vi.restoreAllMocks();
    }
  });

  it('a renderer whose descriptor names no extras never asks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: withExtras({ ask: true }), config: lateConfig });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lateScripts(h)).toEqual([]);
  });

  it('asks for both files, by their hashed URLs, only after the first paint: at the next idle moment (300 ms without requestIdleCallback)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: withExtras(), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig });
    expect(lateScripts(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(homeCalls(h)).toBeGreaterThan(0);
    expect(lateScripts(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL]);
    // Asked for once.
    h.runtime.setTab('help');
    h.runtime.setTab('home');
    await vi.advanceTimersByTimeAsync(1000);
    expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL]);
  });

  it('a skeleton is not the first paint: nothing is asked for while one is on screen, its real paint asks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: withExtras(), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig, holdConversations: true });
    await vi.advanceTimersByTimeAsync(1000);
    // Home waits for the thread list on its skeleton.
    expect(h.body.firstElementChild!.classList.contains('wy-skeleton')).toBe(true);
    expect(homeCalls(h)).toBe(0);
    expect(lateScripts(h)).toEqual([]);
    h.releaseConversations();
    await vi.advanceTimersByTimeAsync(20);
    expect(homeCalls(h)).toBeGreaterThan(0);
    expect(lateScripts(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL]);
  });

  it('with requestIdleCallback, waits for it (2 s at most)', async () => {
    const idle: Array<{ cb: () => void; opts: unknown }> = [];
    (window as unknown as Dict).requestIdleCallback = (cb: () => void, o: unknown) => { idle.push({ cb, opts: o }); return 1; };
    try {
      const h = boot({ renderer: withExtras(), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig });
      await flush(30);
      expect(idle.map((i) => i.opts)).toEqual([{ timeout: 2000 }]);
      expect(lateScripts(h)).toEqual([]);
      idle[0].cb();
      expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL]);
    } finally {
      delete (window as unknown as Dict).requestIdleCallback;
    }
  });

  it('the chat view asks at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: withExtras(), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig });
    await vi.advanceTimersByTimeAsync(20);
    expect(lateScripts(h)).toEqual([]);
    h.runtime.setTab('chat');
    expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL]);
  });

  it('without hashed URLs, the canonical names (versioned like every module)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({ renderer: withExtras(), extras: 'presentation-tx-x.js', extrasModule: EXTRAS });
    await vi.advanceTimersByTimeAsync(400);
    expect(lateScripts(h)).toEqual([
      'https://cdn.test/widget/presentation-tx-x.js?v=dev',
      'https://cdn.test/widget/runtime-late.js?v=dev',
    ]);
  });
});

describe('the late pack: applied together, or not at all', () => {
  const pack = (over: Partial<Parameters<typeof boot>[0]> = {}) => boot({
    renderer: withExtras({ ask: true }), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig, late: 'hold', ...over,
  });

  it('a surface asked for before it was in is drawn by exactly one repaint', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const created: Dict[] = [];
    const h = pack({ lateModule: { v: 2, create: (api: Dict) => { created.push(api); return {}; } } });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.q('[data-late-slot]')!.innerHTML).toBe('');
    const painted = homeCalls(h);
    h.releaseLate();
    await vi.advanceTimersByTimeAsync(50);
    expect(created).toHaveLength(1);
    expect(homeCalls(h)).toBe(painted + 1);
    expect(h.q('[data-card]')!.textContent).toBe('card');
    // The late module builds on runtime-ext's own surface.
    const api = created[0];
    expect((api.ctx as { config: Dict }).config.templateId).toBe('tx');
    for (const k of ['P', 'panel', 'chatQ', 'chatStore', 'shellStore', 'uiPrefsStore', 'renderBody', 'ModuleLoader', 'feat', 'on', 'loadLatePack', 'paintChatHeader']) {
      expect(api[k], k).toBeTruthy();
    }
    expect((api.feat as (n: string) => boolean)('tabs')).toBe(true);
  });

  it('no repaint when nothing was missed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = pack({ renderer: withExtras() });
    await vi.advanceTimersByTimeAsync(400);
    const painted = homeCalls(h);
    h.releaseLate();
    await vi.advanceTimersByTimeAsync(50);
    expect(homeCalls(h)).toBe(painted);
  });

  const refused: Array<[string, Partial<Parameters<typeof boot>[0]>]> = [
    ['extras of another template', { extrasModule: { ...EXTRAS, id: 't1' } }],
    ['extras of another contract version', { extrasModule: { ...EXTRAS, v: 2 } }],
    ['no extras at all (the file defined nothing)', { extrasModule: null }],
    ['a late module of another contract version', { lateModule: { v: 1, create: () => ({}) } }],
    ['a late module that throws', { lateModule: { v: 2, create: () => { throw new Error('boom'); } } }],
  ];
  for (const [what, over] of refused) {
    it(`refuses both for ${what}: the late module's handlers never run, nothing is drawn, no repaint`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const ran: string[] = [];
      const lateModule = over.lateModule ?? { v: 2, create: (api: Dict) => { (api.on as (n: string, f: () => void) => boolean)('body', () => { ran.push('body'); }); return {}; } };
      const h = pack({ ...over, lateModule });
      await vi.advanceTimersByTimeAsync(400);
      const painted = homeCalls(h);
      h.releaseLate();
      await vi.advanceTimersByTimeAsync(50);
      expect(homeCalls(h)).toBe(painted);
      h.runtime.setTab('help');
      h.runtime.setTab('home');
      await vi.advanceTimersByTimeAsync(50);
      expect(ran).toEqual([]);
      expect(h.q('[data-card]')).toBeNull();
      expect(h.calls.filter((c) => c.surface === 'extend' && c.args[1] !== true)).toEqual([]);
    });
  }

  it('a request that fails (both names) applies neither', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const created: unknown[] = [];
    const h = pack({ late: 'fail', lateModule: { v: 2, create: () => { created.push(1); return {}; } } });
    await vi.advanceTimersByTimeAsync(500);
    expect(lateScripts(h)).toEqual([
      EXTRAS_URL, LATE_URL,
      'https://cdn.test/widget/presentation-tx-x.js?v=dev', 'https://cdn.test/widget/runtime-late.js?v=dev',
    ]);
    expect(created).toEqual([]);
    expect(h.calls.filter((c) => c.surface === 'extend')).toEqual([]);
    expect(h.q('[data-card]')).toBeNull();
  });
});

describe('the late pack: one file failing, a hashed URL failing', () => {
  const CANONICAL = {
    extras: 'https://cdn.test/widget/presentation-tx-x.js?v=dev',
    late: 'https://cdn.test/widget/runtime-late.js?v=dev',
  };
  for (const [late, which] of [['fail-extras', 'extras'], ['fail-late', 'late']] as const) {
    it(`only the ${which === 'extras' ? 'extras' : 'late module'} failing (both names) applies neither`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const created: unknown[] = [];
      const h = boot({
        renderer: withExtras({ ask: true }), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig, late,
        lateModule: { v: 2, create: () => { created.push(1); return {}; } },
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL, CANONICAL[which]]);
      expect(created).toEqual([]);
      expect(h.calls.filter((c) => c.surface === 'extend' && c.args[1] !== true)).toEqual([]);
      expect(h.q('[data-card]')).toBeNull();
    });
  }

  it('hashed URLs that fail (a page older than the deploy) are retried by their canonical names, and the pack applies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = boot({
      renderer: withExtras({ ask: true }), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig, late: 'fail-hashed',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(lateScripts(h)).toEqual([EXTRAS_URL, LATE_URL, CANONICAL.extras, CANONICAL.late]);
    expect(h.q('[data-card]')!.textContent).toBe('card');
  });
});

describe('the late module\'s handlers', () => {
  it('run after runtime-ext\'s own, get its answer and may override it; one that throws is skipped; only Core\'s hooks take one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seen: unknown[] = [];
    const taken: boolean[] = [];
    const lateModule = {
      v: 2,
      create: (api: Dict) => {
        const on = api.on as (n: string, f: (...a: unknown[]) => unknown) => boolean;
        taken.push(on('noSuchHook', () => true));
        taken.push(on('wait', () => { throw new Error('skipped'); }));
        // Home waits for the visitor's name only with `visitorName` (own answer: false); this one holds it.
        taken.push(on('wait', (_a, _b, out) => { seen.push(out); return true; }));
        return {};
      },
    };
    const h = boot({
      renderer: withExtras({ ask: true }), extras: 'presentation-tx-x.js', extrasModule: EXTRAS, config: lateConfig, lateModule,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(taken).toEqual([false, true, true]);
    // The pack's repaint (a surface was missed) runs the hook: held, home is not painted.
    expect(seen).toEqual([false]);
    const painted = homeCalls(h);
    h.runtime.setTab('help');
    h.runtime.setTab('home');
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toEqual([false, false]);
    expect(homeCalls(h)).toBe(painted);
  });
});

describe('t1: the emoji grid comes with its extras', () => {
  const picker = (h: ReturnType<typeof boot>) => h.q('[data-emoji-picker]')!;
  const button = (h: ReturnType<typeof boot>) => h.q<HTMLButtonElement>('[data-emoji-btn]')!;
  const toChat = async (h: ReturnType<typeof boot>) => { h.runtime.setTab('chat'); await flush(10); };

  it('the first press opens nothing until they are in, asks for them, then opens the picker with its groups', async () => {
    const h = boot({ renderer: 't1', late: 'hold', hint: { tab: 'home', conversationId: null } });
    await flush(20);
    expect(lateScripts(h)).toEqual([]);
    await toChat(h);
    // Core keeps a renderer's own grid: the hidden mark, not its plain list.
    expect(picker(h).querySelector('[data-emoji]:not([hidden])')).toBeNull();
    expect(picker(h).querySelector('[data-emoji-tab]')).toBeNull();
    expect(lateScripts(h).map((s) => s.replace(/\?.*$/, ''))).toEqual([
      'https://cdn.test/widget/presentation-t1-x.js', 'https://cdn.test/widget/runtime-late.js',
    ]);
    click(button(h));
    await flush(5);
    expect(picker(h).hidden).toBe(true);
    expect(button(h).getAttribute('aria-expanded')).toBe('false');
    h.releaseLate();
    await flush(10);
    expect(picker(h).querySelectorAll('[data-emoji-tab]')).toHaveLength(6);
    expect(picker(h).querySelectorAll('[data-emoji-group]')).toHaveLength(6);
    expect(picker(h).hidden).toBe(false);
    expect(button(h).getAttribute('aria-expanded')).toBe('true');
    // From then on the button is Core's toggle.
    click(button(h));
    expect(picker(h).hidden).toBe(true);
    click(button(h));
    expect(picker(h).hidden).toBe(false);
    // An emoji goes into the composer.
    click(picker(h).querySelector('[data-emoji="🙏"]'));
    expect(h.q<HTMLTextAreaElement>('[data-msg-input]')!.value).toBe('🙏');
  });

  it('arriving before any press, the grid is put in and the picker stays closed', async () => {
    const h = boot({ renderer: 't1' });
    await flush(20);
    await toChat(h);
    await flush(10);
    expect(picker(h).querySelectorAll('[data-emoji-tab]')).toHaveLength(6);
    expect(picker(h).hidden).toBe(true);
    expect(button(h).hidden).toBe(false);
  });

  it('if they fail, the button goes (never a picker with nothing to pick)', async () => {
    const h = boot({ renderer: 't1', late: 'fail' });
    await flush(20);
    await toChat(h);
    await flush(20);
    expect(button(h).hidden).toBe(true);
    expect(picker(h).hidden).toBe(true);
  });

  it('extras without a grid: the button goes too', async () => {
    const h = boot({ renderer: 't1', extrasModule: { id: 't1', v: 2, create: () => ({}) } });
    await flush(20);
    await toChat(h);
    await flush(20);
    expect(lateScripts(h)).toHaveLength(2);
    expect(button(h).hidden).toBe(true);
    expect(picker(h).hidden).toBe(true);
  });

  it('a pack already on the page (an earlier instance\'s) is applied before the first paint and asked for no more', async () => {
    new Function(read('public/widget/presentation-t1-x.js')).call(window);
    const created: unknown[] = [];
    (window as unknown as Dict).__gs_mod_late = { v: 2, create: () => { created.push(1); return {}; } };
    const h = boot({ renderer: 't1' });
    await flush(20);
    expect(created).toHaveLength(1);
    await toChat(h);
    expect(picker(h).querySelectorAll('[data-emoji-tab]')).toHaveLength(6);
    h.runtime.setTab('home');
    await toChat(h);
    await flush(20);
    expect(lateScripts(h)).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it('another renderer\'s pack on the page is refused, and t1 asks for its own', async () => {
    new Function(read('public/widget/presentation-t2-x.js')).call(window);
    new Function(read('public/widget/runtime-late.js')).call(window);
    const h = boot({ renderer: 't1' });
    await flush(20);
    await toChat(h);
    await flush(20);
    expect(lateScripts(h)).toHaveLength(2);
    expect(picker(h).querySelectorAll('[data-emoji-tab]')).toHaveLength(6);
    expect(button(h).hidden).toBe(false);
  });

  it('a renderer drawing its grid from extras its descriptor does not name hides the button at once', async () => {
    const h = boot({
      renderer: (base: BaseRenderer) => ({
        features: { emojiTabs: true },
        emojiPickerHtml: () => '<i data-emoji hidden></i>',
        chatFrameHtml: (vm: unknown) => base.chatFrameHtml(vm).replace(
          '<div class="emoji-picker" data-emoji-picker hidden></div>',
          '<div class="emoji-picker" data-emoji-picker hidden><i data-emoji hidden></i></div>'),
      }),
    });
    await flush(20);
    await toChat(h);
    expect(button(h).hidden).toBe(true);
    expect(lateScripts(h)).toEqual([]);
  });
});
