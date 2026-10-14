/**
 * The text card beside the launcher is white. Its title used the launcher's
 * text colour as is, and the default (white, for the icon on the button)
 * left an empty white box beside the widget. The loader (and the operator
 * preview) now apply that colour only when it reads on white.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const loader = readFileSync(join(process.cwd(), 'public', 'widget', 'loader.js'), 'utf8');

function loaderReadsOnWhite(): (hex: string) => boolean {
  const m = /function readsOnWhite\(hex\) \{[\s\S]*?\n {2}\}\n/.exec(loader);
  if (!m) throw new Error('readsOnWhite not found in loader.js');
  return new Function(`${m[0]}; return readsOnWhite;`)() as (hex: string) => boolean;
}

describe('launcher label text colour', () => {
  const readsOnWhite = loaderReadsOnWhite();

  it('drops white and other light colours (the empty white box)', () => {
    for (const c of ['#ffffff', '#fff', '#FFF', '#f5f5f5', '#ffe08a', 'ffffff']) expect(readsOnWhite(c), c).toBe(false);
  });

  it('keeps colours that read on white', () => {
    for (const c of ['#1c2024', '#000', '#0B7D6C', '#EF4444', '#2563eb']) expect(readsOnWhite(c), c).toBe(true);
  });

  it('ignores what is not a hex colour', () => {
    for (const c of ['', 'red', 'rgb(0,0,0)', '#12345']) expect(readsOnWhite(c), c).toBe(false);
  });

  it('is what the label title uses, in the loader and in the operator preview', () => {
    expect(loader).toContain('if (fab.textColor && readsOnWhite(fab.textColor)) titleEl.style.color = fab.textColor;');
    const preview = readFileSync(join(process.cwd(), 'src', 'components', 'app', 'widget', 'WidgetLivePreview.tsx'), 'utf8');
    expect(preview).toContain("s.fab_text_color && readsOnWhite(s.fab_text_color) ? s.fab_text_color : '#1c2024'");
  });
});
