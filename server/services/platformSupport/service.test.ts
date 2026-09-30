import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, fakeSupabase } from './testing/fakeSupabase.js';
import type { ServerConfig } from '../../config.js';
import type { PlatformSupportSettings } from './settings.js';

/**
 * Platform support end to end against an in-memory database: an operator's
 * chat arrives in the support workspace as a customer's would, is only ever
 * read back by that operator, ends and is rated, and the team's replies and
 * changes reach them.
 */

const state = vi.hoisted(() => ({
  client: null as ReturnType<typeof fakeSupabase> | null,
  settings: { enabled: true, workspaceId: 'ws-support', updatedAt: null } as PlatformSupportSettings,
  online: true,
  nextOpenAt: null as string | null,
}));

vi.mock('../../supabase.js', () => ({ getServiceClient: () => state.client }));
vi.mock('./settings.js', () => ({ loadPlatformSupportSettings: async () => state.settings }));
vi.mock('../widget/availability.js', () => ({
  resolveAvailability: vi.fn(async () => ({
    state: state.online ? 'online' : 'offline',
    next_open_at: state.online ? null : state.nextOpenAt,
  })),
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
vi.mock('../storage/index.js', () => ({
  uploadFile: vi.fn(async () => ({ success: true })),
  downloadFile: vi.fn(async () => ({ success: true, data: Buffer.from('file bytes') })),
}));
vi.mock('../storage/keys.js', () => ({
  chatAttachmentKey: ({ workspaceId, fileName }: { workspaceId: string; fileName: string }) =>
    `workspace/${workspaceId}/attachments/chat/2026/09/key-${fileName}`,
}));

import {
  attachmentFile,
  markRead,
  onTeamReply,
  rateConversation,
  sendAttachment,
  sendMessage,
  supportHistory,
  supportStatus,
  SupportError,
} from './service.js';
import { onSupportConversationChanged } from './changes.js';
import { notifyInboundMessage, notifySupportReply } from '../push/index.js';
import { publishSupportEvent } from '../realtime/publish.js';
import { uploadFile } from '../storage/index.js';

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

let clientSeq = 0;
const nextId = () => `client-${String(++clientSeq).padStart(4, '0')}`;

function say(
  userId: string,
  body: string,
  clientMessageId = nextId(),
  extra: Partial<{ sourceWorkspaceId: string; conversationId: string }> = {},
) {
  return sendMessage(config, userId, { body, clientMessageId, client: 'android', ...extra });
}

/** An agent's reply, as the inbox writes it. */
function teamSays(conversationId: string, body: string) {
  db.table('conversation_messages').push({
    id: `m-${Math.random().toString(36).slice(2, 10)}`,
    conversation_id: conversationId,
    sender_type: 'agent',
    sender_id: 'agent-1',
    body,
    created_at: db.now(),
    metadata: { source: 'inbox' },
  });
}

function setStatus(conversationId: string, status: string) {
  const row = db.table('conversations').find((c) => c.id === conversationId)!;
  row.status = status;
  row.updated_at = db.now();
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
  state.settings = { enabled: true, workspaceId: 'ws-support', updatedAt: null };
  state.online = true;
  state.nextOpenAt = null;
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

  it('says whether the team is online, names it, and is offered to the team too', async () => {
    const { userId } = operator();
    expect(await supportStatus(config, userId)).toEqual({
      enabled: true,
      available: true,
      online: true,
      teamName: 'Webyar Support',
      unread: 0,
      hours: null,
      nextOpenAt: null,
    });
    expect((await supportStatus(config, 'agent-1')).available).toBe(true);
  });

  it('while closed, gives the business hours and when it opens', async () => {
    const { userId } = operator();
    state.online = false;
    state.nextOpenAt = '2026-10-03T05:30:00.000Z';
    db.table('widget_settings').push({
      workspace_id: 'ws-support',
      business_hours: {
        enabled: true,
        timezone: 'Asia/Tehran',
        weekly: {
          sat: [{ from: '09:00', to: '17:00' }],
          thu: [{ from: '09:00', to: '13:00' }],
          fri: [],
          sun: [{ from: '25:00', to: 'x' }],
        },
      },
    });
    const status = await supportStatus(config, userId);
    expect(status.online).toBe(false);
    expect(status.nextOpenAt).toBe('2026-10-03T05:30:00.000Z');
    expect(status.hours).toEqual({
      timezone: 'Asia/Tehran',
      weekly: { sat: [{ from: '09:00', to: '17:00' }], thu: [{ from: '09:00', to: '13:00' }] },
    });
  });
});

describe('writing', () => {
  it('arrives in the support inbox as a customer conversation, from the app it was sent from', async () => {
    const { userId, workspaceId, email } = operator('Sara Ahmadi');
    const { conversation, item } = await say(userId, 'Salam, email connect nemishe', 'client-first', { sourceWorkspaceId: workspaceId });

    expect(item).toMatchObject({ kind: 'message', author: 'me', body: 'Salam, email connect nemishe', clientMessageId: 'client-first' });
    expect(conversation).toMatchObject({ status: 'open', canRate: false, rating: null });

    const [row] = db.table('conversations');
    expect(row.workspace_id).toBe('ws-support');
    expect(row.metadata).toMatchObject({ channel: 'platform_support', client_platform: 'android' });
    const [contact] = db.table('contacts');
    expect(contact).toMatchObject({ name: 'Sara Ahmadi', email, avatar_url: `https://cdn.example/${userId}.png` });
    expect(contact.metadata).toMatchObject({
      channel: 'platform_support',
      platform_user_id: userId,
      platform_workspace_id: workspaceId,
      platform_workspace_name: expect.stringMatching(/^Shop /),
      client_platform: 'android',
    });
    expect(row.contact_id).toBe(contact.id);
    expect(notifyInboundMessage).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ workspaceId: 'ws-support', channel: 'platform_support', senderName: 'Sara Ahmadi', actorId: userId }),
    );
  });

  it('is safe to retry: the same client id is the same message in the same conversation', async () => {
    const { userId } = operator();
    const first = await say(userId, 'one', 'client-retry');
    const again = await say(userId, 'one', 'client-retry');
    expect(again.item.id).toBe(first.item.id);
    expect(again.conversation.id).toBe(first.conversation.id);
    expect(db.table('conversation_messages')).toHaveLength(1);
    expect(db.table('conversations')).toHaveLength(1);
  });

  it('keeps writing to the open conversation, and starts a new one once it has ended', async () => {
    const { userId } = operator();
    const first = await say(userId, 'one');
    const second = await say(userId, 'two');
    expect(second.conversation.id).toBe(first.conversation.id);

    teamSays(first.conversation.id, 'Done.');
    setStatus(first.conversation.id, 'resolved');
    const third = await say(userId, 'three');
    expect(third.conversation.id).not.toBe(first.conversation.id);
    // The ended one was not reopened.
    expect(db.table('conversations').find((c) => c.id === first.conversation.id)!.status).toBe('resolved');

    const history = await supportHistory(config, userId);
    expect(history.conversations.map((c) => c.id)).toEqual([first.conversation.id, third.conversation.id]);
    expect(history.activeConversationId).toBe(third.conversation.id);
    expect(history.items.map((i) => i.body)).toEqual(['one', 'two', 'Done.', 'three']);
  });

  it('writes only to the conversation the app shows: once it has ended, the message is refused, not moved', async () => {
    const { userId } = operator();
    const first = await say(userId, 'one');
    const second = await say(userId, 'two', nextId(), { conversationId: first.conversation.id });
    expect(second.conversation.id).toBe(first.conversation.id);

    teamSays(first.conversation.id, 'Solved.');
    setStatus(first.conversation.id, 'resolved');
    await rejects(say(userId, 'three', nextId(), { conversationId: first.conversation.id }), 409, 'conversation_ended');
    expect(db.table('conversations')).toHaveLength(1);
    expect(db.table('conversation_messages').map((m) => m.body)).toEqual(['one', 'two', 'Solved.']);
    expect(db.table('conversations')[0].status).toBe('resolved');

    // Asked for a new conversation, the operator gets one.
    const fresh = await say(userId, 'three');
    expect(fresh.conversation.id).not.toBe(first.conversation.id);
    expect((await supportHistory(config, userId)).activeConversationId).toBe(fresh.conversation.id);
  });

  it('returns a message that landed before its conversation ended, when the app retries it', async () => {
    const { userId } = operator();
    const first = await say(userId, 'one');
    const sent = await say(userId, 'two', 'client-late', { conversationId: first.conversation.id });
    setStatus(first.conversation.id, 'closed');
    const again = await say(userId, 'two', 'client-late', { conversationId: first.conversation.id });
    expect(again.item.id).toBe(sent.item.id);
    expect(again.conversation.status).toBe('closed');
    expect(db.table('conversation_messages')).toHaveLength(2);
  });

  it('refuses a file for an ended conversation as it refuses a message', async () => {
    const { userId } = operator();
    const first = await say(userId, 'one');
    setStatus(first.conversation.id, 'resolved');
    await rejects(
      sendAttachment(config, userId, {
        fileName: 'a.png',
        mimeType: 'image/png',
        data: Buffer.from('png').toString('base64'),
        clientMessageId: nextId(),
        conversationId: first.conversation.id,
        client: 'android',
      }),
      409,
      'conversation_ended',
    );
    expect(db.table('conversation_attachments')).toHaveLength(0);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('never writes to somebody else\'s conversation', async () => {
    const sara = operator();
    const ali = operator('Ali Karimi');
    const hers = await say(sara.userId, 'mine');
    await rejects(say(ali.userId, 'hello', nextId(), { conversationId: hers.conversation.id }), 404, 'conversation_not_found');
    await rejects(say(ali.userId, 'hello', nextId(), { conversationId: 'not-a-uuid' }), 404, 'conversation_not_found');
    expect(db.table('conversation_messages').map((m) => m.body)).toEqual(['mine']);
  });

  it('treats a conversation left with the previous support team as ended', async () => {
    const { userId } = operator();
    const first = await say(userId, 'one');
    db.table('workspaces').push({ id: 'ws-support-2', name: 'New Support' });
    state.settings = { ...state.settings, workspaceId: 'ws-support-2' };
    expect((await supportHistory(config, userId)).activeConversationId).toBeNull();
    await rejects(say(userId, 'two', nextId(), { conversationId: first.conversation.id }), 409, 'conversation_ended');
    const fresh = await say(userId, 'two');
    expect(fresh.conversation.id).not.toBe(first.conversation.id);
    expect(db.table('conversations').find((c) => c.id === fresh.conversation.id)!.workspace_id).toBe('ws-support-2');
  });

  it('refuses an empty message', async () => {
    const { userId } = operator();
    await rejects(say(userId, '   '), 400, 'invalid_body');
  });

  it('is off when support is', async () => {
    const { userId } = operator();
    state.settings = { ...state.settings, enabled: false };
    await rejects(say(userId, 'hello'), 404, 'support_disabled');
  });
});

describe('history', () => {
  it('shows who joined, never an internal notice, and the team by name', async () => {
    const { userId } = operator();
    const { conversation } = await say(userId, 'help');
    const push = (sender_type: string, body: string, metadata: Record<string, unknown>) =>
      db.table('conversation_messages').push({
        id: `sys-${Math.random().toString(36).slice(2, 8)}`,
        conversation_id: conversation.id,
        sender_type,
        body,
        created_at: db.now(),
        metadata,
      });
    push('system', 'Reza joined the conversation.', { kind: 'routing_agent_joined', agent_name: 'Reza (Support)' });
    push('system', 'Ali unassigned this conversation', { kind: 'conversation_unassigned', internal: true });
    push('system', 'Ali transferred this conversation to Mina', { kind: 'conversation_transferred', to_name: 'Mina' });
    push('system', 'Rated 5/5', { kind: 'support_rating', internal: true, score: 5 });
    teamSays(conversation.id, 'On it!');

    const { items } = await supportHistory(config, userId);
    expect(items.map((i) => [i.kind, i.author, i.kind === 'joined' ? i.senderName : i.body])).toEqual([
      ['message', 'me', 'help'],
      ['joined', 'team', 'Reza (Support)'],
      ['joined', 'team', 'Mina'],
      ['message', 'team', 'On it!'],
    ]);
    expect(items[3].senderName).toBe('Reza (Support)');
  });

  it('counts what the team wrote until the operator reads it', async () => {
    const { userId } = operator();
    const { conversation } = await say(userId, 'help');
    teamSays(conversation.id, 'On it!');
    teamSays(conversation.id, 'Fixed.');
    expect((await supportStatus(config, userId)).unread).toBe(2);

    await markRead(config, userId);
    expect((await supportStatus(config, userId)).unread).toBe(0);
    expect(publishSupportEvent).toHaveBeenCalledWith(config, userId, expect.any(Array), expect.objectContaining({ kind: 'support_read' }));
  });

  it('is the operator\'s own and nobody else\'s', async () => {
    const sara = operator('Sara');
    const ali = operator('Ali');
    const { conversation, item } = await say(sara.userId, 'private');

    expect(await supportHistory(config, ali.userId)).toEqual({ conversations: [], items: [], activeConversationId: null });
    await rejects(rateConversation(config, ali.userId, conversation.id, { score: 5 }), 404, 'conversation_not_found');
    expect(item.author).toBe('me');
  });
});

describe('rating', () => {
  it('is offered once a conversation the team answered has ended, and taken once', async () => {
    const { userId } = operator();
    const { conversation } = await say(userId, 'help');
    await rejects(rateConversation(config, userId, conversation.id, { score: 5 }), 409, 'not_ratable');

    teamSays(conversation.id, 'Done.');
    setStatus(conversation.id, 'closed');
    expect((await supportHistory(config, userId)).conversations[0].canRate).toBe(true);

    await rejects(rateConversation(config, userId, conversation.id, { score: 6 }), 400, 'invalid_rating');
    const rated = await rateConversation(config, userId, conversation.id, { score: 4, comment: '  quick and kind  ' });
    expect(rated.conversation).toMatchObject({ canRate: false, rating: { score: 4, comment: 'quick and kind' } });
    await rejects(rateConversation(config, userId, conversation.id, { score: 5 }), 409, 'already_rated');

    // The team sees it in the conversation, the operator does not see it twice.
    const notice = db.table('conversation_messages').find((m) => (m.metadata as { kind?: string }).kind === 'support_rating')!;
    expect(notice).toMatchObject({ sender_type: 'system', body: 'Rated 4/5: quick and kind' });
    expect(notice.metadata).toMatchObject({ internal: true, score: 4, comment: 'quick and kind' });
    const { items, conversations } = await supportHistory(config, userId);
    expect(items.some((i) => i.body.startsWith('Rated'))).toBe(false);
    expect(conversations[0].rating?.score).toBe(4);
  });

  it('is not offered for a conversation nobody on the team answered', async () => {
    const { userId } = operator();
    const { conversation } = await say(userId, 'never mind');
    setStatus(conversation.id, 'resolved');
    expect((await supportHistory(config, userId)).conversations[0].canRate).toBe(false);
    await rejects(rateConversation(config, userId, conversation.id, { score: 3 }), 409, 'not_ratable');
  });
});

describe('files', () => {
  const png = (bytes: number) => Buffer.alloc(bytes, 1).toString('base64');

  it('takes a file up to 2 MB of the chat\'s types, and gives it back only to its owner', async () => {
    const { userId } = operator();
    const other = operator('Ali');
    const { conversation, item } = await sendAttachment(config, userId, {
      fileName: '../../screenshot.PNG',
      mimeType: 'image/png',
      data: png(1024),
      clientMessageId: 'file-0001',
      client: 'android',
    });
    expect(item.kind).toBe('message');
    expect(item.body).toBe('');
    expect(item.attachments).toEqual([
      expect.objectContaining({ fileName: 'screenshot.png', mimeType: 'image/png', sizeBytes: 1024, kind: 'image' }),
    ]);
    expect(uploadFile).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ workspaceId: 'ws-support', contentType: 'image/png' }),
    );
    const [row] = db.table('conversation_attachments');
    expect(row).toMatchObject({ conversation_id: conversation.id, message_id: item.id, status: 'attached', uploaded_by_type: 'contact' });

    const file = await attachmentFile(config, userId, item.attachments[0].id);
    expect(file.mimeType).toBe('image/png');
    expect(file.bytes.toString()).toBe('file bytes');
    await rejects(attachmentFile(config, other.userId, item.attachments[0].id), 404, 'attachment_not_found');

    // A retry stores nothing twice.
    const again = await sendAttachment(config, userId, {
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      data: png(1024),
      clientMessageId: 'file-0001',
      client: 'android',
    });
    expect(again.item.id).toBe(item.id);
    expect(db.table('conversation_attachments')).toHaveLength(1);
  });

  it('refuses a file over 2 MB, or of another type', async () => {
    const { userId } = operator();
    await rejects(
      sendAttachment(config, userId, { fileName: 'big.png', mimeType: 'image/png', data: png(2 * 1024 * 1024 + 1), clientMessageId: 'file-0002', client: 'android' }),
      413,
      'file_too_large',
    );
    await rejects(
      sendAttachment(config, userId, { fileName: 'a.exe', mimeType: 'application/x-msdownload', data: png(10), clientMessageId: 'file-0003', client: 'android' }),
      400,
      'file_type_not_allowed',
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('the team\'s side', () => {
  it('a reply reaches the operator on their own channels and as a push', async () => {
    const { userId, workspaceId } = operator();
    const { conversation } = await say(userId, 'Export fails', nextId(), { sourceWorkspaceId: workspaceId });

    await onTeamReply(config, {
      workspaceId: 'ws-support',
      conversationId: conversation.id,
      messageId: 'm-reply',
      body: 'Fixed, please try again.',
      hasAttachment: false,
      senderName: 'Reza',
    });

    expect(publishSupportEvent).toHaveBeenCalledWith(config, userId, [workspaceId], {
      kind: 'support_message',
      thread_id: conversation.id,
      message_id: 'm-reply',
    });
    expect(notifySupportReply).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ userId, workspaceId, threadId: conversation.id, senderName: 'Reza', text: 'Fixed, please try again.' }),
    );
  });

  it('a change in the inbox tells the operator\'s chat to read again', async () => {
    const { userId, workspaceId } = operator();
    const { conversation } = await say(userId, 'hi');
    vi.clearAllMocks();
    await onSupportConversationChanged(config, { workspaceId: 'ws-support', conversationId: conversation.id });
    expect(publishSupportEvent).toHaveBeenCalledWith(config, userId, [workspaceId], {
      kind: 'support_update',
      thread_id: conversation.id,
    });
  });

  it('ignores every other conversation', async () => {
    const { userId } = operator();
    const { conversation } = await say(userId, 'hi');
    vi.clearAllMocks();
    await onTeamReply(config, { workspaceId: 'ws-support', conversationId: 'some-other-conversation', messageId: 'm2', body: 'x', hasAttachment: false, senderName: null });
    await onTeamReply(config, { workspaceId: 'ws-elsewhere', conversationId: conversation.id, messageId: 'm3', body: 'x', hasAttachment: false, senderName: null });
    await onSupportConversationChanged(config, { workspaceId: 'ws-elsewhere', conversationId: conversation.id });
    expect(publishSupportEvent).not.toHaveBeenCalled();
    expect(notifySupportReply).not.toHaveBeenCalled();
  });
});
