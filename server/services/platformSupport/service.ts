/**
 * Platform support — an operator of any workspace talking to the team that
 * runs the platform.
 *
 * The team answers from an ordinary workspace (Super Admin → Core settings →
 * Support). Every thread is a conversation in that workspace's inbox, with
 * the operator as its contact — name, email and photo from their profile —
 * so the team works it exactly as it works a website chat: the same inbox,
 * assignment, canned replies, push and realtime. `metadata.channel` is
 * `platform_support`, which the inbox shows as "site user".
 *
 * The operator is NOT a member of that workspace. Everything they read or
 * write goes through `platform_support_threads`, keyed on their user id; the
 * team's replies reach them on their own realtime user channel, as a push,
 * and — for a ticket — by email.
 *
 *   chat    one live thread per operator while it is open, pending or
 *           resolved; a closed one starts a new thread.
 *   ticket  filed when nobody on the team is available: a subject, a
 *           number, a mail to the team, and a mail back on every reply.
 *
 * The HTTP shape is client-neutral (server/routes/platformSupport.ts): the
 * Android app uses it today, and the iOS, macOS, Windows and web apps can use
 * the same endpoints.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadPlatformSupportSettings, type PlatformSupportSettings } from './settings.js';
import {
  normalizeBody,
  normalizeClientMessageId,
  normalizeSubject,
  subjectFromBody,
  SlidingWindowLimiter,
} from './text.js';
import { sendTicketCreatedEmails, sendTicketReplyEmail } from './emails.js';
import { insertContactWithVisitorCode } from '../widget/visitorCode.js';
import { resolveAvailability } from '../widget/availability.js';
import { applyInboundConversationLifecycle } from '../conversationLifecycle.js';
import { recordConversationEvent } from '../conversationEvents.js';
import { buildMessageEnvelope, publishConversationEvent, publishSupportEvent } from '../realtime/publish.js';
import { notifyInboundMessage, notifySupportReply } from '../push/index.js';
import { createStorageUrlResolver } from '../storage/urlResolver.js';

export const SUPPORT_CHANNEL = 'platform_support';

/** Why a request cannot be served, as the HTTP layer reports it. */
export class SupportError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

// ─── Views ──────────────────────────────────────────────────────────

export interface SupportStatus {
  /** Super Admin has turned support on and chosen the answering workspace. */
  enabled: boolean;
  /** This operator may use it: false for the support team's own members. */
  available: boolean;
  /** Somebody on the team is available right now: chat, else a ticket. */
  online: boolean;
  ticketsEnabled: boolean;
  teamName: string | null;
}

export type SupportThreadKind = 'chat' | 'ticket';

export interface SupportThreadView {
  id: string;
  kind: SupportThreadKind;
  number: number;
  subject: string | null;
  /** open | pending | resolved | closed — the conversation's status. */
  status: string;
  createdAt: string;
  updatedAt: string;
  /** The team's messages the operator has not read yet. */
  unread: number;
  lastMessage: { body: string; fromTeam: boolean; createdAt: string } | null;
}

export interface SupportMessageView {
  id: string;
  body: string;
  /** `me`: the operator; `team`: a support agent (or the team's AI). */
  author: 'me' | 'team';
  senderName: string | null;
  senderAvatar: string | null;
  createdAt: string;
  clientMessageId: string | null;
  hasAttachment: boolean;
}

// ─── Limits ─────────────────────────────────────────────────────────

const messageLimiter = new SlidingWindowLimiter(30, 5 * 60_000);
const ticketLimiter = new SlidingWindowLimiter(5, 60 * 60_000);

const TEAM_SENDERS = ['agent', 'bot', 'ai'];
const VISIBLE_SENDERS = ['contact', ...TEAM_SENDERS];
const THREAD_LIST_LIMIT = 30;
const MESSAGE_PAGE_LIMIT = 200;

// ─── Context ────────────────────────────────────────────────────────

type ServiceClient = ReturnType<typeof getServiceClient>;

async function isMember(sb: ServiceClient, workspaceId: string, userId: string): Promise<boolean> {
  const { data, error } = await sb.rpc('is_workspace_member', { _workspace_id: workspaceId, _user_id: userId });
  if (error) throw new SupportError(500, 'membership_check_failed');
  return data === true;
}

