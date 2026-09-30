/**
 * Platform support — an operator of any workspace talking to the team that
 * runs the platform (docs/PLATFORM_SUPPORT.md).
 *
 * The team answers from an ordinary workspace (Super Admin → Core settings →
 * Support). Every conversation is one in that workspace's inbox, with the
 * operator as its contact — name, email and photo from their profile — so
 * the team works it exactly as it works a website chat: the same inbox,
 * assignment, canned replies, push and realtime. `metadata.channel` is
 * `platform_support`, which the inbox shows as "Site user · ‹app›".
 *
 * The operator sees one chat: every conversation they have had, and the
 * current one. A message goes to the newest conversation that is open or
 * pending; when there is none, it starts a new one. A resolved or closed
 * conversation is never reopened from the operator's side — it can be
 * rated instead.
 *
 * Everything the operator reads or writes goes through
 * `platform_support_threads`, keyed on their user id, never through the
 * support workspace's membership. The team's replies reach them on their own
 * realtime user channel and as a push.
 *
 * The HTTP shape is client-neutral (server/routes/platformSupport.ts): the
 * Android app uses it today, and the iOS, macOS, Windows and web apps can use
 * the same endpoints.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadPlatformSupportSettings } from './settings.js';
import {
  ALLOWED_FILE_TYPES,
  MAX_FILE_BYTES,
  attachmentKind,
  normalizeBody,
  normalizeClientMessageId,
  normalizeRatingComment,
  normalizeScore,
  subjectFromBody,
  supportFileName,
  SlidingWindowLimiter,
  type ClientPlatform,
} from './text.js';
import { insertContactWithVisitorCode } from '../widget/visitorCode.js';
import { resolveAvailability } from '../widget/availability.js';
import { applyInboundConversationLifecycle } from '../conversationLifecycle.js';
import { recordConversationEvent } from '../conversationEvents.js';
import { buildMessageEnvelope, publishConversationEvent, publishSupportEvent } from '../realtime/publish.js';
import { notifyInboundMessage, notifySupportReply } from '../push/index.js';
import { createStorageUrlResolver } from '../storage/urlResolver.js';
import { downloadFile, uploadFile } from '../storage/index.js';
import { chatAttachmentKey } from '../storage/keys.js';

export const SUPPORT_CHANNEL = 'platform_support';

/** Why a request cannot be served, as the HTTP layer reports it. */
export class SupportError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

// ─── Views ──────────────────────────────────────────────────────────

export interface BusinessHoursView {
  timezone: string;
  /** Day keys as the widget stores them (`sat`…`fri`); an absent day is closed. */
  weekly: Record<string, Array<{ from: string; to: string }>>;
}

export interface SupportStatus {
  /** Super Admin has turned support on and chosen the answering workspace. */
  enabled: boolean;
  /** This operator may use it. */
  available: boolean;
  /** Somebody on the team is reachable right now; otherwise "leave a message". */
  online: boolean;
  teamName: string | null;
  /** The team's messages the operator has not read yet, across conversations. */
  unread: number;
  /** The support workspace's business hours; null when it keeps none. */
  hours: BusinessHoursView | null;
  /** While closed by the hours: when it opens next. */
  nextOpenAt: string | null;
}

export interface SupportRatingView {
  score: number;
  comment: string | null;
  ratedAt: string;
}

export interface SupportConversationView {
  id: string;
  /** open | pending | resolved | closed — the conversation's status. */
  status: string;
  createdAt: string;
  /** When it was resolved or closed. */
  endedAt: string | null;
  rating: SupportRatingView | null;
  /** Ended, answered by the team, and not rated yet. */
  canRate: boolean;
}

export interface SupportAttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'audio' | 'video' | 'file';
}

export interface SupportItemView {
  id: string;
  conversationId: string;
  /** `message`, or `joined`: somebody on the team took the conversation. */
  kind: 'message' | 'joined';
  /** `me`: the operator; `team`: a support agent, the team's AI, or a join. */
  author: 'me' | 'team';
  body: string;
  senderName: string | null;
  senderAvatar: string | null;
  createdAt: string;
  clientMessageId: string | null;
  attachments: SupportAttachmentView[];
}

export interface SupportHistory {
  conversations: SupportConversationView[];
  items: SupportItemView[];
  activeConversationId: string | null;
}

// ─── Limits ─────────────────────────────────────────────────────────

const writeLimiter = new SlidingWindowLimiter(30, 5 * 60_000);

