import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A pending file or image previews inside the composer pill.
 *
 * It used to be a chip in a strip ABOVE the composer, which pushed the whole
 * composer down the moment a file was picked and read like an upload manager
 * rather than a message being written. It is now a row of the pill itself —
 * but, unlike a voice note, it does NOT take the pill over: an attachment
 * usually wants a caption, so the textarea stays right below it and the
 * ordinary send button sends both together.
 */
const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
const RENDERER = readFileSync('public/widget/presentation-web-yar.js', 'utf8');
const CSS = readFileSync('public/widget/presentation-web-yar.css', 'utf8');

/** The composer pill's markup. */
function pillSource(): string {
  const start = RENDERER.indexOf('\'<div class="input-wrap" data-input-wrap>\'');
  expect(start, 'the composer pill must exist').toBeGreaterThan(-1);
  return RENDERER.slice(start, RENDERER.indexOf('footerHtml()', start));
}

describe('the preview is a row of the pill, not a strip above it', () => {
  it('lives inside the pill, ahead of the row the visitor writes on', () => {
    const pill = pillSource();
    const preview = pill.indexOf('data-attach-preview');
    const row = pill.indexOf('data-input-row');
    expect(preview).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(row);
  });

  it('has no strip above the composer left to render into', () => {
    // The old tray and chip are gone from markup, styles and core alike.
    for (const dead of ['data-attach-tray', 'attach-tray', 'attach-chip']) {
      expect(RENDERER, dead).not.toContain(dead);
      expect(CSS, dead).not.toContain(dead);
      expect(RUNTIME, dead).not.toContain(dead);
    }
  });

  it('leaves the textarea usable, because an attachment wants a caption', () => {
    // The takeover classes belong to recording and to a finished voice note.
    // An attachment must not be in that list.
    expect(CSS).toContain('.input-bar.is-recording .input');
    expect(CSS).toContain('.input-bar.is-voice-preview .input');
    expect(CSS).not.toContain('.input-bar.has-attachment .input,');
    expect(CSS).not.toMatch(/\.input-bar\.has-attachment \.input\s*\{[^}]*display:\s*none/);
  });

  it('makes the pill a real column instead of leaning on flex wrapping', () => {
    // `.input` is `flex: 1`, so its flex-basis is 0 and it fits on ANY line —
    // a wrapping pill put the preview and a zero-width textarea on the same
    // row and pushed the action group onto its own. Two explicit rows in a
    // column cannot do that.
    expect(CSS).toMatch(/\.input-wrap\s*\{[^}]*flex-direction:\s*column/);
    expect(CSS).toMatch(/\.input-row\s*\{[^}]*flex-direction:\s*row/);
    expect(CSS).not.toContain('.input-bar.has-attachment .input-wrap { flex-wrap: wrap; }');
  });

  it('leaves no preview class without a stylesheet rule', () => {
    // Same guard the skeleton, the call surface and the voice note carry.
    const emitted = new Set<string>();
    for (const m of pillSource().matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls.startsWith('att-preview') && /^[\w-]+$/.test(cls)) emitted.add(cls);
      }
    }
    expect(emitted.size).toBeGreaterThanOrEqual(6);
    const styled = new Set(Array.from(CSS.matchAll(/\.(att-preview[\w-]*)/g), (m) => m[1]));
    expect(Array.from(emitted).filter((c) => !styled.has(c))).toEqual([]);
  });
});

describe('what the preview shows', () => {
  it('draws an image as itself and anything else as a document glyph', () => {
    expect(RENDERER).toContain('data-attach-thumb-img');
    expect(RENDERER).toContain('data-attach-thumb-doc');
    expect(RUNTIME).toContain('function isPreviewableImage(file, mimeType)');
    expect(RUNTIME).toContain('attThumbUrl = URL.createObjectURL(s.file);');
  });

  it('never renders an SVG inline, whatever its mime type claims', () => {
    // An SVG is an image the browser will happily run scripts inside, and
    // this one comes straight off the visitor's disk.
    expect(RUNTIME).toContain("mime !== 'image/svg+xml'");
  });

  it('redraws the thumbnail only when the file changes', () => {
    // Recreating it on every store tick would flash the image on each
    // upload-progress update.
    expect(RUNTIME).toContain('if (s.file && attThumbForFile === s.file) return;');
  });

  it('revokes the object URL rather than leaking one per attachment', () => {
    expect(RUNTIME).toContain('function releaseAttachmentThumb()');
    expect(RUNTIME).toContain('URL.revokeObjectURL(attThumbUrl)');
  });

  it('reports progress honestly and offers a retry when it fails', () => {
    expect(RUNTIME).toContain("if (attTrack) attTrack.hidden = s.status !== 'uploading';");
    expect(RUNTIME).toContain("attRetryBtn.hidden = !(s.status === 'error' && !!s.file);");
    expect(CSS).toContain('.att-preview.is-error');
  });

  it('stands down for a voice note, which owns the same pill differently', () => {
    expect(RUNTIME).toContain("var visible = s.status !== 'idle' && !s.isVoice;");
  });

  it('updates fields in place instead of rebuilding its markup', () => {
    // The old renderer replaced innerHTML and rebound listeners on every
    // store tick; the buttons are bound once now.
    expect(RUNTIME).toContain('attPreview.hidden = false;');
    expect(RUNTIME).not.toContain('attPreview.innerHTML =');
  });
});
