/**
 * A delivery log is not a second copy of the conversation (issue #340,
 * contract §9): the transcript a visitor asks for (services/visitorTranscript.ts,
 * up to 200 KiB of HTML plus its text twin) is template data like any other,
 * and `email_logs.metadata` used to keep it whole. It keeps `[OMITTED]` in its
 * place now, on the write and on reads of rows written before; the rest of
 * the template data (and the credential redaction) are as they were.
 */
import { describe, expect, it } from 'vitest';
import {
  OMITTED,
  REDACTED,
  buildEmailLogMetadata,
  redactEmailLogRows,
  redactSecrets,
} from '../../../server/services/email/redactLogMetadata';

const transcript = '<tr><td>سلام</td></tr>'.repeat(5000);

describe('transcripts in email_logs.metadata', () => {
  it('the write keeps neither the HTML nor the text transcript, and the other values as they are', () => {
    const meta = buildEmailLogMetadata({
      workspace: 'Acme &amp; Co',
      workspace_name: 'Acme & Co',
      date: '۱۴۰۵/۰۷/۲۶',
      transcript,
      transcript_text: 'شما: سلام\nسارا: سلام',
      action_url: 'https://app.test/reset?token=abc',
    }, 'msg-1');
    expect(meta).toEqual({
      templateData: {
        workspace: 'Acme &amp; Co',
        workspace_name: 'Acme & Co',
        date: '۱۴۰۵/۰۷/۲۶',
        transcript: OMITTED,
        transcript_text: OMITTED,
        action_url: REDACTED,
      },
      messageId: 'msg-1',
    });
    expect(JSON.stringify(meta).length).toBeLessThan(400);
  });

  it('an older row read back loses its transcript too; an empty transcript stays empty', () => {
    const [row] = redactEmailLogRows([{ id: 'l1', metadata: { templateData: { transcript, Transcript_Text: 'x', name: 'Ali' } } }]);
    expect(row.metadata).toEqual({ templateData: { transcript: OMITTED, Transcript_Text: OMITTED, name: 'Ali' } });
    expect(redactSecrets({ transcript: '' })).toEqual({ transcript: '' });
    // Only these keys: a field that merely mentions a transcript is kept.
    expect(redactSecrets({ transcript_count: 3, has_transcript: true })).toEqual({ transcript_count: 3, has_transcript: true });
  });
});