async function workspaceName(sb: ServiceClient, workspaceId: string): Promise<string | null> {
  const { data } = await sb.from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
  return ((data as { name: string | null } | null)?.name || '').trim() || null;
}

/** The workspaces this operator belongs to, oldest membership first. */
async function memberWorkspaceIds(sb: ServiceClient, userId: string): Promise<string[]> {
  const { data } = await sb
    .from('workspace_members')
    .select('workspace_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(25);
  return ((data ?? []) as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
}

interface Context {
  settings: PlatformSupportSettings;
  supportWorkspaceId: string;
}

/**
 * Support is on and answered by a workspace. Every operator may use it, the
 * support team's own members included: Super Admin tries it from their own
 * account, and a colleague on the team can still ask it for help.
 */
async function requireContext(config: ServerConfig): Promise<Context> {
  const settings = await loadPlatformSupportSettings(config);
  if (!settings.enabled) throw new SupportError(404, 'support_disabled');
  if (!settings.workspaceId) throw new SupportError(404, 'support_not_configured');
  return { settings, supportWorkspaceId: settings.workspaceId };
}

export async function supportStatus(
  config: ServerConfig,
  userId: string,
  locale = 'en',
): Promise<SupportStatus> {
  const settings = await loadPlatformSupportSettings(config);
  const off: SupportStatus = { enabled: false, available: false, online: false, ticketsEnabled: false, teamName: null };
  if (!settings.enabled || !settings.workspaceId) return off;
  const teamName = await workspaceName(getServiceClient(config), settings.workspaceId);
  let online = false;
  try {
    // The website widget's own rule — business hours, and whether anybody
    // on the team is available — so the team is "online" in the app exactly
    // when it is online on its site.
    const snapshot = await resolveAvailability(config, { workspaceId: settings.workspaceId, locale });
    online = snapshot.state === 'online';
  } catch (err) {
    console.warn('[platform-support] availability failed:', err instanceof Error ? err.message : err);
  }
  return { enabled: true, available: true, online, ticketsEnabled: settings.ticketsEnabled, teamName };
}

// ─── The operator as the team's contact ─────────────────────────────

interface Requester {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  /** The workspace the operator wrote from, when they belong to it. */
  workspaceId: string | null;
  workspaceName: string | null;
}

async function loadRequester(
  config: ServerConfig,
  sb: ServiceClient,
  userId: string,
  sourceWorkspaceId: string | null,
): Promise<Requester> {
  const { data } = await sb
    .from('profiles')
    .select('id, full_name, email, avatar_storage_key')
    .eq('id', userId)
    .maybeSingle();
  const profile = data as { full_name: string | null; email: string | null; avatar_storage_key: string | null } | null;
  if (!profile) throw new SupportError(404, 'profile_not_found');
  const email = (profile.email || '').trim().toLowerCase() || null;
  const name = (profile.full_name || '').trim() || (email ? email.split('@')[0] : 'User');
  const avatarUrl = await createStorageUrlResolver(config).user(userId, profile.avatar_storage_key);

  let workspaceId: string | null = null;
  if (sourceWorkspaceId && (await isMember(sb, sourceWorkspaceId, userId))) {
    workspaceId = sourceWorkspaceId;
  } else {
    workspaceId = (await memberWorkspaceIds(sb, userId))[0] ?? null;
  }
  return {
    userId,
    name,
    email,
    avatarUrl,
    workspaceId,
    workspaceName: workspaceId ? await workspaceName(sb, workspaceId) : null,
  };
}

/**
 * The operator's contact in the support workspace: found by their user id,
 * else adopted by their email (someone who once wrote through the website
 * widget with the same address is the same person), else created. Name,
 * email and photo follow the profile.
 */
async function ensureRequesterContact(sb: ServiceClient, supportWorkspaceId: string, requester: Requester): Promise<string> {
  const identity = `${SUPPORT_CHANNEL}:${requester.userId}`;
  const supportMetadata = {
    source: SUPPORT_CHANNEL,
    channel: SUPPORT_CHANNEL,
    channel_identity: identity,
    platform_user_id: requester.userId,
    platform_workspace_id: requester.workspaceId,
    platform_workspace_name: requester.workspaceName,
    anonymous: false,
  };

  type ContactRow = {
    id: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    avatar_storage_key: string | null;
    metadata: Record<string, unknown> | null;
  };
  const columns = 'id, name, email, avatar_url, avatar_storage_key, metadata';

  const findByIdentity = async () =>
    (await sb
      .from('contacts')
      .select(columns)
      .eq('workspace_id', supportWorkspaceId)
      .contains('metadata', { channel_identity: identity })
      .limit(1)
      .maybeSingle()).data as ContactRow | null;
  const findByEmail = async () =>
    requester.email
      ? ((await sb
          .from('contacts')
          .select(columns)
          .eq('workspace_id', supportWorkspaceId)
          .eq('email', requester.email)
          .limit(1)
          .maybeSingle()).data as ContactRow | null)
      : null;

  const refresh = async (row: ContactRow) => {
    const prev = row.metadata || {};
    const patch: Record<string, unknown> = {};
    if (row.name !== requester.name) patch.name = requester.name;
    if (!row.email && requester.email) patch.email = requester.email;
    // A photo the team uploaded for this contact stays; otherwise the
    // profile's photo follows the operator.
    if (!row.avatar_storage_key && requester.avatarUrl && row.avatar_url !== requester.avatarUrl) {
      patch.avatar_url = requester.avatarUrl;
    }
    if (Object.entries(supportMetadata).some(([key, value]) => prev[key] !== value)) {
      patch.metadata = { ...prev, ...supportMetadata };
    }
    if (Object.keys(patch).length) await sb.from('contacts').update(patch).eq('id', row.id);
    return row.id;
  };

  const existing = (await findByIdentity()) ?? (await findByEmail());
  if (existing) return refresh(existing);

  const { data: created, error } = await insertContactWithVisitorCode(
    sb,
    (visitorCode) => ({
      workspace_id: supportWorkspaceId,
      name: requester.name,
      email: requester.email,
      avatar_url: requester.avatarUrl,
      visitor_code: visitorCode,
      metadata: supportMetadata,
    }),
    'id',
  );
  if (!error && created?.id) return created.id as string;
  // Lost a race with the operator's other device, or the email was taken
  // between the read and the insert: the row that won is theirs.
  const winner = (await findByIdentity()) ?? (await findByEmail());
  if (winner) return refresh(winner);
  console.error('[platform-support] contact creation failed:', error?.message);
  throw new SupportError(500, 'contact_failed');
}

// ─── Threads ────────────────────────────────────────────────────────

interface ThreadRow {
  conversation_id: string;
  support_workspace_id: string;
  user_id: string;
  source_workspace_id: string | null;
  kind: SupportThreadKind;
  number: number;
  subject: string | null;
  user_read_at: string | null;
  created_at: string;
}

const THREAD_COLUMNS =
  'conversation_id, support_workspace_id, user_id, source_workspace_id, kind, number, subject, user_read_at, created_at';

async function ownThread(sb: ServiceClient, userId: string, threadId: string): Promise<ThreadRow> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new SupportError(404, 'thread_not_found');
  const { data } = await sb
    .from('platform_support_threads')
    .select(THREAD_COLUMNS)
    .eq('conversation_id', threadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) throw new SupportError(404, 'thread_not_found');
  return data as ThreadRow;
}

async function threadView(sb: ServiceClient, thread: ThreadRow): Promise<SupportThreadView> {
  const [{ data: conv }, { data: last }, unread] = await Promise.all([
    sb.from('conversations').select('status, updated_at').eq('id', thread.conversation_id).maybeSingle(),
    sb
      .from('conversation_messages')
      .select('body, sender_type, created_at')
      .eq('conversation_id', thread.conversation_id)
      .in('sender_type', VISIBLE_SENDERS)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    unreadCount(sb, thread),
  ]);
  const conversation = conv as { status: string | null; updated_at: string | null } | null;
  const lastRow = last as { body: string | null; sender_type: string; created_at: string } | null;
  return {
    id: thread.conversation_id,
    kind: thread.kind,
    number: Number(thread.number),
    subject: thread.subject,
    status: conversation?.status || 'open',
    createdAt: thread.created_at,
    updatedAt: conversation?.updated_at || thread.created_at,
    unread,
    lastMessage: lastRow
      ? { body: lastRow.body || '', fromTeam: lastRow.sender_type !== 'contact', createdAt: lastRow.created_at }
      : null,
  };
}

async function unreadCount(sb: ServiceClient, thread: ThreadRow): Promise<number> {
  let query = sb
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', thread.conversation_id)
    .in('sender_type', TEAM_SENDERS);
  if (thread.user_read_at) query = query.gt('created_at', thread.user_read_at);
  const { count } = await query;
  return count ?? 0;
}

export async function listThreads(config: ServerConfig, userId: string): Promise<SupportThreadView[]> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('platform_support_threads')
    .select(THREAD_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(THREAD_LIST_LIMIT);
  const views = await Promise.all(((data ?? []) as ThreadRow[]).map((row) => threadView(sb, row)));
  return views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function threadMessages(
  config: ServerConfig,
  userId: string,
  threadId: string,
): Promise<{ thread: SupportThreadView; messages: SupportMessageView[] }> {
  const sb = getServiceClient(config);
  const thread = await ownThread(sb, userId, threadId);
  const { data } = await sb
    .from('conversation_messages')
    .select('id, body, sender_type, sender_id, created_at, metadata')
    .eq('conversation_id', thread.conversation_id)
    .in('sender_type', VISIBLE_SENDERS)
    .order('created_at', { ascending: false })
    .limit(MESSAGE_PAGE_LIMIT);
  const rows = ((data ?? []) as Array<{
    id: string;
    body: string | null;
    sender_type: string;
    sender_id: string | null;
    created_at: string;
    metadata: Record<string, unknown> | null;
  }>).reverse();

  // The team's names and photos, as the widget shows its operators.
  const agentIds = [...new Set(rows.filter((r) => r.sender_type === 'agent' && r.sender_id).map((r) => r.sender_id!))];
  const agents = new Map<string, { name: string | null; avatar: string | null }>();
  if (agentIds.length) {
    const resolver = createStorageUrlResolver(config);
    const { data: profiles } = await sb.from('profiles').select('id, full_name, avatar_storage_key').in('id', agentIds);
    for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; avatar_storage_key: string | null }>) {
      agents.set(p.id, { name: p.full_name || null, avatar: await resolver.user(p.id, p.avatar_storage_key) });
    }
  }

  const messages = rows.map((row): SupportMessageView => {
    const meta = row.metadata || {};
    const agent = row.sender_id ? agents.get(row.sender_id) : undefined;
    return {
      id: row.id,
      body: row.body || '',
      author: row.sender_type === 'contact' ? 'me' : 'team',
      senderName: row.sender_type === 'contact' ? null : agent?.name ?? null,
      senderAvatar: row.sender_type === 'contact' ? null : agent?.avatar ?? null,
      createdAt: row.created_at,
      clientMessageId: typeof meta.client_message_id === 'string' ? meta.client_message_id : null,
      hasAttachment: Boolean(meta.attachment_id || (Array.isArray(meta.attachments) && meta.attachments.length)),
    };
  });
  return { thread: await threadView(sb, thread), messages };
}

