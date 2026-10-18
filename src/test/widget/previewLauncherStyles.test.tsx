/**
 * The dashboard's live preview draws the launcher's styles (issue #340,
 * g5-1: the pill, the classic bubble, two bubbles, the agent's face) the way
 * the loader does on a site: the same classes and texts on the same markup
 * (`fx fx-<icon> fx-<shape>`, the pill's text in `data-fx`, the agent's
 * letter in `data-fi`, `dir`), the look from runtime-fab.css (asked for in
 * the frame through the manifest, as every widget file there), the launcher
 * and its card unseen until it is in. A launcher without a style is drawn as
 * before; an icon named after an Object.prototype key is the chat glyph; the
 * kit's square has its 18px corners.
 *
 * RESPOK's button follows the build as the loader does (`@intl-kit`): an
 * Iran-brand build previews the plain launcher in the International edition,
 * while the footer's lockup still follows the logo direction (the server's).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WidgetLivePreview } from '@/components/app/widget/WidgetLivePreview';

const flags = vi.hoisted(() => ({ edition: 'iran' as 'iran' | 'international', intlKit: true }));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: flags.edition, isInternational: flags.edition === 'international', ready: true }),
  useKnownEdition: () => flags.edition,
}));
vi.mock('../../../shared/buildBrand', () => ({
  BUILD_BRAND: 'both',
  SHIPS_IRAN_KIT: true,
  get SHIPS_INTL_KIT() { return flags.intlKit; },
}));

afterEach(() => {
  cleanup();
  flags.edition = 'iran';
  flags.intlKit = true;
});

const TEAM = [
  { name: 'Reza', avatar: null, online: false },
  { name: 'سارا', avatar: null, online: true },
];
const POWERED = { text: 'Powered by', brand: 'Respok', url: 'https://respok.app' };

function frame(settings: Record<string, unknown>, opts: { view?: 'home' | 'offline'; templateId?: string; templateOptions?: Record<string, unknown> } = {}) {
  const { container } = render(
    <WidgetLivePreview
      settings={{ widget_language: 'fa', ...settings }} brandName="نیلوفر" view={opts.view || 'home'} teamMembers={TEAM}
      poweredBy={POWERED} templateId={opts.templateId ?? 'default'} templateOptions={opts.templateOptions ?? {}}
    />,
  );
  const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
  const page = new DOMParser().parseFromString(doc, 'text/html');
  const payload = JSON.parse(/var GS_PREVIEW = (\{.*\});\n/.exec(doc)![1]) as { fabStyled: boolean; config: { poweredBy?: { logo?: string } } };
  return {
    doc,
    payload,
    shell: page.querySelector('.shell')!,
    launcher: page.getElementById('gs-launcher')!,
    card: page.querySelector('.fab-label'),
  };
}

/** What the loader adds for a style (public/widget/loader.js applyFabConfig). */
const FX_ATTRS = ['data-fx', 'data-fi', 'dir'];

describe('a launcher without a style is drawn as before', () => {
  it.each([{}, { fab_shape: 'square' }, { fab_icon: 'headset' }, { fab_icon: 'smile', fab_label: 'سلام' }, { fab_shape: 'pill', fab_label: '' }])('%j', (row) => {
    const { launcher, card, payload, doc } = frame(row);
    expect(payload.fabStyled).toBe(false);
    expect(launcher.className).not.toMatch(/\bfx/);
    for (const a of FX_ATTRS) expect(launcher.hasAttribute(a), a).toBe(false);
    expect(launcher.getAttribute('style')).toBeNull();
    expect(card ? card.getAttribute('style') : null).toBeNull();
    // The frame asks for no launcher stylesheet (the call is there, gated off).
    expect(doc).toContain('"fabStyled":false');
  });

  it('an icon named after an Object.prototype key is the chat glyph, never prototype text', () => {
    for (const icon of ['constructor', '__proto__', 'toString']) {
      const { launcher } = frame({ fab_icon: icon });
      expect(launcher.innerHTML, icon).not.toMatch(/function|\[native code\]/);
      expect(launcher.querySelector('svg.chat-icon.lk-kit-glyph'), icon).not.toBeNull();
    }
    flags.edition = 'international';
    const { launcher } = frame({ fab_icon: 'constructor', widget_language: 'en' }, { templateId: 'intl' });
    expect(launcher.innerHTML).not.toMatch(/function/);
    expect(launcher.querySelector('svg.chat-icon.rpk-kit-glyph')).not.toBeNull();
  });

  it('the kit\'s square has the brand\'s 18px corners; any other square keeps 16px', () => {
    expect(frame({ fab_shape: 'square' }).doc).toContain('border-radius:18px;border:none;');
    flags.edition = 'international';
    expect(frame({ fab_shape: 'square' }, { templateId: 'intl' }).doc).toContain('border-radius:16px;border:none;');
    expect(frame({}, { templateId: 'intl' }).doc).toContain('border-radius:50%;border:none;');
  });
});