const TEAM_SENDERS = ['agent', 'bot', 'ai'];
const MESSAGE_SENDERS = ['contact', ...TEAM_SENDERS];
/** The inbox's notices that mean "somebody on the team took it" (conversations.ts, chatRouting.ts). */
const JOIN_KINDS = new Set(['routing_agent_joined', 'conversation_transferred']);
const ACTIVE_STATUSES = new Set(['open', 'pending']);
const ENDED_STATUSES = new Set(['resolved', 'closed']);
const CONVERSATION_LIMIT = 20;
const ITEM_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Support is on and answered by a workspace. Every operator may use it, the
 * support team's own members included: Super Admin tries it from their own
 * account, and a colleague on the team can still ask it for help.
 */
async function requireSupportWorkspace(config: ServerConfig): Promise<string> {
  const settings = await loadPlatformSupportSettings(config);
  if (!settings.enabled) throw new SupportError(404, 'support_disabled');
  if (!settings.workspaceId) throw new SupportError(404, 'support_not_configured');
  return settings.workspaceId;
}

// ─── Status ─────────────────────────────────────────────────────────

type WidgetHoursRow = {
  business_hours?: { enabled?: boolean; timezone?: unknown; weekly?: Record<string, unknown> | null } | null;
  [column: string]: unknown;
};

const DAY_KEYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The widget's weekly hours, read defensively: the dashboard edits that JSON. */
export function businessHoursView(row: WidgetHoursRow | null): BusinessHoursView | null {
  const bh = row?.business_hours;
  if (!bh?.enabled) return null;
  const weekly: BusinessHoursView['weekly'] = {};
  for (const day of DAY_KEYS) {
    const raw = bh.weekly?.[day];
    if (!Array.isArray(raw)) continue;
    const intervals = raw
      .map((entry) => entry as { from?: unknown; to?: unknown })
      .filter((entry) => typeof entry.from === 'string' && typeof entry.to === 'string')
      .map((entry) => ({ from: entry.from as string, to: entry.to as string }))
      .filter((entry) => HHMM.test(entry.from) && HHMM.test(entry.to));
    if (intervals.length) weekly[day] = intervals;
  }
  return { timezone: (typeof bh.timezone === 'string' && bh.timezone) || 'UTC', weekly };
}

export async function supportStatus(
  config: ServerConfig,
  userId: string,
  locale = 'en',
): Promise<SupportStatus> {
  const settings = await loadPlatformSupportSettings(config);
  const off: SupportStatus = {
    enabled: false,
    available: false,
    online: false,
    teamName: null,
    unread: 0,
    hours: null,
    nextOpenAt: null,
  };
  if (!settings.enabled || !settings.workspaceId) return off;
  const sb = getServiceClient(config);
  const [teamName, unread, widgetRow] = await Promise.all([
    workspaceName(sb, settings.workspaceId),
    unreadCount(sb, userId),
    sb
      .from('widget_settings')
      .select('business_hours, offline_mode, availability_labels, offline_message, offline_message_localized, live_chat_enabled')
      .eq('workspace_id', settings.workspaceId)
      .maybeSingle()
      .then(({ data }) => (data ?? null) as WidgetHoursRow | null),
  ]);
  let online = false;
  let nextOpenAt: string | null = null;
  try {
    // The website widget's own rule — business hours, and whether anybody
    // on the team is available — so the team is "online" in the app exactly
    // when it is online on its site.
    const snapshot = await resolveAvailability(config, {
      workspaceId: settings.workspaceId,
      locale,
      settingsRow: widgetRow as Parameters<typeof resolveAvailability>[1]['settingsRow'],
    });
    online = snapshot.state === 'online';
    nextOpenAt = online ? null : snapshot.next_open_at;
  } catch (err) {
    console.warn('[platform-support] availability failed:', err instanceof Error ? err.message : err);
  }
  return {
    enabled: true,
    available: true,
    online,
    teamName,
    unread,
    hours: businessHoursView(widgetRow),
    nextOpenAt,
  };
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
  client: ClientPlatform;
}

async function loadRequester(
  config: ServerConfig,
  sb: ServiceClient,
  userId: string,
  sourceWorkspaceId: string | null,
  client: ClientPlatform,
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
    client,
  };
}

