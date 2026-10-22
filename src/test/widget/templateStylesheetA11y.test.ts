/**
 * What every chat template's stylesheet must hold for visitors' phones and
 * eyes (read from the shipped files, every template in shared/widgetTemplates.ts):
 *
 *   V-23  on a phone or a touch screen every field the visitor types in is
 *         16px (iOS Safari zooms the whole page into a smaller one on focus);
 *   V-22  `default`'s and `intl`'s small print reaches 4.5:1 on white, and
 *         their accent surfaces wear Core's readable accent and its ink;
 *   V-41  `default`'s recorder and voice note keep the chat view's 50px pill;
 *   V-13  the department picker is styled in every template's stylesheet.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';

const css = (file: string) => readFileSync(resolve(process.cwd(), 'public/widget', file), 'utf8');
const sheets = Array.from(new Set(Object.values(CHAT_WIDGET_TEMPLATES).map((t) => t.style)));

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const onWhite = (hex: string) => 1.05 / (lum(hex) + 0.05);

describe('every chat template stylesheet', () => {
  for (const sheet of sheets) {
    it(`${sheet}: fields are 16px on phones and touch screens (V-23)`, () => {
      const block = /@media \(max-width: 640px\), \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css(sheet));
      expect(block, 'the phone/touch media block').not.toBeNull();
      expect(block![1]).toMatch(/\.panel input:not\(\[type='checkbox'\]\)[^{]*\.panel textarea,\s*\.panel select \{ font-size: 16px !important; \}/);
    });

    it(`${sheet}: styles the department picker (V-13)`, () => {
      const s = css(sheet);
      for (const sel of ['.dept-picker', '.dept-picker__list', '.dept-option', '.dept-option__status', '.dept-option.is-offline']) {
        expect(s, sel).toContain(sel);
      }
    });
  }
});

describe('default and intl: contrast (V-22)', () => {
  for (const [file, label] of [['presentation-default.css', 'default'], ['presentation-intl.css', 'intl skin']] as const) {
    it(`${label}: the small print reaches 4.5:1 on white`, () => {
      const faint = /--wy-faint:\s*(#[0-9a-f]{6})/i.exec(css(file))![1];
      expect(onWhite(faint)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${label}: the accent is Core's readable one, when there`, () => {
      expect(css(file)).toMatch(/--wy-accent:\s*var\(--gs-primary-aa, var\(--gs-primary,/);
    });
  }

  it('default: the visitor\'s bubble and the primary buttons take the accent\'s ink, not a fixed white', () => {
    const s = css('presentation-default.css');
    expect(s).toMatch(/\.msg\.visitor \{ background: var\(--wy-accent\); color: var\(--wy-on-accent\); \}/);
    expect(s).toMatch(/\.wy-btn-primary \{ background: var\(--wy-accent\); color: var\(--wy-on-accent\);/);
    expect(s).toMatch(/--wy-on-accent: var\(--gs-on-primary, #fff\)/);
  });
});

describe('default: the voice row keeps the pill\'s height (V-41)', () => {
  it('the chat view\'s recorder and voice note are 50px, as its textarea', () => {
    const s = css('presentation-default.css');
    expect(s).toMatch(/\.wy-view-chat \.input \{\s*min-height: 50px;\s*height: 50px;/);
    expect(s).toMatch(/\.wy-view-chat \.rec-bar,\s*\.wy-view-chat \.vn-bar \{ height: 50px; \}/);
  });
});
