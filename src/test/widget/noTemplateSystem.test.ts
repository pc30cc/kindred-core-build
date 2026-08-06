import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Canonical single-design guard.
 *
 * The chat widget ships exactly one visual implementation. No runtime branch
 * may depend on a template/skin selector ever again.
 */
const WIDGET_FILES = [
  'public/widget/loader.js',
  'public/widget/runtime.js',
  'public/widget/runtime.css',
  'src/components/app/widget/WidgetLivePreview.tsx',
];

const FORBIDDEN = ['templateSlug', 'template_slug', 'template2', 'isT2', 'data-template'];

describe('chat widget — single canonical design', () => {
  for (const file of WIDGET_FILES) {
    it(`${file} contains no template-selection tokens`, () => {
      const src = readFileSync(file, 'utf8');
      for (const token of FORBIDDEN) {
        expect(src.includes(token), `${file} still references ${token}`).toBe(false);
      }
    });
  }

  it('server widget config does not expose a template selector', () => {
    const src = readFileSync('server/routes/widget.ts', 'utf8');
    // NOTE: `templateSlug: 'offline_message_received'` in this file belongs to
    // the transactional EMAIL template system and is unrelated to widget UI.
    expect(src.includes('getActiveTemplateSlug')).toBe(false);
    expect(/templateSlug:\s*await/.test(src)).toBe(false);
  });
});
