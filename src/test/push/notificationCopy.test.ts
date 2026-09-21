/**
 * A notification arrives in the RECIPIENT's language, laid out the right way
 * round.
 *
 * Both halves of that were broken, and in opposite directions. The fallback
 * copy — what is sent when no operator-written template covers the event —
 * was hardcoded in two languages at once: the privacy body was Persian and
 * everything else English, so an English operator who turned previews off got
 * "پیام جدید در Webyar" on their lock screen and a Turkish one got a sentence
 * in neither of their languages. And Persian copy that happens to start with
 * a Latin customer name is laid out left-to-right by iOS, because a banner
 * has no direction of its own and the first strong character decides.
 *
 * The locale was already being resolved per recipient and passed into
 * `renderContent`; only the template path used it.
 */
import { describe, it, expect } from 'vitest';
import { renderContent, type InboundPushInput } from '../../../server/services/push/dispatch';

const RLM = '‏';

const message: InboundPushInput = {
  workspaceId: 'w-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  senderName: 'Ali',
  text: 'Is the order shipped yet?',
};

/** No policy: the fallback copy, which is what this file is about. */
function render(input: InboundPushInput, preview: boolean, locale: string) {
  return renderContent(input, 'new_message', preview, null, locale);
}

describe('notification copy follows the recipient', () => {
  describe('privacy mode — previews off', () => {
    it('speaks English to an English operator', () => {
      expect(render(message, false, 'en').body).toBe('New message in Webyar');
    });

    it('speaks Turkish to a Turkish operator', () => {
      expect(render(message, false, 'tr').body).toBe("Webyar'da yeni mesaj");
    });

    it('speaks Persian to a Persian operator', () => {
      expect(render(message, false, 'fa').body).toContain('پیام جدید');
    });

    it('never leaks the message text', () => {
      for (const locale of ['en', 'fa', 'tr']) {
        const { title, body } = render(message, false, locale);
        expect(`${title} ${body}`).not.toContain('order shipped');
      }
    });

    it('keeps the brand in Latin in every language', () => {
      // The wordmark is not translated anywhere else either — see
      // `Str.brandWordmark` in the iOS app.
      for (const locale of ['en', 'fa', 'tr']) {
        expect(render(message, false, locale).title).toBe('Webyar');
      }
    });
  });

  describe('a message with no sender name', () => {
    const anonymous: InboundPushInput = { ...message, senderName: null };

    it('says "Customer" in the operator\'s language', () => {
      expect(render(anonymous, true, 'en').title).toBe('Customer');
      expect(render(anonymous, true, 'tr').title).toBe('Müşteri');
      // No mark: it already starts with a Persian letter, so iOS reads it
      // right-to-left on its own.
      expect(render(anonymous, true, 'fa').title).toBe('مشتری');
    });
  });

  describe('a message with no text', () => {
    const attachment: InboundPushInput = { ...message, text: null, attachmentCount: 1 };
    const empty: InboundPushInput = { ...message, text: null };

    it('describes the attachment in the operator\'s language', () => {
      expect(render(attachment, true, 'en').body).toBe('📎 Attachment');
      expect(render(attachment, true, 'tr').body).toBe('📎 Ek');
      // The paperclip is direction-neutral, so the first STRONG character is
      // still Persian and nothing needs marking.
      expect(render(attachment, true, 'fa').body).toBe('📎 پیوست');
    });

    it('falls back to "new message", also translated', () => {
      expect(render(empty, true, 'en').body).toBe('New message');
      expect(render(empty, true, 'tr').body).toBe('Yeni mesaj');
      expect(render(empty, true, 'fa').body).toBe('پیام جدید');
    });
  });

  describe('mentions and internal notes', () => {
    it('are translated too', () => {
      const mention = renderContent(message, 'mention', true, null, 'tr');
      expect(mention.title).toBe('Ali sizden bahsetti');

      const note = renderContent(message, 'internal_note', true, null, 'fa');
      expect(note.title).toContain('یادداشت داخلی');
    });
  });

  describe('direction', () => {
    it('marks a Persian line that a Latin name would otherwise turn round', () => {
      // "Ali · یادداشت داخلی" starts with a Latin letter. Without the mark
      // iOS lays the whole line out left-to-right and strands the Persian
      // punctuation on the wrong end.
      const { title } = renderContent(message, 'internal_note', true, null, 'fa');
      expect(title.startsWith(RLM)).toBe(true);
      expect(title).toContain('یادداشت داخلی');
    });

    it('leaves a line that is already right-to-left alone', () => {
      // Marking everything would right-align lines that were already right,
      // and right-align Latin ones that should not move at all.
      const { body } = renderContent(message, 'internal_note', true, null, 'fa');
      expect(body.startsWith(RLM)).toBe(false);
      expect(render({ ...message, senderName: 'سارا' }, true, 'fa').title).toBe('سارا');
    });

    it('leaves English and Turkish alone', () => {
      for (const locale of ['en', 'tr']) {
        const { title, body } = render(message, true, locale);
        expect(title).not.toContain(RLM);
        expect(body).not.toContain(RLM);
      }
    });

    it('leaves a purely Latin line unmarked', () => {
      // "Webyar" on its own has no Persian in it and no direction to fix.
      expect(render(message, false, 'fa').title).toBe('Webyar');
      // And a bare Latin sender name is not Persian copy either.
      expect(render(message, true, 'fa').title).toBe('Ali');
    });
  });

  describe('whatever shape the locale arrives in', () => {
    it('accepts a region and a case', () => {
      for (const locale of ['fa-IR', 'fa_IR', 'FA', 'fa']) {
        expect(render(message, false, locale).body).toContain('پیام جدید');
      }
    });

    it('falls back to English for a language we do not ship', () => {
      for (const locale of ['de', '', 'xx-YY']) {
        expect(render(message, false, locale).body).toBe('New message in Webyar');
      }
    });
  });
});