export async function markThreadRead(config: ServerConfig, userId: string, threadId: string): Promise<void> {
  const sb = getServiceClient(config);
  const thread = await ownThread(sb, userId, threadId);
  await sb
    .from('platform_support_threads')
    .update({ user_read_at: new Date().toISOString() })
    .eq('conversation_id', thread.conversation_id);
  void memberWorkspaceIds(sb, userId).then((workspaces) =>
    publishSupportEvent(config, userId, workspaces, { kind: 'support_read', thread_id: thread.conversation_id }),
  );
}

// ─── Writing ────────────────────────────────────────────────────────

interface WriteInput {
  body: unknown;
  clientMessageId: unknown;
  /** The workspace the operator is writing from, if the app knows it. */
  sourceWorkspaceId?: unknown;
}

function readWrite(input: WriteInput): { body: string; clientMessageId: string | null; sourceWorkspaceId: string | null } {
  const body = normalizeBody(input.body);
  if (!body) throw new SupportError(400, 'invalid_body');
  const source = typeof input.sourceWorkspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(input.sourceWorkspaceId)
    ? input.sourceWorkspaceId
    : null;
  return { body, clientMessageId: normalizeClientMessageId(input.clientMessageId), sourceWorkspaceId: source };
}

async function openConversation(
  sb: ServiceClient,
  input: {
    supportWorkspaceId: string;
    threadKey: string;
    contactId: string;
    subject: string;
    kind: SupportThreadKind;
    requester: Requester;
  },
): Promise<{ id: string; created: boolean }> {
  const { data, error } = await sb.rpc('ensure_active_conversation', {
    p_workspace_id: input.supportWorkspaceId,
    p_lock_key: input.threadKey,
    p_match_thread_key: input.threadKey,
    p_match_session_id: null,
    p_match_contact_id: null,
    p_contact_id: input.contactId,
    p_visitor_session_id: null,
    p_subject: input.subject,
    p_metadata: {
      channel: SUPPORT_CHANNEL,
      channel_thread_key: input.threadKey,
      platform_support_kind: input.kind,
      platform_user_id: input.requester.userId,
      platform_workspace_id: input.requester.workspaceId,
    },
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.id) {
    console.error('[platform-support] conversation failed:', error?.message || 'no row');
    throw new SupportError(500, 'conversation_failed');
  }
  return { id: row.id as string, created: Boolean(row.created) };
}

async function ensureThreadRow(
  sb: ServiceClient,
  input: {
    conversationId: string;
    supportWorkspaceId: string;
    requester: Requester;
    kind: SupportThreadKind;
    subject: string | null;
  },
): Promise<ThreadRow> {
  await sb.from('platform_support_threads').upsert(
    {
      conversation_id: input.conversationId,
      support_workspace_id: input.supportWorkspaceId,
      user_id: input.requester.userId,
      source_workspace_id: input.requester.workspaceId,
      kind: input.kind,
      subject: input.subject,
    },
    { onConflict: 'conversation_id', ignoreDuplicates: true },
  );
  const { data } = await sb
    .from('platform_support_threads')
    .select(THREAD_COLUMNS)
    .eq('conversation_id', input.conversationId)
    .maybeSingle();
  const row = data as ThreadRow | null;
  // A thread key names its operator, so a conversation it matched is theirs;
  // anything else is a broken invariant, not somebody else's thread to join.
  if (!row || row.user_id !== input.requester.userId) throw new SupportError(500, 'thread_failed');
  return row;
}

const MESSAGE_COLUMNS = 'id, conversation_id, sender_type, sender_id, body, created_at, metadata, seen_at';

/** The operator's message, delivered to the team as a customer's would be. */
async function postRequesterMessage(
  config: ServerConfig,
  sb: ServiceClient,
  input: {
    thread: ThreadRow;
    contactId: string | null;
    requester: Requester;
    body: string;
    clientMessageId: string | null;
  },
): Promise<SupportMessageView> {
  const conversationId = input.thread.conversation_id;
  const workspaceId = input.thread.support_workspace_id;
  type Row = {
    id: string;
    conversation_id: string;
    sender_type: 'contact';
    sender_id: string | null;
    body: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
    seen_at: string | null;
  };
  const findPrior = async () =>
    input.clientMessageId
      ? ((await sb
          .from('conversation_messages')
          .select(MESSAGE_COLUMNS)
          .eq('conversation_id', conversationId)
          .filter('metadata->>client_message_id', 'eq', input.clientMessageId)
          .maybeSingle()).data as Row | null)
      : null;

  let row = await findPrior();
  const duplicate = Boolean(row);
  if (!row) {
    const { data, error } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: conversationId,
        body: input.body,
        sender_type: 'contact',
        metadata: {
          source: SUPPORT_CHANNEL,
          channel: SUPPORT_CHANNEL,
          platform_user_id: input.requester.userId,
          ...(input.clientMessageId ? { client_message_id: input.clientMessageId } : {}),
        },
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error || !data) {
      row = /duplicate key|23505/i.test(error?.message || '') ? await findPrior() : null;
      if (!row) {
        console.error('[platform-support] message insert failed:', error?.message);
        throw new SupportError(500, 'message_failed');
      }
    } else {
      row = data as Row;
    }
  }

  if (!duplicate) {
    await applyInboundConversationLifecycle(config, {
      workspaceId,
      conversationId,
      source: SUPPORT_CHANNEL,
      message: { senderType: 'contact', direction: 'inbound', text: input.body, attachmentCount: 0 },
      messageId: row.id,
    }).catch((err) => console.warn('[platform-support] lifecycle failed:', err?.message ?? err));
    await sb.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    if (input.contactId) {
      await sb
        .from('conversations')
        .update({ contact_id: input.contactId })
        .eq('id', conversationId)
        .is('contact_id', null);
    }
    // Having written, the operator has seen everything before it.
    await sb
      .from('platform_support_threads')
      .update({ user_read_at: row.created_at })
      .eq('conversation_id', conversationId);

    void publishConversationEvent(
      config,
      workspaceId,
      conversationId,
      buildMessageEnvelope({ ...row, sender_name: input.requester.name, sender_avatar: input.requester.avatarUrl }),
    );
    void notifyInboundMessage(config, {
      workspaceId,
      conversationId,
      messageId: row.id,
      text: input.body,
      senderName: input.requester.name,
      channel: SUPPORT_CHANNEL,
      // A team member writing to support is not told about their own message.
      actorId: input.requester.userId,
    });
    // The operator's other devices.
    void memberWorkspaceIds(sb, input.requester.userId).then((workspaces) =>
      publishSupportEvent(config, input.requester.userId, workspaces, {
        kind: 'support_message',
        thread_id: conversationId,
        message_id: row!.id,
      }),
    );
  }

  return {
    id: row.id,
    body: row.body,
    author: 'me',
    senderName: null,
    senderAvatar: null,
    createdAt: row.created_at,
    clientMessageId: input.clientMessageId,
    hasAttachment: false,
  };
}

