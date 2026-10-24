/**
 * The owner's rule (2026-10-24) in the call widget: an operator without a
 * photo is the person silhouette (`.pp`, drawn by runtime.css) and the
 * business without a logo its storefront (`.lg.ws`, the panel's
 * stylesheet), never a letter. Before an operator's name is known the face
 * is still the headset (D34); the visitor's own contact card keeps its
 * initial (people on the visitor's side are not this rule's).
 *
 * The guard: the launchers that draw operators (card, operator_face) and
 * every panel screen with a face (the header, joining, voice, transfer,
 * reconnect, rating, thanks, the minimised call), in both brands' builds,
 * draw no letter in any avatar.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { avatarFace } from '../widget/avatarFace';
import { closeCallWidgets, mountCallWidget, type Brand, type Mounted } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const NOW = Date.parse('2026-10-22T11:00:00+03:30');
const TEAM = [
  { name: 'Sara Ahmadi', initial: 'S', avatar_url: null },
  { name: 'مهدی کریمی', initial: 'م', avatar_url: null },
  { name: 'Reza', initial: 'R', avatar_url: null },
];
/** Every face of the call widget, but the visitor's own card. */
const FACES = '.av:not(.known .av), .lg, .orb .core';
const facesIn = (root: ParentNode, where: string) =>
  Array.from(root.querySelectorAll(FACES)).map((el) => ({ where, cls: el.getAttribute('class'), face: avatarFace(el) }));

function staged(brand: Brand, locale: 'fa' | 'en'): Mounted {
  const m = mountCallWidget({ now: NOW, locale, shipped: brand, bootstrap: { config: { avatar_url: null, display_name: 'Nilufar Store' } } });
  m.open();
  return m;
}
const live = (m: Mounted, extra: Record<string, unknown> = {}) => m.set({
  state: 'in_call', callId: 'c1', connectStatus: 'in_call', operatorName: 'Sara Ahmadi', callStartedAt: NOW - 134_000,
  micOn: true, camOn: false, call: { id: 'c1', call_type: 'audio', state: 'active', recording_state: null }, ...extra,
});

describe('the guard: no letter for an operator or the business in the call widget', () => {
  for (const brand of ['iran', 'respok'] as const) {
    it(`${brand} build: the launchers that draw operators`, () => {
      for (const style of ['card', 'operator_face']) {
        const m = mountCallWidget({ now: NOW, locale: 'en', shipped: brand, bootstrap: { config: { launcher_style: style }, presence: { any_available: true, operators: TEAM } } });
        const seen = facesIn(m.q('.ccw-launcher-wrap')!, style);
        expect(seen.length, style).toBeGreaterThan(0);
        expect(seen.filter((x) => x.face !== 'person'), JSON.stringify(seen)).toEqual([]);
        closeCallWidgets();
      }
    });

    it(`${brand} build: every panel screen with a face, the minimised call included`, () => {
      const seen: Array<{ where: string; cls: string | null; face: string | null }> = [];
      const m = staged(brand, 'fa');
      seen.push(...facesIn(m.screen()!, 'home'));
      live(m, { connectStatus: 'waiting_for_operator', callStartedAt: null });
      seen.push(...facesIn(m.screen()!, m.screenId()!));
      live(m);
      seen.push(...facesIn(m.screen()!, m.screenId()!));
      m.set({ transferring: true, operatorName: null });
      seen.push(...facesIn(m.screen()!, m.screenId()!));
      m.set({ transferring: false, operatorName: 'Reza', connectStatus: 'reconnecting_media' });
      seen.push(...facesIn(m.screen()!, m.screenId()!));
      live(m);
      m.click('[data-screen="voice"] .dock [data-action="minimize"]');
      seen.push(...facesIn(m.q('.ccw-launcher-wrap')!, 'minimised'));
      const e = staged(brand, 'en');
      e.set({ state: 'ended', endedCallId: 'c1', endedDuration: 64, operatorName: 'Sara Ahmadi' });
      seen.push(...facesIn(e.screen()!, e.screenId()!));
      e.set({ ratingSubmitted: true, ratingValue: 5 });
      seen.push(...facesIn(e.screen()!, e.screenId()!));

      const wheres = new Set(seen.map((x) => x.where));
      for (const w of ['home', 'joining', 'voice', 'transfer', 'minimised', 'rating', 'thanks']) expect(wheres.has(w), w).toBe(true);
      // The header: the business's storefront; every operator: the silhouette.
      expect(seen.filter((x) => /\blg\b/.test(String(x.cls))).every((x) => x.face === 'workspace')).toBe(true);
      const letters = seen.filter((x) => !['person', 'workspace', 'photo'].includes(String(x.face)));
      expect(letters, JSON.stringify(letters)).toEqual([]);
      expect(seen.some((x) => x.face === 'person')).toBe(true);
    });
  }

  it('a logo stays the business\'s; no name yet keeps the headset (D34), never a silhouette under it', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', bootstrap: { config: { avatar_url: 'https://cdn.example/logo.png', display_name: 'Nilufar' } } });
    m.open();
    expect(avatarFace(m.screen()!.querySelector('.lg'))).toBe('photo');
    expect(m.screen()!.querySelector('.lg.ws')).toBeNull();
    live(m, { operatorName: null });
    expect(avatarFace(m.screen()!.querySelector('.orb .core'))).toBe('icon');
    expect(m.screen()!.querySelector('.orb .core.pp')).toBeNull();
  });
});
