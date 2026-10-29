/**
 * The web Inbox names the mailbox on every request (`?provider=`): with
 * Gmail and Yahoo Mail both connected the server answered for Gmail, and the
 * Yahoo mailbox could not be reached from the web.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEmailChanges,
  getEmailThread,
  listEmailThreads,
  sendEmail,
  setEmailThreadRead,
  setEmailThreadStarred,
  uploadEmailAttachment,
} from '@/lib/emailInbox-api';

describe('emailInbox-api names the mailbox', () => {
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return new Response('{}', { status: 200 });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on every read, write, upload and send', async () => {
    await listEmailThreads('ws', { q: 'order' }, 'yahoo');
    await getEmailThread('ws', 't1', 'yahoo');
    await getEmailChanges('ws', '123', 'gmail');
    await setEmailThreadRead('ws', 't1', true, 'yahoo');
    await setEmailThreadStarred('ws', 't1', true, 'yahoo');
    await uploadEmailAttachment('ws', new File(['x'], 'a.txt', { type: 'text/plain' }), 'yahoo');
    await sendEmail('ws', { to: ['c@example.test'], subject: 's', textBody: 't', clientRequestId: 'req-12345678' }, 'yahoo');
    expect(urls).toHaveLength(7);
    for (const url of urls) expect(new URL(url, 'https://app.test').searchParams.get('provider')).toMatch(/^(gmail|yahoo)$/);
    expect(urls[2]).toContain('provider=gmail');
    expect(urls[6]).toMatch(/\/send\?provider=yahoo$/);
  });

  it('and leaves the choice to the server when none is given', async () => {
    await listEmailThreads('ws');
    await getEmailThread('ws', 't1');
    expect(urls.every((url) => !url.includes('provider='))).toBe(true);
  });
});