/** A message in the operator's live chat, which is opened on the first one. */
export async function sendChatMessage(
  config: ServerConfig,
  userId: string,
  input: WriteInput,
): Promise<{ thread: SupportThreadView; message: SupportMessageView }> {
  const sb = getServiceClient(config);
  const { body, clientMessageId, sourceWorkspaceId } = readWrite(input);
  const ctx = await requireContext(config);
  if (!messageLimiter.take(userId)) throw new SupportError(429, 'rate_limited');
  const requester = await loadRequester(config, sb, userId, sourceWorkspaceId);
  const contactId = await ensureRequesterContact(sb, ctx.supportWorkspaceId, requester);
  const conversation = await openConversation(sb, {
    supportWorkspaceId: ctx.supportWorkspaceId,
    threadKey: `${SUPPORT_CHANNEL}:chat:${userId}`,
    contactId,
    subject: subjectFromBody(body),
    kind: 'chat',
    requester,
  });
  const thread = await ensureThreadRow(sb, {
    conversationId: conversation.id,
    supportWorkspaceId: ctx.supportWorkspaceId,
    requester,
    kind: 'chat',
    subject: null,
  });
  if (conversation.created) {
    void recordConversationEvent(config, {
      workspaceId: ctx.supportWorkspaceId,
      conversationId: conversation.id,
      eventType: 'created',
      actorType: 'visitor',
      actorId: null,
      payload: { source: SUPPORT_CHANNEL, kind: 'chat' },
    });
  }
  const message = await postRequesterMessage(config, sb, { thread, contactId, requester, body, clientMessageId });
  return { thread: await threadView(sb, thread), message };
}

