/**
 * The call widget's visual QA fixture (e2e/harness/callScreensFixture.ts)
 * against the handoff's reference HTML (docs/call-widget-handoff): every
 * acceptance panel of both brands has exactly one state, every demo string
 * the fixture feeds is text its board draws (a typo would otherwise show up
 * as a "rendering" difference), and the contract's fixture facts (00-contract
 * §8.1) hold.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS, BRANDS, BRAND_INFO, CALLBACK_CODE, CALLBACK_ID, CALL_MS, DEMO, ENDED_DURATION_S, LIGHT_ACCENT,
  ENGINE_METHODS, INK, PIXEL_KINDS, QUEUE_NEXT_MS, QUEUE_THIRD_MS, RECONNECT_MS, SLOT_DAYS, TRANSFER_MS,
  baseBootstrap, bookedSlot, boardClock, callStates, callbackSlots, frozenNow, mergeJson, onAccent,
  type Brand, type CallState, type JsonObject,
} from '../../../e2e/harness/callScreensFixture';

const ROOT = process.cwd();
/** Parsing a brand's reference pages in jsdom takes ~0.5 s here; CI runs many files at once. */
const PARSE_TIMEOUT = 20_000;
const refDir = (brand: Brand) => resolve(ROOT, 'docs/call-widget-handoff', brand, 'template-1-call-center/reference');

const pages = new Map<string, Document>();
function page(brand: Brand, file: string): Document {
  const key = `${brand}/${file}`;
  let doc = pages.get(key);
  if (!doc) {
    doc = new DOMParser().parseFromString(readFileSync(resolve(refDir(brand), file), 'utf8'), 'text/html');
    pages.set(key, doc);
  }
  return doc;
}

