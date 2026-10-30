/**
 * The rows of a chat transcript in an email, for the two mails that carry
 * one: the visitor's copy (visitorTranscript.ts, template
 * visitor_conversation_transcript) and the operator's
 * (notificationEmail/dispatcher.ts, template operator_conversation_transcript).
 *
 * The template holds the container, `<div class="transcript">{transcript}</div>`,
 * and these are the rows inside it, in the email layout's content vocabulary
 * (server/services/email/layout.ts draws each as a chat bubble):
 *
 *   <div class="msg msg-visitor"><div class="meta">Sara · 10:24</div><div class="bubble" dir="auto">text</div></div>
 *
 * msg-visitor is a line the customer wrote, msg-agent one of the team's. A
 * row with a meta line and no bubble is a notice: a system line, or the note
 * that older messages were left out. Every value is escaped here, a line
 * break becomes <br>, and each bubble takes the direction of its own text
 * (dir="auto"), so an English message in a Persian mail reads left to right.
 */

export type TranscriptSide = 'visitor' | 'agent';

/**
 * At most this many rows, the newest kept. The layout adds about 0.7 KB of
 * markup to every row, so with the byte cap below a transcript mail stays
 * near 80 KB at most, well under the 102 KB after which Gmail cuts a mail
 * (and its footer, with the unsubscribe line) short.
 */
export const TRANSCRIPT_MAX_ROWS = 50;
/** The rows' own HTML in UTF-8 bytes (a Persian letter is two). */
export const TRANSCRIPT_MAX_BYTES = 32 * 1024;

export function escapeTranscriptText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One message (with a bubble), or a notice (meta line only, when `text` is absent). */
export function transcriptRow(side: TranscriptSide, meta: string, text?: string): string {
  const bubble = text === undefined
    ? ''
    : `<div class="bubble" dir="auto">${escapeTranscriptText(text).replace(/\r?\n/g, '<br>')}</div>`;
  return `<div class="msg msg-${side}"><div class="meta">${escapeTranscriptText(meta)}</div>${bubble}</div>`;
}

/**
 * Where the kept rows start: the newest rows that fit TRANSCRIPT_MAX_ROWS and
 * TRANSCRIPT_MAX_BYTES, and always the newest one.
 */
export function keptRowsFrom(rows: readonly string[]): number {
  let from = rows.length;
  let bytes = 0;
  while (from > 0) {
    const size = Buffer.byteLength(rows[from - 1], 'utf8');
    const kept = rows.length - from;
    if (kept > 0 && (kept + 1 > TRANSCRIPT_MAX_ROWS || bytes + size > TRANSCRIPT_MAX_BYTES)) break;
    bytes += size;
    from -= 1;
  }
  return from;
}
