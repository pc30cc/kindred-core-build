/**
 * Widget → Appearance → the chat button's style (LauncherStylePicker, issue
 * #340 g5-1; WebYar board 11, RESPOK board 10).
 *
 *   - the tiles of each edition: WebYar's kit and its 18px square, RESPOK's
 *     Open and Thread when the worn template reads the logo direction (else
 *     its one kit tile), then the bubble, two bubbles, the headset, the
 *     agent's face and the pill (two columns wide);
 *   - which tile is checked for what the row holds, and what each writes
 *     (the pill keeps the icon and gets the default text when it has none);
 *   - the plan gates: widget_launcher_icon (every tile, the upgrade hint),
 *     widget_launcher_label (the pill), widget_appearance (the logo
 *     direction);
 *   - the page: the tiles sit in «7», the icon grid keeps only the other
 *     icons, the label's hint speaks of the pill, fab_shape follows the plan
 *     like fab_icon.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { LauncherStylePicker, type LauncherStylePickerProps } from '@/components/app/widget/LauncherStylePicker';
import { launcherChoiceOf, launcherTileOf } from '../../../shared/launcherStyles';
import { RESPOK_LAUNCHER_OPEN_GLYPH } from '../../../shared/respokLauncher';

// The build's kits (shared/buildBrand.ts), `both` unless a test says otherwise.
const build = vi.hoisted(() => ({ intlKit: true }));
vi.mock('../../../shared/buildBrand', () => ({
  BUILD_BRAND: 'both',
  SHIPS_IRAN_KIT: true,
  get SHIPS_INTL_KIT() { return build.intlKit; },
}));

afterEach(() => {
  cleanup();
  build.intlKit = true;
});

function mount(over: Partial<LauncherStylePickerProps> = {}) {
  const onChoose = vi.fn();
  render(
    <I18nProvider initialLocale="en" initialTranslations={en}>
      <LauncherStylePicker
        shape="circle" icon="chat" label="" primaryColor="#3B82F6" initial="S" international={false}
        logoDirection={null} allowed labelAllowed logoAllowed onChoose={onChoose} {...over}
      />
    </I18nProvider>,
  );
  const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('[data-launcher-style]')];
  const tile = (id: string) => document.querySelector<HTMLButtonElement>(`[data-launcher-style="${id}"]`)!;
  return { onChoose, tiles, tile, ids: () => tiles().map((b) => b.getAttribute('data-launcher-style')) };
}

describe('the tiles of each edition', () => {
  it('WebYar (Iranian edition): the kit and its square first, the pill two columns wide', () => {
    const m = mount();
    expect(m.ids()).toEqual(['kit', 'square', 'bubble', 'duo', 'headset', 'avatar', 'pill']);
    expect(m.tile('pill').className).toContain('col-span-2');
    expect(m.tile('kit').querySelector('svg.lk-kit-glyph')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Chat button' })).toBeTruthy();
    expect(m.tile('pill').textContent).toContain('Questions? Ask us');
  });

  it('RESPOK with a template that reads the logo direction: its Open and Thread, no square', () => {
    const m = mount({ international: true, logoDirection: 'open' });
    expect(m.ids()).toEqual(['open', 'thread', 'bubble', 'duo', 'headset', 'avatar', 'pill']);
    expect(m.tile('open').querySelector('svg.rpk-kit-o')!.outerHTML).toContain('viewBox="0 0 108 108"');
    expect(RESPOK_LAUNCHER_OPEN_GLYPH).toContain('rpk-kit-o');
    expect(m.tile('open').getAttribute('aria-checked')).toBe('true');
  });

  it('RESPOK with intl (no logo direction): one kit tile', () => {
    expect(mount({ international: true }).ids()).toEqual(['kit', 'bubble', 'duo', 'headset', 'avatar', 'pill']);
  });

  it('the Iran build in the International edition: no RESPOK button (its loader has none), so one plain kit tile, checked', () => {
    build.intlKit = false;
    const m = mount({ international: true, logoDirection: 'open' });
    expect(m.ids()).toEqual(['kit', 'bubble', 'duo', 'headset', 'avatar', 'pill']);
    expect(m.tile('kit').querySelector('.rpk-kit-glyph, .lk-kit-glyph')).toBeNull();
    expect(m.tile('kit').getAttribute('aria-checked')).toBe('true');
  });

  it('the agent\'s face shows the letter the visitor will see; the tiles wear the workspace colour', () => {
    const m = mount({ initial: 'س', primaryColor: '#E11D48' });
    expect(m.tile('avatar').textContent).toContain('س');
    const art = m.tile('bubble').querySelector('span[aria-hidden]') as HTMLElement;
    expect(art.style.background).toBe('rgb(225, 29, 72)');
    // A custom colour: the bubble's dots are holes (no kit dots).
    expect(m.tile('bubble').querySelector('[data-kit-dots]')).toBeNull();
  });

  it('the classic bubble\'s dots in the kit\'s second colour on the kit\'s own ground (boards 10 and 11)', () => {
    const rp = mount({ international: true });
    expect(rp.tile('bubble').querySelector('[data-kit-dots]')!.getAttribute('fill')).toBe('#FF5A3C');
    cleanup();
    const wy = mount();
    expect(wy.tile('bubble').querySelector('[data-kit-dots]')!.getAttribute('fill')).toBe('#18AD94');
  });
});

describe('which tile, and what it writes', () => {
  it.each([
    [['circle', 'chat', null], 'kit'],
    [[null, null, null], 'kit'],
    [['square', 'chat', null], 'square'],
    [['square', 'bubble', null], 'bubble'],
    [['pill', 'avatar', null], 'pill'],
    [['circle', 'headset', null], 'headset'],
    [['circle', 'smile', null], null],
    [['circle', 'chat', 'open'], 'open'],
    [['circle', 'chat', 'thread'], 'thread'],
  ] as const)('%j → %s', ([shape, icon, logo], tile) => {
    expect(launcherTileOf(shape, icon, logo)).toBe(tile);
  });

  it('writes the shape and icon; the pill keeps the icon and gets the default text only without one', () => {
    expect(launcherChoiceOf('kit', '', 'Q')).toEqual({ shape: 'circle', icon: 'chat' });
    expect(launcherChoiceOf('square', '', 'Q')).toEqual({ shape: 'square', icon: 'chat' });
    expect(launcherChoiceOf('avatar', '', 'Q')).toEqual({ shape: 'circle', icon: 'avatar' });
    expect(launcherChoiceOf('open', '', 'Q')).toEqual({ shape: 'circle', icon: 'chat', logoDirection: 'open' });
    expect(launcherChoiceOf('pill', '  ', 'Q')).toEqual({ shape: 'pill', label: 'Q' });
    expect(launcherChoiceOf('pill', 'Hi', 'Q')).toEqual({ shape: 'pill' });
  });

  it('a click chooses; the checked tile carries the check', () => {
    const m = mount({ shape: 'square', icon: 'chat' });
    expect(m.tile('square').getAttribute('aria-checked')).toBe('true');
    expect(m.tile('square').querySelector('svg.lucide-check')).not.toBeNull();
    fireEvent.click(m.tile('pill'));
    expect(m.onChoose).toHaveBeenLastCalledWith({ shape: 'pill', label: 'Questions? Ask us' });
    fireEvent.click(m.tile('duo'));
    expect(m.onChoose).toHaveBeenLastCalledWith({ shape: 'circle', icon: 'duo' });
  });
});

describe('the plan', () => {
  it('without widget_launcher_icon: every tile disabled, the upgrade hint', () => {
    const m = mount({ allowed: false });
    expect(m.tiles().every((b) => b.disabled)).toBe(true);
    fireEvent.click(m.tile('bubble'));
    expect(m.onChoose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(en.plan.locked.upgradeHint);
  });

  it('without the launcher text: no pill; without the Appearance editor: no logo direction', () => {
    const m = mount({ labelAllowed: false, international: true, logoDirection: 'thread', logoAllowed: false });
    expect(m.tile('pill').disabled).toBe(true);
    expect(m.tile('open').disabled).toBe(true);
    expect(m.tile('bubble').disabled).toBe(false);
  });
});

describe('the strings', () => {
  const keys = [
    'launcherStyle', 'launcherStyleKit', 'launcherStyleKitSub', 'launcherStyleOpen', 'launcherStyleOpenSub', 'launcherStyleThread',
    'launcherStyleThreadSub', 'launcherStyleSquare', 'launcherStyleSquareSub', 'launcherStyleBubble', 'launcherStyleBubbleSub',
    'launcherStyleDuo', 'launcherStyleDuoSub', 'launcherStyleHeadset', 'launcherStyleHeadsetSub', 'launcherStyleAvatar',
    'launcherStyleAvatarSub', 'launcherStylePill', 'launcherStylePillSub', 'launcherStylePillLocked', 'launcherPillDefault',
    'launcherPillHint', 'launcherOtherIcons',
  ] as const;
  it.each([['en', en], ['fa', fa], ['tr', tr]] as const)('%s has every one; a brand is named only through {{brand}}', (_l, dict) => {
    const a = dict.widgetPage.appearance as Record<string, string>;
    for (const k of keys) expect(a[k], k).toBeTruthy();
    for (const k of ['launcherStyleKit', 'launcherStyleOpen', 'launcherStyleThread', 'launcherStyleSquare']) expect(a[k], k).toContain('{{brand}}');
    expect(JSON.stringify(keys.map((k) => a[k]))).not.toMatch(/web ?yar|وب ?یار|respok/i);
  });
});

describe('the page', () => {
  const PAGE = readFileSync(resolve(process.cwd(), 'src/pages/app/WidgetPage.tsx'), 'utf8');
  it('puts the tiles in «7», keeps only the other icons in the grid, and gates fab_shape like fab_icon', () => {
    expect(PAGE).toContain('<LauncherStylePicker');
    expect(PAGE).toContain("Object.keys(FAB_ICONS).filter((key) => key !== 'chat' && key !== 'headset')");
    expect(PAGE).toContain("fab_shape: { capability: 'widget_launcher_icon', reset: 'circle' },");
    expect(PAGE).toContain("'widgetPage.appearance.launcherPillHint'");
    const ents = readFileSync(resolve(process.cwd(), 'server/services/widget/entitlements.ts'), 'utf8');
    expect(ents).toContain("fab_shape: { capability: 'widget_launcher_icon', reset: 'circle' },");
  });
});
