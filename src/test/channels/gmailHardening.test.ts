// @vitest-environment node
/**
 * Gmail channel hardening:
 *   - outbound MIME: no caller-supplied value (subject, display name,
 *     addresses, In-Reply-To / References, attachment filename) can inject a
 *     header line or a MIME part;
 *   - inbound: decoded RFC 2047 words cannot smuggle CR/LF into a subject;
 *   - sync checkpoint: never advances past a message that failed to land,
 *     unless the job is on its final attempt (bounded blocking).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRawGmailMessage,
  encodeHeaderWord,
  mimeFilenameParams,
  parseGmailMessage,
} from '../../../channels/mail/gmail/client.js';
import { gmailCheckpointDecision, isGmailMessageGone } from '../../../worker/channels/gmailCheckpoint.js';
import { GmailError } from '../../../server/services/channels/gmail/types.js';

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Header block = everything before the first empty line. */
function headerBlock(mime: string): string[] {
  const head = mime.split('\r\n\r\n')[0];
  // Unfold RFC 5322 folding whitespace so each logical header is one entry.
  return head.replace(/\r\n[ \t]/g, ' ').split('\r\n');
}

describe('Gmail outbound MIME header injection', () => {
  const evil = 'x\r\nBcc: victim@evil.test\r\n\r\ninjected body';

  it('keeps every injected CRLF inside its own header value', () => {
    const { raw } = buildRawGmailMessage({
      from: { email: 'me@example.com', name: `Support${evil}` },
      to: [{ email: 'you@example.com\r\nBcc: x@evil.test' }],
      subject: `Hello${evil}`,
      textBody: 'hi',
      inReplyTo: `<a@b>${evil}`,
      references: [`<r1@b>\r\nX-Injected: 1`, '<r2@b>'],
      messageId: '<m@b>\r\nX-Injected: 2',
    });
    const headers = headerBlock(decodeRaw(raw));
    const names = headers.map((h) => h.split(':')[0]);
    expect(names).toEqual(['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'MIME-Version', 'Content-Type']);
    expect(headers.some((h) => /^(Bcc|X-Injected):/i.test(h))).toBe(false);
  });

  it('RFC 2047-encodes display names with specials and non-ASCII subjects', () => {
    expect(encodeHeaderWord('Plain subject')).toBe('Plain subject');
    expect(encodeHeaderWord('سلام دنیا')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeaderWord('Evil, "Name" <x@y>', { encodeSpecials: true })).toMatch(/^=\?UTF-8\?B\?/);
    const long = encodeHeaderWord('ش'.repeat(200));
    for (const word of long.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
  });

  it('quotes/escapes attachment filenames and adds RFC 2231 for non-ASCII', () => {
    expect(mimeFilenameParams('filename', 'a"b\\c\r\nX-Evil: 1.pdf')).toBe('filename="a\\"b\\\\c X-Evil: 1.pdf"');
    expect(mimeFilenameParams('filename', 'فاکتور.pdf')).toBe(
      `filename="______.pdf"; filename*=UTF-8''${encodeURIComponent('فاکتور.pdf')}`,
    );
    const { raw } = buildRawGmailMessage({
      from: { email: 'me@example.com' },
      to: [{ email: 'you@example.com' }],
      subject: 's',
      textBody: 'b',
      attachments: [{ filename: 'x"\r\nContent-Type: text/html', contentType: 'text/plain\r\nX-Evil: 1', bytes: Buffer.from('z') }],
    });
    const mime = decodeRaw(raw);
    expect(mime).not.toMatch(/\r\nX-Evil/);
    expect(mime).toContain('Content-Type: application/octet-stream; name="x\\" Content-Type: text/html"');
  });

  it('legitimate messages are unchanged in shape', () => {
    const { raw, messageId } = buildRawGmailMessage({
      from: { email: 'me@example.com', name: 'Support Team' },
      to: [{ email: 'you@example.com' }],
      subject: 'Re: Order 42',
      textBody: 'Thanks',
      inReplyTo: '<orig@mail.example>',
      references: ['<root@mail.example>', '<orig@mail.example>'],
    });
    const headers = headerBlock(decodeRaw(raw));
    expect(headers).toContain('From: Support Team <me@example.com>');
    expect(headers).toContain('Subject: Re: Order 42');
    expect(headers).toContain('In-Reply-To: <orig@mail.example>');
    expect(headers).toContain('References: <root@mail.example> <orig@mail.example>');
    expect(headers).toContain(`Message-ID: ${messageId}`);
  });
});

describe('Gmail inbound subject decoding', () => {
  it('flattens CR/LF smuggled through an encoded-word', () => {
    const encoded = `=?UTF-8?B?${Buffer.from('Hi\r\nBcc: evil@x').toString('base64')}?=`;
    const parsed = parseGmailMessage({ id: '1', threadId: 't', payload: { headers: [{ name: 'Subject', value: encoded }] } });
    expect(parsed.subject).toBe('Hi Bcc: evil@x');
  });
});

describe('Gmail history checkpoint', () => {
  it('advances only when every message landed', () => {
    expect(gmailCheckpointDecision({ failedCount: 0, attemptCount: 1, maxAttempts: 8 })).toBe('advance');
    expect(gmailCheckpointDecision({ failedCount: 1, attemptCount: 1, maxAttempts: 8 })).toBe('hold_and_retry');
    expect(gmailCheckpointDecision({ failedCount: 1, attemptCount: 7, maxAttempts: 8 })).toBe('hold_and_retry');
  });

  it('gives up (advances) on the final attempt so one bad message cannot block forever', () => {
    expect(gmailCheckpointDecision({ failedCount: 2, attemptCount: 8, maxAttempts: 8 })).toBe('advance_giving_up');
  });

  it('treats a 404 (deleted message) as done, anything else as a failure', () => {
    expect(isGmailMessageGone(new GmailError('gmail_provider_error', undefined, 'Gmail 404 @ https://x — not found'))).toBe(true);
    expect(isGmailMessageGone(new GmailError('gmail_provider_error', undefined, 'Gmail 500 @ https://x — boom'))).toBe(false);
    expect(isGmailMessageGone(new GmailError('gmail_rate_limited'))).toBe(false);
    expect(isGmailMessageGone(new Error('Gmail 404'))).toBe(false);
  });

  it('is wired into the worker sync loop', async () => {
    const { readFileSync } = await import('node:fs');
    const worker = readFileSync('worker/channels/index.ts', 'utf8');
    expect(worker).toContain("if (decision === 'hold_and_retry')");
    expect(worker).toMatch(/failedMessageIds\.push\(gmailMessageId\)/);
  });
});