/**
 * The operator's contact in the support workspace: found by their user id,
 * else adopted by their email (someone who once wrote through the website
 * widget with the same address is the same person), else created. Name,
 * email, photo and the app they last wrote from follow them.
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
    client_platform: requester.client,
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

// ─── Conversations ──────────────────────────────────────────────────

interface ThreadRow {
  conversation_id: string;
  support_workspace_id: string;
  user_id: string;
  source_workspace_id: string | null;
  user_read_at: string | null;
  rating: number | null;
  rating_comment: string | null;
  rated_at: string | null;
  created_at: string;
}

const THREAD_COLUMNS =
  'conversation_id, support_workspace_id, user_id, source_workspace_id, user_read_at, rating, rating_comment, rated_at, created_at';

interface ConversationRow {
  id: string;
  status: string | null;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
}

/** The operator's conversations, newest first. */
async function recentThreads(sb: ServiceClient, userId: string): Promise<ThreadRow[]> {
  const { data } = await sb
    .from('platform_support_threads')
    .select(THREAD_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(CONVERSATION_LIMIT);
  return (data ?? []) as ThreadRow[];
}

async function conversationsById(sb: ServiceClient, ids: string[]): Promise<Map<string, ConversationRow>> {
  if (!ids.length) return new Map();
  const { data } = await sb.from('conversations').select('id, status, created_at, updated_at, metadata').in('id', ids);
  return new Map(((data ?? []) as ConversationRow[]).map((row) => [row.id, row]));
}

async function ownThread(sb: ServiceClient, userId: string, conversationId: string): Promise<ThreadRow> {
  if (!UUID.test(conversationId)) throw new SupportError(404, 'conversation_not_found');
  const { data } = await sb
    .from('platform_support_threads')
    .select(THREAD_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) throw new SupportError(404, 'conversation_not_found');
  return data as ThreadRow;
}

function conversationView(thread: ThreadRow, conv: ConversationRow | undefined, teamAnswered: boolean): SupportConversationView {
  const status = conv?.status || 'open';
  const ended = ENDED_STATUSES.has(status);
  return {
    id: thread.conversation_id,
    status,
    createdAt: thread.created_at,
    endedAt: ended ? conv?.updated_at || thread.created_at : null,
    rating:
      thread.rating != null && thread.rated_at
        ? { score: Number(thread.rating), comment: thread.rating_comment, ratedAt: thread.rated_at }
        : null,
    canRate: ended && teamAnswered && thread.rating == null,
  };
}

async function hasTeamMessage(sb: ServiceClient, conversationId: string): Promise<boolean> {
  const { count } = await sb
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .in('sender_type', TEAM_SENDERS);
  return (count ?? 0) > 0;
}

/**
 * The team's messages the operator has not read: across their recent
 * conversations, each counted from when they last read it.
 */
async function unreadCount(sb: ServiceClient, userId: string): Promise<number> {
  const threads = await recentThreads(sb, userId);
  if (!threads.length) return 0;
  const readAt = new Map(threads.map((t) => [t.conversation_id, t.user_read_at]));
  const since = threads.every((t) => t.user_read_at)
    ? threads.map((t) => t.user_read_at!).sort()[0]
    : null;
  let query = sb
    .from('conversation_messages')
    .select('conversation_id, created_at')
    .in('conversation_id', [...readAt.keys()])
    .in('sender_type', TEAM_SENDERS)
    .order('created_at', { ascending: false })
    .limit(200);
  if (since) query = query.gt('created_at', since);
  const { data } = await query;
  return ((data ?? []) as Array<{ conversation_id: string; created_at: string }>).filter((row) => {
    const read = readAt.get(row.conversation_id);
    return !read || row.created_at > read;
  }).length;
}

// ─── History ────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: string;
  sender_id: string | null;
  body: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

const MESSAGE_COLUMNS = 'id, conversation_id, sender_type, sender_id, body, created_at, metadata';

/** What the operator sees: messages, and the team's joins — never an internal notice. */
function isVisible(row: MessageRow): boolean {
  if (MESSAGE_SENDERS.includes(row.sender_type)) return true;
  if (row.sender_type !== 'system') return false;
  const meta = row.metadata || {};
  return meta.internal !== true && JOIN_KINDS.has(String(meta.kind));
}

function joinedName(meta: Record<string, unknown>): string | null {
  const name = meta.agent_name ?? meta.to_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  status: string;
}

function attachmentView(row: AttachmentRow): SupportAttachmentView {
  const mimeType = row.mime_type || 'application/octet-stream';
  return {
    id: row.id,
    fileName: row.file_name || 'file',
    mimeType,
    sizeBytes: Number(row.size_bytes ?? 0),
    kind: attachmentKind(mimeType),
  };
}

/** The files on these messages, by message id: linked rows, and any a message names. */
async function attachmentsByMessage(sb: ServiceClient, rows: MessageRow[]): Promise<Map<string, SupportAttachmentView[]>> {
  const out = new Map<string, SupportAttachmentView[]>();
  if (!rows.length) return out;
  const named = new Map<string, string>();
  for (const row of rows) {
    const id = row.metadata?.attachment_id;
    if (typeof id === 'string' && UUID.test(id)) named.set(id, row.id);
  }
  const conversationIds = [...new Set(rows.map((r) => r.conversation_id))];
  const [{ data: linked }, { data: byId }] = await Promise.all([
    sb
      .from('conversation_attachments')
      .select('id, message_id, file_name, mime_type, size_bytes, status')
      .in('conversation_id', conversationIds)
      .in('message_id', rows.map((r) => r.id)),
    named.size
      ? sb
          .from('conversation_attachments')
          .select('id, message_id, file_name, mime_type, size_bytes, status')
          .in('id', [...named.keys()])
      : Promise.resolve({ data: [] as AttachmentRow[] }),
  ]);
  const seen = new Set<string>();
  for (const row of [...((linked ?? []) as AttachmentRow[]), ...((byId ?? []) as AttachmentRow[])]) {
    if (seen.has(row.id) || (row.status !== 'uploaded' && row.status !== 'attached')) continue;
    const messageId = row.message_id ?? named.get(row.id);
    if (!messageId) continue;
    seen.add(row.id);
    out.set(messageId, [...(out.get(messageId) ?? []), attachmentView(row)]);
  }
  return out;
}

async function itemViews(config: ServerConfig, sb: ServiceClient, rows: MessageRow[]): Promise<SupportItemView[]> {
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
  const files = await attachmentsByMessage(sb, rows.filter((r) => r.sender_type !== 'system'));
  return rows.map((row): SupportItemView => {
    const meta = row.metadata || {};
    const clientMessageId = typeof meta.client_message_id === 'string' ? meta.client_message_id : null;
    if (row.sender_type === 'system') {
      return {
        id: row.id,
        conversationId: row.conversation_id,
        kind: 'joined',
        author: 'team',
        body: '',
        senderName: joinedName(meta),
        senderAvatar: null,
        createdAt: row.created_at,
        clientMessageId: null,
        attachments: [],
      };
    }
    const mine = row.sender_type === 'contact';
    const agent = row.sender_id ? agents.get(row.sender_id) : undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      kind: 'message',
      author: mine ? 'me' : 'team',
      body: row.body || '',
      senderName: mine ? null : agent?.name ?? null,
      senderAvatar: mine ? null : agent?.avatar ?? null,
      createdAt: row.created_at,
      clientMessageId,
      attachments: files.get(row.id) ?? [],
    };
  });
}