/** A ticket: filed with a subject when nobody on the team is available. */
export async function createTicket(
  config: ServerConfig,
  userId: string,
  input: WriteInput & { subject: unknown },
): Promise<{ thread: SupportThreadView; message: SupportMessageView }> {
  const sb = getServiceClient(config);
  const { body, clientMessageId, sourceWorkspaceId } = readWrite(input);
  const subject = normalizeSubject(input.subject);
  if (!subject) throw new SupportError(400, 'invalid_subject');
  const ctx = await requireContext(config);
  if (!ctx.settings.ticketsEnabled) throw new SupportError(403, 'tickets_disabled');
  if (!ticketLimiter.take(userId)) throw new SupportError(429, 'rate_limited');
  const requester = await loadRequester(config, sb, userId, sourceWorkspaceId);
  const contactId = await ensureRequesterContact(sb, ctx.supportWorkspaceId, requester);
  // The client's id makes a retried submit the same ticket, not a second one.
  const threadKey = `${SUPPORT_CHANNEL}:ticket:${userId}:${clientMessageId ?? randomUUID()}`;
  const conversation = await openConversation(sb, {
    supportWorkspaceId: ctx.supportWorkspaceId,
    threadKey,
    contactId,
    subject,
    kind: 'ticket',
    requester,
  });
  const thread = await ensureThreadRow(sb, {
    conversationId: conversation.id,
    supportWorkspaceId: ctx.supportWorkspaceId,
    requester,
    kind: 'ticket',
    subject,
  });
  if (conversation.created) {
    await sb.from('conversations').update({ tags: ['ticket'] }).eq('id', conversation.id);
    void recordConversationEvent(config, {
      workspaceId: ctx.supportWorkspaceId,
      conversationId: conversation.id,
      eventType: 'created',
      actorType: 'visitor',
      actorId: null,
      payload: { source: SUPPORT_CHANNEL, kind: 'ticket', number: thread.number },
    });
  }
  const message = await postRequesterMessage(config, sb, { thread, contactId, requester, body, clientMessageId });
  if (conversation.created) {
    void sendTicketCreatedEmails(config, {
      supportWorkspaceId: ctx.supportWorkspaceId,
      conversationId: conversation.id,
      number: Number(thread.number),
      subject,
      body,
      requesterName: requester.name,
      requesterEmail: requester.email,
      workspaceName: requester.workspaceName,
      extraEmails: ctx.settings.notifyEmails,
    });
  }
  return { thread: await threadView(sb, thread), message };
}

