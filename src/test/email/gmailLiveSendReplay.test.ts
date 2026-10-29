// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the Gmail and database test doubles are intentionally untyped. */
/**
 * A live (Gmail) reply sent from the Email Inbox:
 *
 *   - goes out under the mailbox's name (the workspace's, while the
 *     connection's display name is the address itself);
 *   - a retry of a send that our own timeout cut short asks Gmail for the
 *     copy carrying that send's Message-ID before sending again, and returns
 *     it when there is one: the customer gets one reply;
 *   - when there is none, it sends once more, with the same Message-ID;
 *   - a definite refusal is retried for real;
 *   - a large reply goes to Gmail's upload endpoint, with time to upload it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailError } from '../../../server/services/channels/gmail/types.js';

const gmail = vi.hoisted(() => ({
  sends: [] as Array<{ outbound: Record<string, any>; threadId: string | null | undefined }>,
  next: [] as Array<() => never | void>,
  found: null as { gmailId: string; threadId: string } | null,
  lookups: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { name: 'Acme Shop' }, error: null }),
      };
      return b;
    },
  }),
}));
vi.mock('../../../server/services/channels/integrations.js', () => ({ updateIntegration: async () => {} }));
vi.mock('../../../server/services/channels/gmail/oauth.js', () => ({
  getGmailAccessToken: async () => 'access-token',
  evictGmailAccessToken: () => {},
}));
vi.mock('../../../server/services/channels/gmail/oauthConfig.js', () => ({
  getGmailOAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://x/cb' }),
}));
vi.mock('../../../channels/mail/gmail/client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createGmailAdapter: () => ({
    sendMessage: async (_token: string, outbound: Record<string, any>, threadId?: string | null) => {
      gmail.sends.push({ outbound, threadId });
      gmail.next.shift()?.();
      return { gmailId: `gm-${gmail.sends.length}`, threadId: 'th-1', messageId: outbound.messageId };
    },
    findMessageByRfc822Id: async (_token: string, id: string) => {
      gmail.lookups.push(id);
      return gmail.found;
    },
  }),
}));

const { sendGmail } = await import('../../../server/services/email/gmailLive.js');

const integration = {
  id: 'int-1',
  workspace_id: 'ws-1',
  installation_id: 'inst-1',
  provider: 'gmail',
  status: 'connected',
  external_account_id: 'support@acme.test',
  display_name: 'support@acme.test',
} as any;

let request = 0;
const input = () => ({
  clientRequestId: `req-${++request}-abcdef`,
  threadId: null,
  to: ['customer@example.test'],
  subject: 'Your order',
  textBody: 'It ships today.',
});
const timeout = () => { throw new GmailError('gmail_timeout'); };
const subject = (s: string) => `Re: ${s}`;

describe('live Gmail sends', () => {
  beforeEach(() => {
    gmail.sends = [];
    gmail.next = [];
    gmail.found = null;
    gmail.lookups = [];
  });

  it('go out under the mailbox\'s name', async () => {
    await sendGmail({} as any, integration, input(), subject);
    expect(gmail.sends[0].outbound.from).toEqual({ email: 'support@acme.test', name: 'Acme Shop' });
  });

  it('a retry after our own timeout returns the copy Gmail already has, and sends nothing', async () => {
    const reply = input();
    gmail.next = [timeout];
    await expect(sendGmail({} as any, integration, reply, subject)).rejects.toBeTruthy();
    gmail.found = { gmailId: 'gm-already', threadId: 'th-9' };
    await expect(sendGmail({} as any, integration, reply, subject)).resolves.toEqual({ messageId: 'gm-already', threadId: 'th-9' });
    expect(gmail.sends).toHaveLength(1);
    expect(gmail.lookups).toEqual([gmail.sends[0].outbound.messageId]);
    // Replayed from here on, without asking Gmail again.
    await expect(sendGmail({} as any, integration, reply, subject)).resolves.toEqual({ messageId: 'gm-already', threadId: 'th-9' });
    expect(gmail.lookups).toHaveLength(1);
  });

  it('when Gmail has no copy, the retry sends once more with the same Message-ID', async () => {
    const reply = input();
    gmail.next = [timeout];
    await expect(sendGmail({} as any, integration, reply, subject)).rejects.toBeTruthy();
    await sendGmail({} as any, integration, reply, subject);
    expect(gmail.sends).toHaveLength(2);
    expect(gmail.sends[1].outbound.messageId).toBe(gmail.sends[0].outbound.messageId);
    expect(gmail.sends[0].outbound.messageId).toMatch(/^<[0-9a-f]{40}@acme\.test>$/);
  });

  it('a definite refusal is retried for real, without a lookup', async () => {
    const reply = input();
    gmail.next = [() => { throw new GmailError('gmail_provider_error', undefined, 'Gmail 400 @ x — invalid'); }];
    await expect(sendGmail({} as any, integration, reply, subject)).rejects.toBeTruthy();
    await sendGmail({} as any, integration, reply, subject);
    expect(gmail.sends).toHaveLength(2);
    expect(gmail.lookups).toEqual([]);
  });
});

describe('Gmail send endpoint by size', () => {
  it('a small reply goes as JSON raw, a large one to the upload endpoint as message/rfc822', async () => {
    const { createGmailAdapter, GMAIL_SIMPLE_SEND_BYTES } = await vi.importActual<typeof import('../../../channels/mail/gmail/client.js')>('../../../channels/mail/gmail/client.js');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'gm-1', threadId: 'th-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const ga = createGmailAdapter({ clientId: 'c', clientSecret: 's', redirectUri: 'r' }, { fetchImpl });
    const base = { from: { email: 'support@acme.test' }, to: [{ email: 'customer@example.test' }], subject: 'Hi', textBody: 'Hi' };

    await ga.sendMessage('token', base, 'th-1');
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ threadId: 'th-1', raw: expect.any(String) });

    await ga.sendMessage('token', {
      ...base,
      attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(GMAIL_SIMPLE_SEND_BYTES) }],
    }, 'th-1');
    expect(calls[1].url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart');
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    const body = String(calls[1].init.body);
    expect(body).toContain('{"threadId":"th-1"}');
    expect(body).toContain('Content-Type: message/rfc822');
    expect(body).toContain('filename="big.bin"');
  });
});
