/**
 * Call Center → Settings → Presentation: the call button's style
 * (CallLauncherStylePicker, the 2026-10 call widget design B1; boards 01 L1–L9
 * of both brands).
 *
 *   - nine tiles in the order of shared/callLauncherStyles.ts, a radio group
 *     with the stored style checked (an unknown or missing one reads as
 *     round_label, as the widget wears it);
 *   - a tile writes its style;
 *   - the hints: card and operator_face publish the names and photos of the
 *     operators who are available, mobile_bar is for phones (larger screens
 *     show the round button with its label), edge_tab sits on an edge;
 *   - disabled (a backend or database without migration 277) with the note;
 *   - every name in Persian and Turkish too, no emoji.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { CallLauncherStylePicker } from '@/components/app/call-center/CallLauncherStylePicker';
import { CALL_LAUNCHER_STYLES } from '../../../shared/callLauncherStyles';

afterEach(cleanup);

const BUNDLES = { en, fa, tr } as const;

function mount(props: Partial<Parameters<typeof CallLauncherStylePicker>[0]> = {}, locale: keyof typeof BUNDLES = 'en') {
  const onChange = vi.fn();
  render(
    <I18nProvider initialLocale={locale} initialTranslations={BUNDLES[locale]}>
      <CallLauncherStylePicker value="round_label" onChange={onChange} international={false} {...props} />
    </I18nProvider>,
  );
  const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('[data-call-launcher-style]')];
  const tile = (id: string) => document.querySelector<HTMLButtonElement>(`[data-call-launcher-style="${id}"]`)!;
  return { onChange, tiles, tile };
}

describe('the call button styles', () => {
  it('nine tiles in the shared order, in one radio group, the stored style checked', () => {
    const m = mount({ value: 'card' });
    expect(m.tiles().map((b) => b.getAttribute('data-call-launcher-style'))).toEqual([...CALL_LAUNCHER_STYLES]);
    expect(screen.getByRole('radiogroup', { name: en.callCenter.settingsPage.launcherStyle })).toBeTruthy();
    expect(m.tiles().filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.getAttribute('data-call-launcher-style'))).toEqual(['card']);
  });

  it('an unknown or missing style reads as round_label (what the widget wears)', () => {
    for (const value of ['sparkle', null, undefined, '']) {
      const m = mount({ value });
      expect(m.tile('round_label').getAttribute('aria-checked')).toBe('true');
      cleanup();
    }
  });

  it('a tile writes its style', () => {
    const m = mount();
    fireEvent.click(m.tile('edge_tab'));
    expect(m.onChange).toHaveBeenCalledWith('edge_tab');
  });

  it('each tile has its name and line; every tile draws its art', () => {
    const m = mount();
    for (const id of CALL_LAUNCHER_STYLES) {
      const copy = en.callCenter.settingsPage.launcherStyles[id];
      expect(m.tile(id).textContent).toContain(copy.name);
      expect(m.tile(id).textContent).toContain(copy.sub);
      expect(m.tile(id).querySelector('[data-launcher-art]')).not.toBeNull();
    }
  });

  it('the hint of the chosen style: operators published, phones only, edge', () => {
    const s = en.callCenter.settingsPage;
    for (const [value, hint] of [
      ['card', s.launcherStyleHintPresence], ['operator_face', s.launcherStyleHintPresence],
      ['mobile_bar', s.launcherStyleHintMobileBar], ['edge_tab', s.launcherStyleHintEdge],
    ] as const) {
      mount({ value });
      expect(document.body.textContent).toContain(hint);
      cleanup();
    }
    mount({ value: 'pill' });
    for (const hint of [s.launcherStyleHintPresence, s.launcherStyleHintMobileBar, s.launcherStyleHintEdge]) {
      expect(document.body.textContent).not.toContain(hint);
    }
  });

  it('disabled: no tile can be chosen, and the note says why', () => {
    const m = mount({ disabled: true });
    for (const b of m.tiles()) expect(b.disabled).toBe(true);
    fireEvent.click(m.tile('pill'));
    expect(m.onChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(en.callCenter.settingsPage.designSettingsPending);
  });

  it('the art follows the colour it is given (the workspace primary, else the edition default)', () => {
    const m = mount({ accent: '#2563EB' });
    expect(m.tile('round').querySelector<HTMLElement>('[data-launcher-art] [data-accent]')!.style.background).toBe('rgb(37, 99, 235)');
    cleanup();
    const iran = mount({ accent: null });
    expect(iran.tile('round').querySelector<HTMLElement>('[data-launcher-art] [data-accent]')!.style.background).toBe('rgb(11, 125, 108)');
    cleanup();
    const intl = mount({ accent: '', international: true });
    expect(intl.tile('round').querySelector<HTMLElement>('[data-launcher-art] [data-accent]')!.style.background).toBe('rgb(22, 20, 43)');
  });

  it.each(['fa', 'tr'] as const)('%s: every name, line and hint is translated, without emoji', (locale) => {
    mount({}, locale);
    const s = BUNDLES[locale].callCenter.settingsPage;
    for (const id of CALL_LAUNCHER_STYLES) {
      expect(s.launcherStyles[id].name).not.toBe(en.callCenter.settingsPage.launcherStyles[id].name);
      expect(document.body.textContent).toContain(s.launcherStyles[id].name);
    }
    const texts = [s.launcherStyle, s.launcherStyleHintPresence, s.launcherStyleHintMobileBar, s.launcherStyleHintEdge, s.designSettingsPending,
      ...CALL_LAUNCHER_STYLES.flatMap((id) => [s.launcherStyles[id].name, s.launcherStyles[id].sub])];
    for (const text of texts) expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });
});