/** Every conversation the operator has had with the team, as one chat. */
export async function supportHistory(config: ServerConfig, userId: string): Promise<SupportHistory> {
  const sb = getServiceClient(config);
  const threads = (await recentThreads(sb, userId)).reverse();
  if (!threads.length) return { conversations: [], items: [], activeConversationId: null };
  const ids = threads.map((t) => t.conversation_id);
  const [settings, conversations, { data }] = await Promise.all([
    loadPlatformSupportSettings(config),
    conversationsById(sb, ids),
    sb
      .from('conversation_messages')
      .select(MESSAGE_COLUMNS)
      .in('conversation_id', ids)
      .in('sender_type', [...MESSAGE_SENDERS, 'system'])
      .order('created_at', { ascending: false })
      .limit(ITEM_LIMIT),
  ]);
  const rows = ((data ?? []) as MessageRow[]).filter(isVisible).reverse();
  const answered = new Set(rows.filter((r) => TEAM_SENDERS.includes(r.sender_type)).map((r) => r.conversation_id));
  // A conversation older than the page may still have been answered.
  await Promise.all(
    threads
      .filter((t) => !answered.has(t.conversation_id) && ENDED_STATUSES.has(conversations.get(t.conversation_id)?.status || ''))
      .map(async (t) => {
        if (await hasTeamMessage(sb, t.conversation_id)) answered.add(t.conversation_id);
      }),
  );
  const views = threads.map((t) => conversationView(t, conversations.get(t.conversation_id), answered.has(t.conversation_id)));
  // The one the app writes to: the newest that is still open, with the team
  // that answers now — the same one a message without a target would join.
  const active = [...threads]
    .reverse()
    .find((t) => isWritable(t, conversations.get(t.conversation_id), settings.workspaceId));
  return {
    conversations: views,
    items: await itemViews(config, sb, rows),
    activeConversationId: active?.conversation_id ?? null,
  };
}

export async function markRead(config: ServerConfig, userId: string): Promise<void> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();
  const threads = await recentThreads(sb, userId);
  if (!threads.length) return;
  await sb
    .from('platform_support_threads')
    .update({ user_read_at: now })
    .in('conversation_id', threads.map((t) => t.conversation_id));
  void memberWorkspaceIds(sb, userId).then((workspaces) =>
    publishSupportEvent(config, userId, workspaces, { kind: 'support_read', thread_id: threads[0].conversation_id }),
  );
}

// ─── Writing ────────────────────────────────────────────────────────

