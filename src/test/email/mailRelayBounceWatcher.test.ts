// @vitest-environment node
/**
 * The relay's bounce watcher (deploy/mail-relay/bounce-watcher/watcher.mjs):
 *
 *   - it reads Postfix's log lines: the sender of a queue id, then its
 *     recipients' outcomes; a 5.x.x bounce of a brand's mail is a report to
 *     that brand, a deferral only a count, a bounce notice's bounce nothing;
 *   - brands, tokens and endpoints come from the environment, and a brand
 *     without a token is left out;
 *   - its signature is the one the backend's relay route checks;
 *   - the outbox retries with backoff, drops what the backend can never take
 *     and gives up after 3 days.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  brandFor,
  flushOutbox,
  handleLine,
  MAX_REPORT_AGE_MS,
  parseLogLine,
  readBrands,
  retryDelayMs,
  signReport,
} from '../../../deploy/mail-relay/bounce-watcher/watcher.mjs';
import { verifyRelaySignature } from '../../../server/routes/emailEvents';

const LOG = [
  'Oct 29 15:11:02 mail postfix/submission/smtpd[211]: 4XkQ2B0abcz9sW: client=unknown[10.0.1.7], sasl_method=PLAIN, sasl_username=noreply@webyar.ai',
  'Oct 29 15:11:02 mail postfix/cleanup[215]: 4XkQ2B0abcz9sW: message-id=<a1@webyar.ai>',
  'Oct 29 15:11:02 mail postfix/qmgr[90]: 4XkQ2B0abcz9sW: from=<noreply@webyar.ai>, size=5120, nrcpt=1 (queue active)',
  'Oct 29 15:11:04 mail postfix/smtp[216]: 4XkQ2B0abcz9sW: to=<nobody@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.27]:25, delay=2.1, delays=0.1/0/0.9/1.1, dsn=5.1.1, status=bounced (host gmail-smtp-in.l.google.com[142.250.1.27] said: 550-5.1.1 The email account that you tried to reach does not exist. (in reply to RCPT TO command))',
  'Oct 29 15:11:04 mail postfix/bounce[217]: 4XkQ2B0abcz9sW: sender non-delivery notification: 4XkQ2C1xyzz9sX',
  'Oct 29 15:11:04 mail postfix/qmgr[90]: 4XkQ2B0abcz9sW: removed',
];

const brands = readBrands({
  BRAND_DOMAINS: 'webyar.ai respok.app',
  EVENTS_TOKEN_WEBYAR_AI: 'tok-webyar',
  EVENTS_TOKEN_RESPOK_APP: 'tok-respok',
  EVENTS_URL_RESPOK_APP: 'http://backend.test/api/email-events/relay',
});

const emptyState = () => ({ inode: null, position: null, pending: {} as Record<string, { sender: string; at: number }>, outbox: [] as unknown[] });

describe('reading the log', () => {
  it('parses what matters and nothing else', () => {
    expect(parseLogLine(LOG[2])).toMatchObject({ daemon: 'qmgr', queueId: '4XkQ2B0abcz9sW', kind: 'from', sender: 'noreply@webyar.ai' });
    expect(parseLogLine(LOG[3])).toMatchObject({ kind: 'delivery', recipient: 'nobody@gmail.com', status: 'bounced', dsn: '5.1.1' });
    expect(parseLogLine(LOG[3])?.reason).toContain('550-5.1.1');
    expect(parseLogLine(LOG[5])).toMatchObject({ kind: 'removed' });
    expect(parseLogLine('Oct 29 15:12:00 mail postfix/submission/smtpd[300]: NOQUEUE: reject: RCPT from unknown[10.0.1.9]: 554 5.7.1')).toBeNull();
    expect(parseLogLine('Oct 29 15:12:00 mail postfix/smtpd[300]: connect from unknown[10.0.1.9]')).toBeNull();
  });

  it('a hard bounce becomes a report to the sender\'s brand', () => {
    const state = emptyState();
    const results = LOG.map((line) => handleLine(state, brands, line, Date.UTC(2026, 9, 29)));
    const bounces = results.filter((r) => r?.bounce);
    expect(bounces).toHaveLength(1);
    expect(bounces[0]!.bounce).toMatchObject({
      brand: 'webyar.ai',
      event: { type: 'bounce', recipient: 'nobody@gmail.com', status: '5.1.1', queue_id: '4XkQ2B0abcz9sW' },
    });
    expect(state.pending).toEqual({});
  });

  it('a deferral is counted, a bounce of a bounce notice or an unknown sender is not reported', () => {
    const state = emptyState();
    handleLine(state, brands, 'Oct 29 mail postfix/qmgr[1]: AAAAAA1: from=<noreply@respok.app>, size=1, nrcpt=1 (queue active)');
    expect(handleLine(state, brands, 'Oct 29 mail postfix/smtp[2]: AAAAAA1: to=<x@outlook.com>, relay=none, delay=1, dsn=4.4.1, status=deferred (connect timed out)'))
      .toEqual({ deferred: 'outlook.com' });
    handleLine(state, brands, 'Oct 29 mail postfix/qmgr[1]: BBBBBB2: from=<>, size=1, nrcpt=1 (queue active)');
    expect(handleLine(state, brands, 'Oct 29 mail postfix/smtp[2]: BBBBBB2: to=<noreply@respok.app>, relay=x, dsn=5.1.1, status=bounced (no)'))
      .toEqual({ unknownSender: true });
    expect(handleLine(state, brands, 'Oct 29 mail postfix/smtp[2]: CCCCCC3: to=<a@b.co>, relay=x, dsn=5.1.1, status=bounced (no)'))
      .toEqual({ unknownSender: true });
    expect(handleLine(state, brands, 'Oct 29 mail postfix/smtp[2]: AAAAAA1: to=<y@b.co>, relay=x, dsn=2.0.0, status=sent (250 ok)')).toBeNull();
  });
});

describe('brands', () => {
  it('reads tokens and endpoints, and leaves out a brand without a token', () => {
    expect(brands.get('webyar.ai')).toEqual({ domain: 'webyar.ai', url: 'https://api.webyar.ai/api/email-events/relay', token: 'tok-webyar' });
    expect(brands.get('respok.app')?.url).toBe('http://backend.test/api/email-events/relay');
    expect(readBrands({ EVENTS_TOKEN_WEBYAR_AI: 'x' }).has('respok.app')).toBe(false);
    expect(brandFor('noreply@mail.respok.app', brands)?.domain).toBe('respok.app');
    expect(brandFor('someone@example.com', brands)).toBeNull();
  });

  it('signs as the backend verifies', () => {
    const body = JSON.stringify({ events: [] });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signReport('tok-webyar', ts, body);
    expect(verifyRelaySignature('tok-webyar', { signature, timestamp: ts }, Buffer.from(body))).toBe(true);
    expect(verifyRelaySignature('tok-respok', { signature, timestamp: ts }, Buffer.from(body))).toBe(false);
  });
});

describe('the outbox', () => {
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const item = (brand: string, now: number) => ({ brand, event: { type: 'bounce', recipient: 'x@y.co', status: '5.1.1' }, firstAt: now, attempts: 0, nextAt: now });

  it('delivers per brand, signed, and empties on 2xx', async () => {
    const now = Date.now();
    const state = { ...emptyState(), outbox: [item('webyar.ai', now), item('respok.app', now)] };
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 200 };
    });
    await flushOutbox(state, brands, now, fetchImpl as never, quiet);
    expect(state.outbox).toEqual([]);
    expect(calls.map((c) => c.url).sort()).toEqual(['http://backend.test/api/email-events/relay', 'https://api.webyar.ai/api/email-events/relay']);
    const webyar = calls.find((c) => c.url.includes('webyar'))!;
    expect(verifyRelaySignature('tok-webyar', { signature: webyar.headers['x-relay-signature'], timestamp: webyar.headers['x-relay-timestamp'] }, Buffer.from(webyar.body))).toBe(true);
  });

  it('retries with backoff, drops a 400, gives up after 3 days', async () => {
    const now = Date.now();
    const state = { ...emptyState(), outbox: [item('webyar.ai', now)] };
    await flushOutbox(state, brands, now, (async () => ({ status: 503 })) as never, quiet);
    expect(state.outbox).toHaveLength(1);
    expect((state.outbox[0] as { nextAt: number }).nextAt).toBe(now + retryDelayMs(1));

    await flushOutbox(state, brands, now + retryDelayMs(1), (async () => { throw new Error('ECONNREFUSED'); }) as never, quiet);
    expect((state.outbox[0] as { attempts: number }).attempts).toBe(2);

    const late = now + MAX_REPORT_AGE_MS + 1;
    await flushOutbox(state, brands, late, (async () => ({ status: 401 })) as never, quiet);
    expect(state.outbox).toEqual([]);

    const refused = { ...emptyState(), outbox: [item('webyar.ai', now)] };
    await flushOutbox(refused, brands, now, (async () => ({ status: 400 })) as never, quiet);
    expect(refused.outbox).toEqual([]);
  });

  it('backs off from 30 s to at most an hour', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(3600_000);
  });
});
