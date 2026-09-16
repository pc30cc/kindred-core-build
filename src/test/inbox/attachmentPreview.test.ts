import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { attachmentPreviewText, type AttachmentPreviewKind } from '@/lib/systemMessageText';
import { attachmentPreviewKind } from '../../../server/services/attachmentPreviewKind.js';

/**
 * A message whose only content is an attachment has an empty body, so a list
 * that previews the body alone claimed "no messages yet" about a conversation
 * somebody had just sent a photo to.
 *
 * The sentence is a WHOLE template per case, not a name prefix glued onto a
 * verb fragment. The old shape produced «شما: یک تصویر ارسال کرد» — "you:"
 * followed by a third-person verb — which no amount of translation fixes,
 * because the subject and the verb have to agree.
 */
function translator(bundle: Record<string, unknown>) {
  const strings = (bundle.inbox ?? {}) as Record<string, string>;
  return (key: string) => strings[key.replace(/^inbox\./, '')] ?? key;
}
const T = {
  en: translator(en as Record<string, unknown>),
  fa: translator(fa as Record<string, unknown>),
  tr: translator(tr as Record<string, unknown>),
};
const KINDS: AttachmentPreviewKind[] = ['image', 'audio', 'video', 'file'];

describe('mime types map to a preview kind', () => {
  it('classifies what a conversation actually carries', () => {
    expect(attachmentPreviewKind('image/png')).toBe('image');
    expect(attachmentPreviewKind('image/svg+xml')).toBe('image');
    expect(attachmentPreviewKind('audio/webm')).toBe('audio');
    expect(attachmentPreviewKind('audio/mp4')).toBe('audio');
    expect(attachmentPreviewKind('video/mp4')).toBe('video');
  });

  it('calls anything else a file rather than guessing', () => {
    for (const mime of ['application/pdf', 'text/plain', '', null, undefined, 'nonsense']) {
      expect(attachmentPreviewKind(mime), String(mime)).toBe('file');
    }
  });

  it('is case-insensitive, because mime types arrive however they arrive', () => {
    expect(attachmentPreviewKind('IMAGE/PNG')).toBe('image');
  });
});

describe('the sentence names who sent what, in every locale', () => {
  it('never leaves a key or a placeholder in the output', () => {
    for (const kind of KINDS) {
      for (const [name, t] of Object.entries(T)) {
        for (const sender of [
          { isMe: true },
          { isMe: false, name: 'Sara' },
          { isMe: false, name: null },
        ]) {
          const text = attachmentPreviewText(kind, sender, t);
          expect(text, `${name}/${kind}`).toBeTruthy();
          expect(text, `${name}/${kind} leaked a key`).not.toMatch(/inbox\./);
          expect(text, `${name}/${kind} left a placeholder`).not.toContain('{name}');
        }
      }
    }
  });

  it('addresses me in the second person, not the third', () => {
    // The whole reason for a per-case template. Persian conjugates for the
    // subject: «ارسال کردید» for you, «ارسال کرد» for anyone else.
    expect(attachmentPreviewText('image', { isMe: true }, T.fa)).toContain('ارسال کردید');
    expect(attachmentPreviewText('image', { isMe: true }, T.fa)).not.toContain('ارسال کرد ');
    expect(attachmentPreviewText('image', { isMe: false, name: 'سارا' }, T.fa))
      .toContain('ارسال کرد');
    expect(attachmentPreviewText('image', { isMe: true }, T.en)).toMatch(/^You sent/);
  });

  it('names the sender when it knows them', () => {
    for (const [name, t] of Object.entries(T)) {
      expect(attachmentPreviewText('file', { isMe: false, name: 'Sara' }, t), name)
        .toContain('Sara');
    }
  });

  it('still gives an unnamed visitor a subject', () => {
    // A contact row with no name yet must not produce a subjectless fragment
    // like "sent a photo".
    for (const blank of [null, undefined, '', '   ']) {
      const text = attachmentPreviewText('image', { isMe: false, name: blank }, T.fa);
      expect(text, String(blank)).toContain('کاربر');
      expect(text, String(blank)).not.toMatch(/^\s/);
    }
    expect(attachmentPreviewText('image', { isMe: false, name: null }, T.en))
      .toBe('A user sent a photo');
  });

  it('distinguishes the four kinds rather than calling everything a file', () => {
    for (const [name, t] of Object.entries(T)) {
      const texts = KINDS.map((k) => attachmentPreviewText(k, { isMe: true }, t));
      expect(new Set(texts).size, `${name} collapses kinds`).toBe(KINDS.length);
    }
  });

  it('actually translates — Persian is never the English string', () => {
    for (const kind of KINDS) {
      expect(attachmentPreviewText(kind, { isMe: true }, T.fa))
        .not.toBe(attachmentPreviewText(kind, { isMe: true }, T.en));
    }
  });
});

describe('both lists are wired to it', () => {
  const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');
  const WIDGET_ROUTE = readFileSync('server/routes/widget.ts', 'utf8');
  const WIDGET_RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');

  it('the operator list builds a sentence instead of a prefixed fragment', () => {
    expect(INBOX).toContain('attachmentPreviewText(');
    expect(INBOX).not.toContain("`${prefix}${t(key) || 'sent a file'}`");
  });

  it('the widget list gets a kind from the server, never display text', () => {
    // The server has no business choosing the visitor's language.
    expect(WIDGET_ROUTE).toContain('attachmentKind: last?.attachment_kind ?? null,');
    expect(WIDGET_ROUTE).toContain('outbound: last ? last.sender_type === \'contact\' : false,');
    expect(WIDGET_RUNTIME).toContain('function attachmentPreviewText(kind, outbound)');
  });

  it('only describes media when there is no caption to show instead', () => {
    // A message with both text and an attachment previews its text.
    expect(WIDGET_ROUTE).toContain(".filter((l) => l.attachment_id && !String(l.body || '').trim())");
  });

  it('carries the widget strings in every locale it ships', () => {
    for (const locale of ['en', 'fa', 'tr']) {
      for (const key of ['wySentImage', 'wyReceivedImage', 'wySentFile', 'wyReceivedFile']) {
        expect(
          WIDGET_RUNTIME.includes(`${key}:`),
          `${locale} widget string ${key}`,
        ).toBe(true);
      }
    }
    // One entry per locale, plus nothing stray.
    for (const key of ['wySentImage', 'wyReceivedAudio']) {
      expect(WIDGET_RUNTIME.match(new RegExp(`${key}:`, 'g'))?.length, key).toBe(3);
    }
  });
});