interface WriteContext {
  sb: ServiceClient;
  requester: Requester;
  contactId: string;
  thread: ThreadRow;
  conversationId: string;
  supportWorkspaceId: string;
}

function sourceWorkspace(raw: unknown): string | null {
  return typeof raw === 'string' && UUID.test(raw) ? raw : null;
}

/** The conversation the app names: null when it names none, as-is otherwise (an unknown one is not found). */
function targetConversation(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return typeof raw === 'string' ? raw.trim() : String(raw);
}

/** The operator's message with this client id in this conversation, if it landed. */
async function priorMessage(sb: ServiceClient, conversationId: string, clientMessageId: string): Promise<MessageRow | null> {
  const { data } = await sb
    .from('conversation_messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .filter('metadata->>client_message_id', 'eq', clientMessageId)
    .maybeSingle();
  return (data as MessageRow | null) ?? null;
}

/** Open or pending, and with the team that answers support now. */
function isWritable(thread: ThreadRow, conv: ConversationRow | undefined, supportWorkspaceId: string | null): boolean {
  return thread.support_workspace_id === supportWorkspaceId && ACTIVE_STATUSES.has(conv?.status || '');
}

/**
 * Where the operator's next message goes.
 *
 * - The app names the conversation it shows (`conversationId`): the message
 *   goes there while it is open, and is refused with `conversation_ended`
 *   once it is not — never quietly moved to another conversation the
 *   operator is not looking at. A retry of a message that landed before the
 *   end still returns it.
 * - It names none: a new conversation — or, when one is open already (the
 *   operator's other device started it), that one. The client's id is in a
 *   new conversation's key, so a retried first message finds the
 *   conversation it started.
 */
async function prepareWrite(
  config: ServerConfig,
  userId: string,
  input: {
    clientMessageId: string;
    conversationId: string | null;
    sourceWorkspaceId: string | null;
    client: ClientPlatform;
    subject: string;
  },
): Promise<WriteContext> {
  const supportWorkspaceId = await requireSupportWorkspace(config);
  if (!writeLimiter.take(userId)) throw new SupportError(429, 'rate_limited');
  const sb = getServiceClient(config);

  let chosen: { thread: ThreadRow; conv: ConversationRow | undefined } | null = null;
  if (input.conversationId) {
    const thread = await ownThread(sb, userId, input.conversationId);
    const conv = (await conversationsById(sb, [thread.conversation_id])).get(thread.conversation_id);
    if (
      !isWritable(thread, conv, supportWorkspaceId) &&
      !(await priorMessage(sb, thread.conversation_id, input.clientMessageId))
    ) {
      throw new SupportError(409, 'conversation_ended');
    }
    chosen = { thread, conv };
  } else {
    const threads = await recentThreads(sb, userId);
    const conversations = await conversationsById(sb, threads.map((t) => t.conversation_id));
    const active = threads.find((t) => isWritable(t, conversations.get(t.conversation_id), supportWorkspaceId));
    if (active) chosen = { thread: active, conv: conversations.get(active.conversation_id) };
  }

  const requester = await loadRequester(config, sb, userId, input.sourceWorkspaceId, input.client);
  const contactId = await ensureRequesterContact(sb, supportWorkspaceId, requester);
  if (chosen) {
    const { thread, conv } = chosen;
    const meta = conv?.metadata || {};
    if (isWritable(thread, conv, supportWorkspaceId) && meta.client_platform !== requester.client) {
      await sb
        .from('conversations')
        .update({ metadata: { ...meta, client_platform: requester.client } })
        .eq('id', thread.conversation_id);
    }
    return { sb, requester, contactId, thread, conversationId: thread.conversation_id, supportWorkspaceId };
  }

  const threadKey = `${SUPPORT_CHANNEL}:${userId}:${input.clientMessageId}`;
  const { data, error } = await sb.rpc('ensure_active_conversation', {
    p_workspace_id: supportWorkspaceId,
    p_lock_key: threadKey,
    p_match_thread_key: threadKey,
    p_match_session_id: null,
    p_match_contact_id: null,
    p_contact_id: contactId,
    p_visitor_session_id: null,
    p_subject: input.subject,
    p_metadata: {
      channel: SUPPORT_CHANNEL,
      channel_thread_key: threadKey,
      platform_user_id: requester.userId,
      platform_workspace_id: requester.workspaceId,
      client_platform: requester.client,
    },
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.id) {
    console.error('[platform-support] conversation failed:', error?.message || 'no row');
    throw new SupportError(500, 'conversation_failed');
  }
  const conversationId = row.id as string;
  await sb.from('platform_support_threads').upsert(
    {
      conversation_id: conversationId,
      support_workspace_id: supportWorkspaceId,
      user_id: requester.userId,
      source_workspace_id: requester.workspaceId,
    },
    { onConflict: 'conversation_id', ignoreDuplicates: true },
  );
  const thread = await ownThread(sb, userId, conversationId).catch(() => {
    // A key names its operator, so a conversation it matched is theirs;
    // anything else is a broken invariant, not somebody else's chat to join.
    throw new SupportError(500, 'conversation_failed');
  });
  if (row.created) {
    void recordConversationEvent(config, {
      workspaceId: supportWorkspaceId,
      conversationId,
      eventType: 'created',
      actorType: 'visitor',
      actorId: null,
      payload: { source: SUPPORT_CHANNEL, client: requester.client },
    });
  }
  return { sb, requester, contactId, thread, conversationId, supportWorkspaceId };
}

/**
 * The operator's message, delivered to the team as a customer's would be.
 * The client's id makes a retry return the first copy.
 */
async function postRequesterMessage(
  config: ServerConfig,
  ctx: WriteContext,
  input: { body: string; clientMessageId: string; attachment?: { id: string } },
): Promise<SupportItemView> {
  const { sb, conversationId, supportWorkspaceId: workspaceId, requester } = ctx;
  const findPrior = () => priorMessage(sb, conversationId, input.clientMessageId);

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
          platform_user_id: requester.userId,
          client_platform: requester.client,
          client_message_id: input.clientMessageId,
          ...(input.attachment ? { attachment_id: input.attachment.id } : {}),
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
      row = data as MessageRow;
    }
  }

  if (!duplicate) {
    if (input.attachment) {
      await sb
        .from('conversation_attachments')
        .update({ message_id: row.id, conversation_id: conversationId, status: 'attached' })
        .eq('id', input.attachment.id)
        .eq('workspace_id', workspaceId);
    }
    await applyInboundConversationLifecycle(config, {
      workspaceId,
      conversationId,
      source: SUPPORT_CHANNEL,
      message: {
        senderType: 'contact',
        direction: 'inbound',
        text: input.body,
        attachmentCount: input.attachment ? 1 : 0,
      },
      messageId: row.id,
    }).catch((err) => console.warn('[platform-support] lifecycle failed:', err?.message ?? err));
    await sb.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    await sb
      .from('conversations')
      .update({ contact_id: ctx.contactId })
      .eq('id', conversationId)
      .is('contact_id', null);
    // Having written, the operator has seen everything before it.
    await sb
      .from('platform_support_threads')
      .update({ user_read_at: row.created_at })
      .eq('conversation_id', conversationId);

    void publishConversationEvent(
      config,
      workspaceId,
      conversationId,
      buildMessageEnvelope({
        ...row,
        sender_type: 'contact',
        body: row.body || '',
        sender_name: requester.name,
        sender_avatar: requester.avatarUrl,
      }),
    );
    void notifyInboundMessage(config, {
      workspaceId,
      conversationId,
      messageId: row.id,
      text: input.body,
      senderName: requester.name,
      channel: SUPPORT_CHANNEL,
      attachmentCount: input.attachment ? 1 : 0,
      // A team member writing to support is not told about their own message.
      actorId: requester.userId,
    });
    // The operator's other devices.
    void memberWorkspaceIds(sb, requester.userId).then((workspaces) =>
      publishSupportEvent(config, requester.userId, workspaces, {
        kind: 'support_message',
        thread_id: conversationId,
        message_id: row!.id,
      }),
    );
  }

  const [view] = await itemViews(config, sb, [row]);
  return view;
}

