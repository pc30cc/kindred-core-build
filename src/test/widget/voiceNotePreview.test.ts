import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A finished voice note stays in the composer pill.
 *
 * Stopping a recording used to hand the blob straight to the generic
 * attachment tray, so the visitor got a file chip ABOVE the composer —
 * "voice message.m4a · ready to send · 86 KB" — which pushed the whole
 * composer down and read like an upload rather than a message waiting to
 * go. The pill it was recorded in now keeps it, with the only three things
 * there are to do with a recording: play it, delete it, send it.
 */
const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
const RENDERER = readFileSync('public/widget/presentation-web-yar.js', 'utf8');
const CSS = readFileSync('public/widget/presentation-web-yar.css', 'utf8');

describe('the pill owns the pending recording', () => {
  it('mounts the preview inside the input pill, beside the recorder row', () => {
    const start = RENDERER.indexOf('\'<div class="input-wrap" data-input-wrap>\'');
    expect(start, 'the composer pill must exist').toBeGreaterThan(-1);
    // `footerHtml` is also a function defined earlier in the file, so the
    // end anchor has to be searched forward from the pill.
    const wrap = RENDERER.slice(start, RENDERER.indexOf('footerHtml()', start));
    expect(wrap).toContain('data-vn-bar');
    // Both takeover rows are siblings of the textarea inside the same pill,
    // so switching modes is a class toggle and nothing is rebuilt.
    expect(wrap.indexOf('data-rec-bar')).toBeGreaterThan(-1);
    expect(wrap.indexOf('data-vn-bar')).toBeGreaterThan(wrap.indexOf('data-rec-bar'));
  });

  it('offers play, delete and send, and nothing else', () => {
    for (const hook of ['data-vn-toggle', 'data-vn-delete', 'data-vn-send', 'data-vn-audio']) {
      expect(RENDERER, hook).toContain(hook);
    }
  });

  it('runs its transport controls left-to-right even in Persian', () => {
    // Audio timelines run left→right in every locale, so the row opts out
    // of the widget's RTL direction the same way the message-bubble player
    // already does.
    expect(RENDERER).toMatch(/class="vn-bar" data-vn-bar hidden dir="ltr"/);
  });

  it('keeps all three pill modes exactly the same height', () => {
    // 46px is the textarea's height. If a mode were any other height, the
    // composer would jump as the visitor recorded and reviewed.
    const height = (selector: string) => {
      const rule = CSS.slice(CSS.indexOf(`\n${selector} {`));
      return /height:\s*(\d+)px/.exec(rule.slice(0, rule.indexOf('}')))?.[1];
    };
    expect(height('.vn-bar')).toBe('46');
    expect(height('.rec-bar')).toBe('46');
  });

  it('steps the textarea and the action group aside for the preview', () => {
    expect(CSS).toContain('.input-bar.is-voice-preview .input');
    expect(CSS).toContain('.input-bar.is-voice-preview .composer-actions');
    expect(CSS).toContain('.input-bar.is-voice-preview .mic-btn');
  });

  it('leaves no preview class without a stylesheet rule', () => {
    // Same guard the skeleton and the call surface carry: markup naming a
    // class the stylesheet has never heard of is how this widget breaks.
    const emitted = new Set<string>();
    for (const m of RENDERER.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls.startsWith('vn-') && /^[\w-]+$/.test(cls)) emitted.add(cls);
      }
    }
    expect(emitted.size).toBeGreaterThanOrEqual(6);
    const styled = new Set(Array.from(CSS.matchAll(/\.(vn-[\w-]+)/g), (m) => m[1]));
    expect(Array.from(emitted).filter((c) => !styled.has(c))).toEqual([]);
  });
});

describe('core knows a voice note from a file', () => {
  it('flags the recording, so the tray can stay out of the way', () => {
    expect(RUNTIME).toContain('attachmentStore.set({ isVoice: true, durationMs: recordedMs });');
    expect(RUNTIME).toMatch(/if \(s\.status === 'idle' \|\| s\.isVoice\)/);
  });

  it('resets the voice flags with the rest of the attachment', () => {
    // A leftover isVoice would hide the tray for the NEXT file attachment.
    expect(RUNTIME).toMatch(/function resetAttachment\(\)[\s\S]{0,400}isVoice: false, durationMs: 0/);
  });

  it('trusts the recording clock over the blob for the duration', () => {
    // A fresh MediaRecorder blob reports `duration: Infinity` until it has
    // been fully seeked, which rendered as "Infinity:NaN".
    expect(RUNTIME).toContain('function vnDurationMs()');
    expect(RUNTIME).toContain('var known = attachmentStore.get().durationMs || 0;');
    expect(RUNTIME).toContain('if (known > 0) return known;');
  });

  it('lets the visitor hear the note before the upload finishes', () => {
    // The player points at the local blob; only SENDING waits for the
    // server to have the bytes.
    expect(RUNTIME).toContain('vnObjectUrl = URL.createObjectURL(st.file);');
    expect(RUNTIME).toMatch(/var ready = s?t\.status === 'ready' && !!st\.attachmentId;/);
    expect(RUNTIME).toContain('vnSendBtn.disabled = !ready;');
  });

  it('revokes the object URL rather than leaking one per recording', () => {
    expect(RUNTIME).toContain('function releaseVoicePreviewUrl()');
    expect(RUNTIME).toContain('URL.revokeObjectURL(vnObjectUrl)');
    expect(RUNTIME).toMatch(/if \(vnWasVisible\) \{[\s\S]{0,200}releaseVoicePreviewUrl\(\);/);
  });

  it('sends through the one send path, so drafts and gating still apply', () => {
    const handler = RUNTIME.slice(RUNTIME.indexOf("if (vnSendBtn) {\n      vnSendBtn.addEventListener"));
    expect(handler.slice(0, 300)).toContain('trySend();');
  });
});

describe('uploads reach the right origin', () => {
  it('treats an empty apiBase as same-origin, not as missing', () => {
    // `ctx.apiBase || ctx.config.apiBase` turned a legitimate '' into
    // undefined, so a first-party embed POSTed every upload to
    // `/undefined/api/widget/attachments/init`.
    expect(RUNTIME).toContain(
      "var apiBase = (ctx.apiBase != null ? ctx.apiBase : ctx.config.apiBase) || '';",
    );
    expect(RUNTIME).not.toContain('var apiBase = ctx.apiBase || ctx.config.apiBase;');
  });
});