/** Top-level frames of a page (a frame nested in another match does not count), in document order. */
function frames(doc: Document, selector: string): Element[] {
  const all = [...doc.querySelectorAll(selector)];
  return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
/** What a frame draws: its text and its fields' values and placeholders. */
function frameText(el: Element): string {
  const fields = [...el.querySelectorAll('input, textarea')]
    .flatMap((f) => [f.getAttribute('value') || '', f.getAttribute('placeholder') || '']);
  return norm([el.textContent || '', ...fields].join(' | '));
}

function frameOf(brand: Brand, s: CallState): Element {
  const list = frames(page(brand, s.ref.page), s.ref.frame);
  expect(s.ref.index, `${brand} ${s.id}: frame ${s.ref.frame} #${s.ref.index} of ${list.length}`).toBeLessThan(list.length);
  return list[s.ref.index];
}

const effectiveBootstrap = (brand: Brand, s: CallState): JsonObject =>
  s.live.boot ? mergeJson(baseBootstrap(brand), s.live.boot) : baseBootstrap(brand);
const byId = (brand: Brand, id: string): CallState => {
  const s = callStates(brand).find((x) => x.id === id);
  if (!s) throw new Error(`${brand}: no state ${id}`);
  return s;
};

describe('call screens fixture', () => {
  it('commits the handoff text and reference pages it reads (no PNG, no font file)', () => {
    for (const brand of BRANDS) {
      for (const f of ['01-call-buttons.html', '05-starting-a-call.html', '11-mobile.html', '12-design-system.html', 'css/cc.css']) {
        expect(existsSync(resolve(refDir(brand), f)), `${brand}/${f}`).toBe(true);
      }
    }
  });

  for (const brand of BRANDS) {
    describe(brand, () => {
      const states = callStates(brand);

      it('has one state per acceptance panel: 81, unique names, in board order', () => {
        expect(states).toHaveLength(81);
        expect(new Set(states.map((s) => s.panel)).size).toBe(81);
        expect(new Set(states.map((s) => s.id)).size).toBe(81);
        const boards = states.map((s) => s.panel.slice(0, 2));
        expect(boards).toEqual([...boards].sort());
        const count = (b: string) => boards.filter((x) => x === b).length;
        expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((b) => count(String(b).padStart(2, '0'))))
          .toEqual([9, 8, 13, 11, 9, 3, 3, 3, 3, 4, 4, 11]);
      });

      it('names a reference frame that exists for every state, and every frame of a board is covered', () => {
        const used = new Map<string, Set<number>>();
        for (const s of states) {
          frameOf(brand, s);
          const k = `${s.ref.page}|${s.ref.frame}`;
          if (!used.has(k)) used.set(k, new Set());
          used.get(k)!.add(s.ref.index);
        }
        for (const [k, idx] of used) {
          const [file, sel] = k.split('|');
          expect([...idx].sort((a, b) => a - b), k).toEqual(frames(page(brand, file), sel).map((_, i) => i));
        }
      }, PARSE_TIMEOUT);

      it('feeds only demo strings the board draws (text, field values, initials)', () => {
        for (const s of states) {
          const text = frameText(frameOf(brand, s));
          for (const str of [...s.drawn, ...(s.initials || [])]) {
            expect(text.includes(norm(str)), `${brand} ${s.id}: «${str}» not in ${s.ref.page} ${s.ref.frame}#${s.ref.index}`).toBe(true);
          }
        }
      }, PARSE_TIMEOUT);

      it('gives each kind what the harness needs', () => {
        for (const s of states) {
          if (s.kind === 'P') {
            expect(s.screen, s.id).toBeTruthy();
            expect(s.ref.frame, s.id).toBe('section.cp');
          }
          if (s.kind === 'C') {
            expect(s.root && s.anchor && s.ref.component, s.id).toBeTruthy();
            const comp = frameOf(brand, s).querySelector(s.ref.component!);
            expect(comp, `${s.id}: component ${s.ref.component}`).not.toBeNull();
            expect(comp!.classList.contains(s.root!), `${s.id}: the board's component is .${s.root}`).toBe(true);
            const anchorSel = s.anchor!;
            const anchorOk = comp!.matches(anchorSel) || !!comp!.querySelector(anchorSel);
            expect(anchorOk, `${s.id}: anchor ${anchorSel} inside the component`).toBe(true);
          }
          if (s.kind === 'M') {
            expect(s.live.mobile, s.id).toBe(true);
            expect((s.masks || []).map((m) => m.sel), s.id).toEqual(expect.arrayContaining(['.notch', '.homebar']));
          }
          if (s.kind === 'G') expect(s.geometry, s.id).toBeTruthy();
          for (const m of [...(s.masks || []), ...(s.liveMasks || [])]) expect(m.why.length, `${s.id} ${m.sel}`).toBeGreaterThan(10);
          if (PIXEL_KINDS.has(s.kind)) expect(s.due.round, s.id).toBeGreaterThanOrEqual(1);
        }
        expect(states.filter((s) => PIXEL_KINDS.has(s.kind)).length).toBe(46);
      }, PARSE_TIMEOUT);

      it('drives the real engine: no stand-ins, and every field a state sets is one the engine has', () => {
        const rt = readFileSync(resolve(ROOT, 'public/call-widget/runtime.js'), 'utf8');
        for (const name of ENGINE_METHODS) expect(rt, name).toContain(`CallCenterWidgetCtor.prototype.${name} = function`);
        for (const s of states) {
          expect('stubs' in s.live, s.id).toBe(false);
          for (const step of s.live.steps || []) {
            for (const field of Object.keys(step)) expect(rt, `${s.id}: ${field}`).toMatch(new RegExp(`this\\.${field}\\b`));
          }
        }
      });

      it('freezes the clock on Thursday 2026-10-22 11:00 in the visitor\'s zone', () => {
        const now = frozenNow(brand);
        expect(new Date(now).toISOString()).toBe(brand === 'webyar' ? '2026-10-22T07:30:00.000Z' : '2026-10-22T10:00:00.000Z');
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: BRAND_INFO[brand].timezoneId, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(new Date(now));
        expect(['weekday', 'hour', 'minute'].map((t) => parts.find((p) => p.type === t)?.value)).toEqual(['Thursday', '11', '00']);
        expect([QUEUE_THIRD_MS, QUEUE_NEXT_MS, CALL_MS, TRANSFER_MS, RECONNECT_MS, ENDED_DURATION_S * 1000].map((ms) => boardClock(brand, ms)))
          .toEqual(['0:47', '1:35', '2:14', '3:05', '2:48', '4:14'].map((t) => (brand === 'webyar' ? t.replace(/\d/g, (x) => '۰۱۲۳۴۵۶۷۸۹'[Number(x)]) : t)));
      });

      it('carries the contract\'s fixture facts (§8.1)', () => {
        // Two locales only where `.lang` is drawn (screen 01 and its radius variants).
        for (const s of states) {
          const locales = ((effectiveBootstrap(brand, s).i18n as JsonObject).available_locales as string[]);
          expect(locales.length, s.id).toBe(s.id.startsWith('05-01-home') ? 2 : 1);
        }
        const caps = (id: string) => effectiveBootstrap(brand, byId(brand, id)).capabilities as JsonObject;
        const presence = (id: string) => effectiveBootstrap(brand, byId(brand, id)).presence as JsonObject;
        const config = (id: string) => effectiveBootstrap(brand, byId(brand, id)).config as JsonObject;
        // 15 staffed (online header), 16 and 19 offline (callback desk header).
        expect([caps('09-15-error').voice, presence('09-15-error').any_available]).toEqual([true, true]);
        for (const id of ['10-16-offline', '10-19-scheduled']) expect([caps(id).voice, caps(id).video, caps(id).callback]).toEqual([false, false, true]);
        // 17: tomorrow 10:00 is a full slot on a future day; tomorrow 16:30 is open.
        const slots = callbackSlots(brand);
        const tomorrow10 = slots[5]; // day 2, 10:00
        expect(new Date(tomorrow10.at).getTime()).toBeGreaterThan(frozenNow(brand));
        expect(tomorrow10.available).toBe(false);
        expect(slots.find((x) => x.at === bookedSlot(brand))!.available).toBe(true);
        expect(slots).toHaveLength(SLOT_DAYS.length * 5);
        // Today's 10:00 is past, 12:30 open (the clock, not data).
        expect([slots[0].available, slots[1].available]).toEqual([false, true]);
        // L4: three named operators; L8: one named operator with a photo.
        const ops = (id: string) => (presence(id).operators as JsonObject[]) || [];
        expect(ops('01-L4-card').map((o) => !!o.name && !o.avatar_url)).toEqual([true, true, true]);
        expect(ops('01-L8-operator_face').map((o) => [o.name, !!o.avatar_url])).toEqual([[DEMO[brand].operatorName, true]]);
        // Sc: a business logo image; Sb: round_label + hover; Sd: the default style offline, show_callback.
        expect(typeof config('03-Sc-business-logo').avatar_url).toBe('string');
        const sb = byId(brand, '03-Sb-hover');
        expect([config('03-Sb-hover').launcher_style, sb.live.actions?.[0]?.do]).toEqual(['round_label', 'hover']);
        expect([config('03-Sd-offline').launcher_style, config('03-Sd-offline').offline_behavior, caps('03-Sd-offline').voice]).toEqual(['round_label', 'show_callback', false]);
        // 19: the reference code is the callback id's first 8 characters, upper-cased.
        expect(CALLBACK_ID.slice(0, 8).toUpperCase()).toBe(CALLBACK_CODE);
      });
    });
  }

  it('picks --on-a by contrast: white on every preset, Ink on the light accent', () => {
    for (const brand of BRANDS) for (const a of ACCENT_PRESETS[brand]) expect(onAccent(a), `${brand} ${a}`).toBe('#FFFFFF');
    expect(onAccent(LIGHT_ACCENT)).toBe(INK);
  });
});