async function conversationViewFor(sb: ServiceClient, thread: ThreadRow): Promise<SupportConversationView> {
  const conversations = await conversationsById(sb, [thread.conversation_id]);
  return conversationView(thread, conversations.get(thread.conversation_id), await hasTeamMessage(sb, thread.conversation_id));
}

export interface WriteInput {
  body?: unknown;
  clientMessageId: unknown;
  /** The conversation the app is showing and writing to; absent to start one. */
  conversationId?: unknown;
  /** The workspace the operator is writing from, if the app knows it. */
  sourceWorkspaceId?: unknown;
  client: ClientPlatform;
}

/** A message in the operator's chat: to the conversation the app names, else a new one. */
export async function sendMessage(
  config: ServerConfig,
  userId: string,
  input: WriteInput,
): Promise<{ conversation: SupportConversationView; item: SupportItemView }> {
  const body = normalizeBody(input.body);
  if (!body) throw new SupportError(400, 'invalid_body');
  const clientMessageId = normalizeClientMessageId(input.clientMessageId) ?? randomUUID();
  const ctx = await prepareWrite(config, userId, {
    clientMessageId,
    conversationId: targetConversation(input.conversationId),
    sourceWorkspaceId: sourceWorkspace(input.sourceWorkspaceId),
    client: input.client,
    subject: subjectFromBody(body),
  });
  const item = await postRequesterMessage(config, ctx, { body, clientMessageId });
  return { conversation: await conversationViewFor(ctx.sb, ctx.thread), item };
}