describe('a launcher wearing a style', () => {
  it('the pill: the loader\'s classes and text on the kit\'s markup, no card beside it, unseen until its stylesheet is in', () => {
    const { launcher, card, payload } = frame({ fab_shape: 'pill', fab_label: 'سؤالی دارید؟ بپرسید' });
    expect(payload.fabStyled).toBe(true);
    expect(launcher.className.split(' ')).toEqual(expect.arrayContaining(['launcher', 'lk-kit', 'fx', 'fx-chat', 'fx-pill']));
    expect(launcher.getAttribute('data-fx')).toBe('سؤالی دارید؟ بپرسید');
    expect(launcher.getAttribute('data-fi')).toBe('');
    expect(launcher.getAttribute('dir')).toBe('rtl');
    expect(launcher.style.visibility).toBe('hidden');
    expect(launcher.querySelector('svg.chat-icon.lk-kit-glyph')).not.toBeNull();
    expect(card).toBeNull();
  });

  it('the agent\'s face: the first online operator\'s letter; the dot goes while the team is away; the card waits too', () => {
    const { launcher, card } = frame({ fab_icon: 'avatar', fab_label: 'گفتگو با ما' });
    expect(launcher.className).toContain('fx fx-avatar fx-circle');
    expect(launcher.className).not.toContain('fx-off');
    expect(launcher.getAttribute('data-fi')).toBe('س');
    expect(card!.getAttribute('style')).toBe('visibility:hidden');
    expect(frame({ fab_icon: 'avatar' }, { view: 'offline' }).launcher.className).toContain('fx-off');
  });

  it('the agent\'s face without a team: the workspace\'s letter', () => {
    const { container } = render(
      <WidgetLivePreview settings={{ widget_language: 'en', fab_icon: 'avatar', brand_name: 'Acme' }} view="home" teamMembers={[]} templateId="default" templateOptions={{}} />,
    );
    const doc = container.querySelector('iframe')!.getAttribute('srcdoc') || '';
    expect(new DOMParser().parseFromString(doc, 'text/html').getElementById('gs-launcher')!.getAttribute('data-fi')).toBe('A');
  });

  it.each(['bubble', 'duo'])('%s: its classes, LTR in English', (icon) => {
    const { launcher } = frame({ fab_icon: icon, widget_language: 'en' });
    expect(launcher.className).toContain(`fx fx-${icon} fx-circle`);
    expect(launcher.getAttribute('dir')).toBe('ltr');
  });

  it('the frame asks for the manifest\'s runtime-fab.css, after the manifest, with a 3 s reveal', () => {
    const { doc } = frame({ fab_icon: 'bubble' });
    expect(doc).toContain("fx.href = '/widget/' + ((manifest && manifest['runtime-fab.css']) || 'runtime-fab.css');");
    expect(doc).toContain('fx.onload = fx.onerror = gsFabShow;');
    expect(doc).toContain('if (GS_PREVIEW.fabStyled) setTimeout(gsFabShow, 3000);');
    expect(doc).toContain('.then(function (manifest) { gsFabStyle(manifest); boot(manifest); });');
  });

  it('runs the frame\'s script: the stylesheet joins the head once, and the launcher and its card show when it is in', async () => {
    const { doc } = frame({ fab_icon: 'avatar', fab_label: 'گفتگو' });
    const page = document.implementation.createHTMLDocument('frame');
    page.documentElement.innerHTML = doc.replace(/^<!doctype html>/i, '');
    const script = [...page.querySelectorAll('script')].map((s) => s.textContent || '').find((t) => t.includes('function gsFabStyle'))!;
    const gsFabStyle = new Function('document', 'GS_PREVIEW', 'setTimeout', `${script.slice(script.indexOf('  function gsFabShow'), script.indexOf('  (function () {'))}; return gsFabStyle;`)(
      page, { fabStyled: true }, () => 0,
    ) as (m: Record<string, string> | null) => void;
    gsFabStyle({ 'runtime-fab.css': 'runtime-fab.0123abcd.css' });
    gsFabStyle({ 'runtime-fab.css': 'runtime-fab.0123abcd.css' });
    const links = page.querySelectorAll('link[data-gs-fab]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/widget/runtime-fab.0123abcd.css');
    expect(page.getElementById('gs-launcher')!.style.visibility).toBe('hidden');
    (links[0] as HTMLLinkElement).onload!(new Event('load'));
    expect(page.getElementById('gs-launcher')!.style.visibility).toBe('');
    expect((page.querySelector('.fab-label') as HTMLElement).style.visibility).toBe('');
  });

  it('a plan without widget_launcher_icon previews the chat circle (the page resets the columns, as /config)', () => {
    const { launcher, payload } = frame({ fab_shape: 'circle', fab_icon: 'chat' });
    expect(payload.fabStyled).toBe(false);
    expect(launcher.className).not.toMatch(/\bfx/);
  });
});

describe('RESPOK\'s button follows the build, as the loader does', () => {
  it('the RESPOK (or `both`) build: the kit, its shell class and glyph; a style on it keeps the kit\'s markup', () => {
    flags.edition = 'international';
    const { launcher, shell } = frame({ fab_icon: 'bubble', widget_language: 'en' }, { templateId: 't1-intl', templateOptions: { logoDirection: 'open' } });
    expect(shell.classList.contains('lg-open')).toBe(true);
    expect(launcher.className).toContain('rpk-kit');
    expect(launcher.className).toContain('fx fx-bubble fx-circle');
    expect(launcher.querySelector('svg.rpk-kit-o')).not.toBeNull();
  });

  it('the Iran build: the plain launcher and no lg-* class in the International edition; the credit still follows the direction', () => {
    flags.edition = 'international';
    flags.intlKit = false;
    const { launcher, shell, payload, doc } = frame({ widget_language: 'en' }, { templateId: 't1-intl', templateOptions: { logoDirection: 'open' } });
    expect(shell.className).not.toMatch(/lg-/);
    expect(launcher.className).not.toContain('rpk-kit');
    expect(launcher.querySelector('svg.chat-icon')!.classList.contains('rpk-kit-glyph')).toBe(false);
    expect(doc).not.toContain('.launcher.rpk-kit');
    expect(payload.config.poweredBy!.logo).toMatch(/\/brand\/intl\/respok-open-horizontal-color\.svg$/);
  });

  it('the source gates RESPOK\'s button on the build constant', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/app/widget/WidgetLivePreview.tsx'), 'utf8');
    expect(src).toContain('const respokKit = SHIPS_INTL_KIT && isInternational;');
  });
});