/** A follow-up in one of the operator's threads, chat or ticket. */
export async function replyInThread(
  config: ServerConfig,
  userId: string,
  threadId: string,
  input: WriteInput,
): Promise<{ thread: SupportThreadView; message: SupportMessageView }> {
  const sb = getServiceClient(config);
  const { body, clientMessageId } = readWrite(input);
  const thread = await ownThread(sb, userId, threadId);
  const { data: conv } = await sb.from('conversations').select('status').eq('id', thread.conversation_id).maybeSingle();
  if ((conv as { status: string | null } | null)?.status === 'closed') throw new SupportError(409, 'thread_closed');
  if (!messageLimiter.take(userId)) throw new SupportError(429, 'rate_limited');
  const requester = await loadRequester(config, sb, userId, thread.source_workspace_id);
  // The contact is refreshed on a follow-up too: a new photo or name shows
  // up in the team's inbox with the operator's next message.
  const contactId = await ensureRequesterContact(sb, thread.support_workspace_id, requester).catch(() => null);
  const message = await postRequesterMessage(config, sb, { thread, contactId, requester, body, clientMessageId });
  return { thread: await threadView(sb, thread), message };
}

// ─── The team's replies ─────────────────────────────────────────────

/**
 * An agent answered in the support workspace's inbox: tell the operator.
 *
 * Called by the inbox's send route after every agent message; a
 * conversation that is not a support thread costs one primary-key read and
 * returns. Best effort and never throws — the reply is already saved.
 */