/** Decodes a base64 file, refusing anything but the chat's types and 2 MB. */
export function readFile(input: { fileName?: unknown; mimeType?: unknown; data?: unknown }): {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
} {
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
  if (!ALLOWED_FILE_TYPES.has(mimeType)) throw new SupportError(400, 'file_type_not_allowed');
  if (typeof input.data !== 'string' || !input.data) throw new SupportError(400, 'invalid_file');
  // Checked on the encoded length first, so a huge body is refused before
  // it is decoded into memory.
  if (input.data.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4) throw new SupportError(413, 'file_too_large');
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length) throw new SupportError(400, 'invalid_file');
  if (bytes.length > MAX_FILE_BYTES) throw new SupportError(413, 'file_too_large');
  return { bytes, fileName: supportFileName(input.fileName, mimeType), mimeType };
}

/** A file in the operator's chat, stored like any chat attachment of the support workspace. */
export async function sendAttachment(
  config: ServerConfig,
  userId: string,
  input: WriteInput & { fileName?: unknown; mimeType?: unknown; data?: unknown },
): Promise<{ conversation: SupportConversationView; item: SupportItemView }> {
  const file = readFile(input);
  const clientMessageId = normalizeClientMessageId(input.clientMessageId) ?? randomUUID();
  const ctx = await prepareWrite(config, userId, {
    clientMessageId,
    conversationId: targetConversation(input.conversationId),
    sourceWorkspaceId: sourceWorkspace(input.sourceWorkspaceId),
    client: input.client,
    subject: file.fileName,
  });

  // A retry of a file that already landed returns it, and stores nothing twice.
  const prior = await priorMessage(ctx.sb, ctx.conversationId, clientMessageId);
  if (prior) {
    const [item] = await itemViews(config, ctx.sb, [prior]);
    return { conversation: await conversationViewFor(ctx.sb, ctx.thread), item };
  }

  const storagePath = chatAttachmentKey({ workspaceId: ctx.supportWorkspaceId, fileName: file.fileName });
  const { data: row, error } = await ctx.sb
    .from('conversation_attachments')
    .insert({
      workspace_id: ctx.supportWorkspaceId,
      conversation_id: ctx.conversationId,
      storage_provider: await storageProviderName(ctx.sb, ctx.supportWorkspaceId),
      storage_path: storagePath,
      file_name: file.fileName,
      mime_type: file.mimeType,
      size_bytes: file.bytes.length,
      uploaded_by_type: 'contact',
      uploaded_by_id: null,
      status: 'uploading',
    })
    .select('id')
    .single();
  if (error || !row) {
    console.error('[platform-support] attachment row failed:', error?.message);
    throw new SupportError(500, 'attachment_failed');
  }
  const attachmentId = (row as { id: string }).id;
  const stored = await uploadFile(config, {
    workspaceId: ctx.supportWorkspaceId,
    fileKey: storagePath,
    data: file.bytes,
    contentType: file.mimeType,
  }).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : 'upload failed' }));
  if (!stored.success) {
    await ctx.sb
      .from('conversation_attachments')
      .update({ status: 'failed', error_message: String(stored.error || 'upload failed').slice(0, 200) })
      .eq('id', attachmentId);
    throw new SupportError(502, 'upload_failed');
  }
  await ctx.sb
    .from('conversation_attachments')
    .update({ status: 'uploaded', finalized_at: new Date().toISOString() })
    .eq('id', attachmentId);

  const item = await postRequesterMessage(config, ctx, { body: '', clientMessageId, attachment: { id: attachmentId } });
  return { conversation: await conversationViewFor(ctx.sb, ctx.thread), item };
}

/** The storage provider the workspace's files go to, recorded on the row as the widget does. */
async function storageProviderName(sb: ServiceClient, workspaceId: string): Promise<string> {
  const { data } = await sb
    .from('provider_configs')
    .select('provider_name')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'storage')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const own = (data as { provider_name?: string } | null)?.provider_name;
  if (own) return own;
  const { data: global } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_storage_provider')
    .maybeSingle();
  return ((global as { value?: { provider?: string } } | null)?.value?.provider) || 'local';
}

