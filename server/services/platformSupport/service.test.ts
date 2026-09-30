import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, fakeSupabase } from './testing/fakeSupabase.js';
import type { ServerConfig } from '../../config.js';
import type { PlatformSupportSettings } from './settings.js';

/**
 * Platform support end to end against an in-memory database: an operator's
 * chat and tickets arrive in the support workspace as a customer's would,
 * only ever read back by that operator, and the team's replies reach them.
 */

const state = vi.hoisted(() => ({
  client: null as ReturnType<typeof fakeSupabase> | null,
  settings: {
    enabled: true,
    workspaceId: 'ws-support',
    ticketsEnabled: true,
    notifyEmails: ['ops@platform.example'],
    updatedAt: null,
  } as PlatformSupportSettings,
  online: true,
}));

vi.mock('../../supabase.js', () => ({ getServiceClient: () => state.client }));
vi.mock('./settings.js', () => ({ loadPlatformSupportSettings: async () => state.settings }));
vi.mock('./emails.js', () => ({ sendTicketCreatedEmails: vi.fn(), sendTicketReplyEmail: vi.fn() }));
vi.mock('../widget/availability.js', () => ({
  resolveAvailability: vi.fn(async () => ({ state: state.online ? 'online' : 'offline' })),
}));
vi.mock('../conversationLifecycle.js', () => ({
  applyInboundConversationLifecycle: vi.fn(async () => ({ transition: 'none', reason: 'test' })),
}));
vi.mock('../conversationEvents.js', () => ({ recordConversationEvent: vi.fn(async () => ({ ok: true })) }));
vi.mock('../realtime/publish.js', () => ({
  buildMessageEnvelope: (row: unknown) => ({ type: 'message', payload: row }),
  publishConversationEvent: vi.fn(async () => ({ ok: true })),
  publishSupportEvent: vi.fn(async () => undefined),
}));
vi.mock('../push/index.js', () => ({ notifyInboundMessage: vi.fn(), notifySupportReply: vi.fn() }));
vi.mock('../storage/urlResolver.js', () => ({
  createStorageUrlResolver: () => ({
    user: async (id: string, key: string | null) => (key ? `https://cdn.example/${id}.png` : null),
  }),
}));

import {
  createTicket,
  listThreads,
  markThreadRead,
  onTeamReply,
  replyInThread,
  sendChatMessage,
  supportStatus,
  SupportError,
  threadMessages,
} from './service.js';
import { sendTicketCreatedEmails, sendTicketReplyEmail } from './emails.js';
import { notifyInboundMessage, notifySupportReply } from '../push/index.js';
import { publishSupportEvent } from '../realtime/publish.js';

const config = {} as ServerConfig;
let db: FakeDb;
let seq = 0;