export async function onTeamReply(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    body: string;
    hasAttachment: boolean;
    senderName: string | null;
  },
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_support_threads')
      .select(THREAD_COLUMNS)
      .eq('conversation_id', input.conversationId)
      .maybeSingle();
    const thread = data as ThreadRow | null;
    if (!thread || thread.support_workspace_id !== input.workspaceId) return;

    const workspaces = await memberWorkspaceIds(sb, thread.user_id);
    await publishSupportEvent(config, thread.user_id, workspaces, {
      kind: 'support_message',
      thread_id: thread.conversation_id,
      message_id: input.messageId,
    });

    const pushWorkspace =
      thread.source_workspace_id && workspaces.includes(thread.source_workspace_id)
        ? thread.source_workspace_id
        : workspaces[0];
    const text = input.body.trim() || (input.hasAttachment ? '📎' : '');
    if (pushWorkspace) {
      void notifySupportReply(config, {
        userId: thread.user_id,
        workspaceId: pushWorkspace,
        threadId: thread.conversation_id,
        messageId: input.messageId,
        senderName: input.senderName,
        text,
      });
    }
    if (thread.kind === 'ticket' && text) {
      void sendTicketReplyEmail(config, {
        supportWorkspaceId: thread.support_workspace_id,
        userId: thread.user_id,
        number: Number(thread.number),
        subject: thread.subject,
        reply: text,
        agentName: input.senderName,
      });
    }
  } catch (err) {
    console.warn('[platform-support] reply delivery failed:', err instanceof Error ? err.message : err);
  }
}