/** A file from the operator's own chat — theirs or the team's — as bytes. */
export async function attachmentFile(
  config: ServerConfig,
  userId: string,
  attachmentId: string,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  if (!UUID.test(attachmentId)) throw new SupportError(404, 'attachment_not_found');
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversation_attachments')
    .select('id, workspace_id, conversation_id, storage_path, file_name, mime_type, status')
    .eq('id', attachmentId)
    .maybeSingle();
  const row = data as {
    workspace_id: string;
    conversation_id: string | null;
    storage_path: string;
    file_name: string | null;
    mime_type: string | null;
    status: string;
  } | null;
  if (!row?.conversation_id || (row.status !== 'uploaded' && row.status !== 'attached')) {
    throw new SupportError(404, 'attachment_not_found');
  }
  const thread = await ownThread(sb, userId, row.conversation_id).catch(() => null);
  if (!thread || thread.support_workspace_id !== row.workspace_id) throw new SupportError(404, 'attachment_not_found');
  const path = String(row.storage_path);
  if (!path.startsWith(`workspace/${row.workspace_id}/`) || path.includes('..')) {
    throw new SupportError(404, 'attachment_not_found');
  }
  const file = await downloadFile(config, row.workspace_id, path);
  if (!file.success || !file.data) throw new SupportError(502, 'download_failed');
  return {
    bytes: file.data,
    fileName: row.file_name || 'file',
    mimeType: row.mime_type || 'application/octet-stream',
  };
}

// ─── Rating ─────────────────────────────────────────────────────────

/**
 * The operator rates a conversation that has ended: once, 1–5 stars and an
 * optional comment. The team sees it in the conversation as an internal
 * notice.
 */
export async function rateConversation(
  config: ServerConfig,
  userId: string,
  conversationId: string,
  input: { score?: unknown; comment?: unknown },
): Promise<{ conversation: SupportConversationView }> {
  const score = normalizeScore(input.score);
  const comment = normalizeRatingComment(input.comment);
  if (score === null || comment === undefined) throw new SupportError(400, 'invalid_rating');
  const sb = getServiceClient(config);
  const thread = await ownThread(sb, userId, conversationId);
  if (thread.rating != null) throw new SupportError(409, 'already_rated');
  const conversations = await conversationsById(sb, [conversationId]);
  const status = conversations.get(conversationId)?.status || 'open';
  if (!ENDED_STATUSES.has(status) || !(await hasTeamMessage(sb, conversationId))) {
    throw new SupportError(409, 'not_ratable');
  }
  const ratedAt = new Date().toISOString();
  const { data: updated } = await sb
    .from('platform_support_threads')
    .update({ rating: score, rating_comment: comment, rated_at: ratedAt })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .is('rating', null)
    .select(THREAD_COLUMNS);
  const row = ((updated ?? []) as ThreadRow[])[0];
  // Another device got there first.
  if (!row) throw new SupportError(409, 'already_rated');

  const body = comment ? `Rated ${score}/5: ${comment}` : `Rated ${score}/5`;
  const metadata = { kind: 'support_rating', internal: true, score, comment };
  const { data: notice } = await sb
    .from('conversation_messages')
    .insert({ conversation_id: conversationId, sender_type: 'system', body, metadata })
    .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
    .single();
  if (notice) {
    const n = notice as { id: string; conversation_id: string; body: string; created_at: string | null; seen_at?: string | null };
    void publishConversationEvent(
      config,
      thread.support_workspace_id,
      conversationId,
      buildMessageEnvelope({
        id: n.id,
        conversation_id: n.conversation_id,
        sender_type: 'system',
        body: n.body,
        created_at: n.created_at,
        metadata,
        seen_at: n.seen_at ?? null,
      }),
    );
  }
  void recordConversationEvent(config, {
    workspaceId: thread.support_workspace_id,
    conversationId,
    eventType: 'rated',
    actorType: 'visitor',
    actorId: null,
    payload: { source: SUPPORT_CHANNEL, score },
  });
  return { conversation: conversationView(row, conversations.get(conversationId), true) };
}

// ─── The team's side ────────────────────────────────────────────────

async function supportThreadFor(sb: ServiceClient, workspaceId: string, conversationId: string): Promise<ThreadRow | null> {
  const { data } = await sb
    .from('platform_support_threads')
    .select(THREAD_COLUMNS)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  const thread = data as ThreadRow | null;
  return thread && thread.support_workspace_id === workspaceId ? thread : null;
}

/**
 * An agent answered in the support workspace's inbox: tell the operator.
 *
 * Called by the inbox's send route after every agent message; a
 * conversation that is not a support one costs one primary-key read and
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
    const thread = await supportThreadFor(sb, input.workspaceId, input.conversationId);
    if (!thread) return;

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
  } catch (err) {
    console.warn('[platform-support] reply delivery failed:', err instanceof Error ? err.message : err);
  }
}

export { onSupportConversationChanged } from './changes.js';