/** A fresh operator in a customer workspace, with a profile photo. */
function operator(name = 'Sara Ahmadi', email = `sara${++seq}@customer.example`) {
  const userId = `user-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `ws-customer-${seq}`;
  db.table('profiles').push({ id: userId, full_name: name, email, avatar_storage_key: `users/${userId}/avatar/a.png` });
  db.table('workspaces').push({ id: workspaceId, name: `Shop ${seq}` });
  db.table('workspace_members').push({ workspace_id: workspaceId, user_id: userId, role: 'owner', created_at: db.now() });
  return { userId, workspaceId, email };
}

async function rejects(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(SupportError);
  expect(err.status).toBe(status);
  expect(err.code).toBe(code);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  state.client = fakeSupabase(db);
  state.settings = { ...state.settings, enabled: true, workspaceId: 'ws-support', ticketsEnabled: true };
  state.online = true;
  db.table('workspaces').push({ id: 'ws-support', name: 'Webyar Support' });
  db.table('profiles').push({ id: 'agent-1', full_name: 'Reza (Support)', email: 'reza@platform.example', avatar_storage_key: null });
  db.table('workspace_members').push({ workspace_id: 'ws-support', user_id: 'agent-1', role: 'owner', created_at: db.now() });
});

describe('status', () => {
  it('is off until Super Admin turns it on and names a workspace', async () => {
    const { userId } = operator();
    state.settings = { ...state.settings, enabled: false };
    expect((await supportStatus(config, userId)).enabled).toBe(false);
    state.settings = { ...state.settings, enabled: true, workspaceId: null };
    expect((await supportStatus(config, userId)).enabled).toBe(false);
  });

  it('says whether the team is online, and names it', async () => {
    const { userId } = operator();
    expect(await supportStatus(config, userId)).toEqual({
      enabled: true,
      available: true,
      online: true,
      ticketsEnabled: true,
      teamName: 'Webyar Support',
    });
    state.online = false;
    expect((await supportStatus(config, userId)).online).toBe(false);
  });

  it('is not offered to the support team itself', async () => {
    const status = await supportStatus(config, 'agent-1');
    expect(status.available).toBe(false);
    await rejects(sendChatMessage(config, 'agent-1', { body: 'hi', clientMessageId: 'c-00000001' }), 409, 'support_member');
  });
});

describe('chat', () => {
  it('arrives in the support inbox as a customer conversation with the operator as its contact', async () => {
    const { userId, workspaceId, email } = operator('Sara Ahmadi');
    const { thread, message } = await sendChatMessage(config, userId, {
      body: '  Hello, the widget does not load  ',
      clientMessageId: 'client-0001',
      sourceWorkspaceId: workspaceId,
    });

    expect(thread.kind).toBe('chat');
    expect(message).toMatchObject({ author: 'me', body: 'Hello, the widget does not load' });

    const [conversation] = db.table('conversations');
    expect(conversation.workspace_id).toBe('ws-support');
    expect(conversation.metadata).toMatchObject({ channel: 'platform_support' });

    const [contact] = db.table('contacts');
    expect(contact).toMatchObject({ workspace_id: 'ws-support', name: 'Sara Ahmadi', email });
    expect(contact.avatar_url).toBe(`https://cdn.example/${userId}.png`);
    expect(contact.metadata).toMatchObject({
      channel: 'platform_support',
      platform_user_id: userId,
      platform_workspace_id: workspaceId,
      platform_workspace_name: expect.stringMatching(/^Shop /),
    });
    expect(conversation.contact_id).toBe(contact.id);

    expect(notifyInboundMessage).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ workspaceId: 'ws-support', channel: 'platform_support', senderName: 'Sara Ahmadi' }),
    );
  });

  it('keeps one live thread per operator, and a retried send is not a second message', async () => {
    const { userId } = operator();
    const first = await sendChatMessage(config, userId, { body: 'one', clientMessageId: 'client-0002' });
    const again = await sendChatMessage(config, userId, { body: 'one', clientMessageId: 'client-0002' });
    const second = await sendChatMessage(config, userId, { body: 'two', clientMessageId: 'client-0003' });

    expect(again.message.id).toBe(first.message.id);
    expect(second.thread.id).toBe(first.thread.id);
    expect(db.table('conversation_messages')).toHaveLength(2);
    expect(db.table('platform_support_threads')).toHaveLength(1);
    expect(notifyInboundMessage).toHaveBeenCalledTimes(2);
  });

  it('starts a new thread once the old one is closed', async () => {
    const { userId } = operator();
    const first = await sendChatMessage(config, userId, { body: 'one', clientMessageId: 'client-0004' });
    db.table('conversations').find((c) => c.id === first.thread.id)!.status = 'closed';
    await rejects(replyInThread(config, userId, first.thread.id, { body: 'still there?', clientMessageId: 'client-0005' }), 409, 'thread_closed');
    const next = await sendChatMessage(config, userId, { body: 'new question', clientMessageId: 'client-0006' });
    expect(next.thread.id).not.toBe(first.thread.id);
  });

  it('adopts the contact who once wrote with the same email through the website widget', async () => {
    const { userId, email } = operator();
    db.table('contacts').push({ id: 'widget-contact', workspace_id: 'ws-support', name: 'Visitor', email, metadata: { source: 'widget' } });
    await sendChatMessage(config, userId, { body: 'hi', clientMessageId: 'client-0007' });
    expect(db.table('contacts')).toHaveLength(1);
    expect(db.table('contacts')[0].metadata).toMatchObject({ source: 'platform_support', platform_user_id: userId });
  });

  it('refuses an empty message', async () => {
    const { userId } = operator();
    await rejects(sendChatMessage(config, userId, { body: '   ', clientMessageId: 'client-0008' }), 400, 'invalid_body');
  });
});

