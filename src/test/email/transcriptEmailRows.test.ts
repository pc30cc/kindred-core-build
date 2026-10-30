/**
 * The rows of a transcript in an email (server/services/transcriptEmailRows.ts):
 * the layout's div.transcript vocabulary, every value as text, and the caps
 * that keep a transcript mail under the size Gmail cuts.
 */
import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_MAX_ROWS,
  keptRowsFrom,
  transcriptRow,
} from '../../../server/services/transcriptEmailRows';

describe('transcript rows in an email', () => {
  it('a message is a meta line and a bubble, a notice only a meta line, every value escaped', () => {
    expect(transcriptRow('visitor', 'Sara <b> · 10:24', 'Hi <a href="//x">there</a>\nsecond line'))
      .toBe('<div class="msg msg-visitor"><div class="meta">Sara &lt;b&gt; · 10:24</div>'
        + '<div class="bubble" dir="auto">Hi &lt;a href=&quot;//x&quot;&gt;there&lt;/a&gt;<br>second line</div></div>');
    expect(transcriptRow('agent', 'Ali closed the conversation'))
      .toBe('<div class="msg msg-agent"><div class="meta">Ali closed the conversation</div></div>');
  });

  it('keeps the newest rows within the row cap', () => {
    const rows = Array.from({ length: TRANSCRIPT_MAX_ROWS + 7 }, (_, i) => transcriptRow('agent', 'Team', `m${i}`));
    expect(keptRowsFrom(rows)).toBe(7);
    expect(keptRowsFrom(rows.slice(0, 3))).toBe(0);
    expect(keptRowsFrom([])).toBe(0);
  });

  it('keeps the newest rows within the byte cap, and always the newest one', () => {
    const big = (n: number) => transcriptRow('visitor', 'You', `${n}:${'س'.repeat(4000)}`);
    const rows = [big(0), big(1), big(2), big(3), big(4), big(5)];
    const from = keptRowsFrom(rows);
    const kept = rows.slice(from).reduce((n, r) => n + Buffer.byteLength(r, 'utf8'), 0);
    expect(kept).toBeLessThanOrEqual(TRANSCRIPT_MAX_BYTES);
    expect(from).toBeGreaterThan(0);
    expect(rows.length - from).toBe(Math.floor(TRANSCRIPT_MAX_BYTES / Buffer.byteLength(big(0), 'utf8')));
    // One message larger than the cap on its own still goes.
    const huge = transcriptRow('visitor', 'You', 'x'.repeat(TRANSCRIPT_MAX_BYTES + 10));
    expect(keptRowsFrom([big(0), huge])).toBe(1);
  });
});