describe('tickets', () => {
  it('files a numbered ticket, tags it and mails the team once', async () => {
    const { userId, workspaceId } = operator('Ali Karimi');
    state.online = false;
    const input = { subject: 'Invoice question', body: 'Why was I charged twice?', clientMessageId: 'ticket-0001', sourceWorkspaceId: workspaceId };
    const { thread } = await createTicket(config, userId, input);
    const retried = await createTicket(config, userId, input);

    expect(thread).toMatchObject({ kind: 'ticket', subject: 'Invoice question' });
    expect(thread.number).toBeGreaterThan(0);
    expect(retried.thread.id).toBe(thread.id);
    const conversation = db.table('conversations').find((c) => c.id === thread.id)!;
    expect(conversation.tags).toEqual(['ticket']);
    expect(conversation.subject).toBe('Invoice question');
    expect(sendTicketCreatedEmails).toHaveBeenCalledTimes(1);
    expect(sendTicketCreatedEmails).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        supportWorkspaceId: 'ws-support',
        subject: 'Invoice question',
        requesterName: 'Ali Karimi',
        extraEmails: ['ops@platform.example'],
      }),
    );
  });

  it('needs a subject, and can be switched off', async () => {
    const { userId } = operator();
    await rejects(createTicket(config, userId, { subject: ' ', body: 'x', clientMessageId: 'ticket-0002' }), 400, 'invalid_subject');
    state.settings = { ...state.settings, ticketsEnabled: false };
    await rejects(createTicket(config, userId, { subject: 'S', body: 'x', clientMessageId: 'ticket-0003' }), 403, 'tickets_disabled');
  });
});

describe('reading', () => {
  it('shows an operator only their own threads', async () => {
    const sara = operator();
    const ali = operator();
    const { thread } = await sendChatMessage(config, sara.userId, { body: 'private', clientMessageId: 'client-0010' });

    expect(await listThreads(config, ali.userId)).toEqual([]);
    await rejects(threadMessages(config, ali.userId, thread.id), 404, 'thread_not_found');
    await rejects(replyInThread(config, ali.userId, thread.id, { body: 'x', clientMessageId: 'client-0011' }), 404, 'thread_not_found');
    await rejects(markThreadRead(config, ali.userId, thread.id), 404, 'thread_not_found');
  });

  it('names the agent who answered, counts it unread until read, and hides no reply', async () => {
    const { userId } = operator();
    const { thread } = await sendChatMessage(config, userId, { body: 'help', clientMessageId: 'client-0012' });
    db.table('conversation_messages').push(
      db.withDefaults('conversation_messages', {
        conversation_id: thread.id,
        sender_type: 'agent',
        sender_id: 'agent-1',
        body: 'On it!',
        metadata: { source: 'inbox' },
      }),
    );

    const [listed] = await listThreads(config, userId);
    expect(listed.unread).toBe(1);
    expect(listed.lastMessage).toMatchObject({ body: 'On it!', fromTeam: true });

    const { messages } = await threadMessages(config, userId, thread.id);
    expect(messages.map((m) => [m.author, m.body])).toEqual([['me', 'help'], ['team', 'On it!']]);
    expect(messages[1].senderName).toBe('Reza (Support)');

    await markThreadRead(config, userId, thread.id);
    expect((await listThreads(config, userId))[0].unread).toBe(0);
  });
});

describe('the team replies', () => {
  it('reaches the operator on their own channels and as a push, and a ticket reply by email', async () => {
    const { userId, workspaceId } = operator();
    const { thread } = await createTicket(config, userId, {
      subject: 'Export fails',
      body: 'CSV export times out',
      clientMessageId: 'ticket-0004',
      sourceWorkspaceId: workspaceId,
    });

    await onTeamReply(config, {
      workspaceId: 'ws-support',
      conversationId: thread.id,
      messageId: 'm-reply',
      body: 'Fixed, please try again.',
      hasAttachment: false,
      senderName: 'Reza',
    });

    expect(publishSupportEvent).toHaveBeenCalledWith(config, userId, [workspaceId], {
      kind: 'support_message',
      thread_id: thread.id,
      message_id: 'm-reply',
    });
    expect(notifySupportReply).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ userId, workspaceId, threadId: thread.id, senderName: 'Reza', text: 'Fixed, please try again.' }),
    );
    expect(sendTicketReplyEmail).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ userId, subject: 'Export fails', reply: 'Fixed, please try again.', agentName: 'Reza' }),
    );
  });

  it('does not mail a chat reply, and ignores every other conversation', async () => {
    const { userId } = operator();
    const { thread } = await sendChatMessage(config, userId, { body: 'hi', clientMessageId: 'client-0013' });
    await onTeamReply(config, { workspaceId: 'ws-support', conversationId: thread.id, messageId: 'm1', body: 'Hello!', hasAttachment: false, senderName: null });
    expect(notifySupportReply).toHaveBeenCalledTimes(1);
    expect(sendTicketReplyEmail).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await onTeamReply(config, { workspaceId: 'ws-support', conversationId: 'some-other-conversation', messageId: 'm2', body: 'x', hasAttachment: false, senderName: null });
    await onTeamReply(config, { workspaceId: 'ws-elsewhere', conversationId: thread.id, messageId: 'm3', body: 'x', hasAttachment: false, senderName: null });
    expect(publishSupportEvent).not.toHaveBeenCalled();
    expect(notifySupportReply).not.toHaveBeenCalled();
  });
});
