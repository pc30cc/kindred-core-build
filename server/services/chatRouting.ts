/**
 * Chat conversation routing/assignment.
 *
 * Every conversation a person has to answer gets one (owner decisions of
 * 2026-10-21, DECISIONS §3–§4):
 *
 *   - when it needs a human: at the visitor's first message when no AI will
 *     answer it (routeHumanBoundConversation, called by the widget's
 *     /message and by channel inbound), or on an AI handoff
 *     (handoffState.ts) — after the pre-chat form, or 2 minutes without it;
 *   - to whom, in this order:
 *       a. the operator of the contact's previous conversation (last N days,
 *          or the operator already writing in this one) when they can take
 *          it right now (`last_agent`);
 *       b. the chosen department's members, then the whole team (unless the
 *          Super Admin turned the general pool off); no department → the
 *          whole team. Mode `auto` = least busy by current load, `round_robin`
 *          = one rotation per pool, `manual` = the Unassigned queue (as
 *          before; a plan without `widget_assignment_routing` is manual);
 *       c. the workspace owner, under the Super Admin's global owner-fallback
 *          policy (the same one calls use);
 *     each step only among members who may receive chats
 *     (shared/chatRoles.ts: the owner and team roles, never staff), are not
 *     suspended or seat-paused, have "Receive chats automatically" on, are
 *     present (active first; away only when idle under 30 minutes and no
 *     active one can take it) and are under their capacity (max concurrent
 *     chats);
 *   - nobody → the chat waits unassigned with an honest notice ("nobody is
 *     online" vs "everyone is busy, you are in the queue"), and the routing
 *     ticker (chatRoutingTicker.ts) gives it out as soon as someone can take
 *     it; an assignee who has not written within the first-response timeout
 *     loses it to the next operator.
 *
 * The pick and the assignment are one SQL call, chat_route_claim()
 * (migration 278): under a per-workspace advisory lock it counts the
 * candidates' load against their capacity, orders them per mode and claims
 * the conversation only while nobody has it, so simultaneous chats spread
 * out instead of piling on one operator. Every assignment writes an
 * `assigned` conversation event with its method.
 *
 * Seats the plan has paused (simple billing phase 4, design §5): those
 * members are never candidates (departments.ts), and a conversation still
 * held by one goes back to routing on its next run instead of waiting for
 * the hourly release (billing/locks/release.ts).
 */
import { isBotProvider } from '../../shared/channels/botProviders.js';
import type { ServerConfig } from '../config.js';
import { patchConversationMetadata } from './conversationMetadata.js';
import { recordConversationEvent } from './conversationEvents.js';
import { coalesce } from '../lib/inflight.js';
import { getServiceClient } from '../supabase.js';
import {
  resolveChatRoutingPool,
  resolveChatRoutingMember,
  resolveWorkspaceOwnerId,
} from './calls/departments.js';
import { loadGlobalAdvancedRouting, ownerFallbackAllowedGlobal } from './calls/globalAdvancedRouting.js';
import { readRoutingPresence, type RoutingPresence } from './widget/operatorPresence.js';
import { resolveWidgetCapability } from './widget/entitlements.js';
import { publishOperatorEvent, publishConversationEvent, buildMessageEnvelope } from './realtime/publish.js';
import { dispatchOutboundIfChannelConversation } from './channels/outbound.js';
import { maybeQueueTelegramOfflineScreen } from './channels/telegram/offlineDelivery.js';
import { notifyAssignment, notifyHandoff } from './push/index.js';
import { onSupportConversationChanged } from './platformSupport/changes.js';
import { resolveLockState } from './billing/locks/state.js';
import { isMemberLocked } from './billing/locks/predicates.js';
import { deferRoutingForPrechat, shouldDeferRoutingForPrechat } from './chatRoutingPrechat.js';

export type AssignmentMode = 'auto' | 'round_robin' | 'manual';

export type RoutingOutcome =
  | 'assigned_auto'
  | 'assigned_round_robin'
  | 'assigned_last_agent'
  | 'assigned_owner_fallback'
  | 'manual_queue'
  /** Nobody who may receive chats is online: the chat waits. */
  | 'no_eligible_agent'
  /** Someone is online but everyone is at capacity: the chat waits in the queue. */
  | 'all_agents_busy'
  /** Waiting for the visitor's pre-chat form (routed anyway after 2 minutes). */
  | 'routing_deferred'
  | 'already_assigned'
  /** Resolved, closed or spam: never routed. */
  | 'not_routable'
  | 'error';

/** How a conversation got its operator: the `assigned` event's `method`. */
export type AssignmentMethod = 'auto' | 'round_robin' | 'last_agent' | 'owner_fallback' | 'timeout_reassign';

export interface RouteResult {
  outcome: RoutingOutcome;
  assignedTo: string | null;
}

/** An away operator (connected, idle ≥5 min) gets a chat only while idle less than this. */
export const AWAY_ROUTING_MAX_IDLE_MS = 30 * 60_000;

/** Why a chat waits: chat_routing_state.wait_reason. */
export type WaitReason = 'nobody_online' | 'all_busy';

// ─── Routing settings ─────────────────────────────────────────────────────

export interface ChatRoutingSettings {
  /** The plan-gated mode: a plan without `widget_assignment_routing` is manual. */
  mode: AssignmentMode;
  /** The workspace's switch AND the Super Admin's platform switch. */
  lastAgentEnabled: boolean;
  lastAgentWindowDays: number;
  /** Super Admin → Advanced routing: a department with nobody available falls back to the whole team. */
  generalPoolEnabled: boolean;
  /** Super Admin → Advanced routing: owner fallback for chats. */
  ownerFallback: boolean;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * The workspace's routing settings (widget_settings, migration 278), the
 * plan's `widget_assignment_routing` (the panel shows a plan without it as
 * locked to Manual, and so does routing), and the Super Admin's global
 * advanced-routing policy.
 */
export async function loadRoutingSettings(
  config: ServerConfig,
  workspaceId: string,
  cache?: RoutingCache,
): Promise<ChatRoutingSettings> {
  const hit = cache?.settings.get(workspaceId);
  if (hit) return hit;
  const sb = getServiceClient(config);
  const [{ data }, planAllows, global] = await Promise.all([
    sb.from('widget_settings')
      .select('assignment_mode, last_agent_routing_enabled, last_agent_window_days')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    resolveWidgetCapability(config, workspaceId, 'widget_assignment_routing').catch(() => false),
    loadGlobalAdvancedRouting(config),
  ]);
  const row = data as {
    assignment_mode?: string | null;
    last_agent_routing_enabled?: boolean | null;
    last_agent_window_days?: number | null;
  } | null;
  const raw = row?.assignment_mode;
  const stored: AssignmentMode = raw === 'round_robin' || raw === 'manual' ? raw : 'auto';
  const settings: ChatRoutingSettings = {
    mode: planAllows ? stored : 'manual',
    lastAgentEnabled: row?.last_agent_routing_enabled !== false && global.last_agent_routing_enabled !== false,
    lastAgentWindowDays: clampInt(row?.last_agent_window_days, 1, 365, 30),
    generalPoolEnabled: global.general_pool_enabled !== false,
    ownerFallback: ownerFallbackAllowedGlobal(global, 'chat'),
  };
  cache?.settings.set(workspaceId, settings);
  return settings;
}

/**
 * Lookups shared by the routing runs of one ticker pass (settings, pools,
 * presence per workspace). A request routes one conversation and passes
 * none.
 */
export interface RoutingCache {
  settings: Map<string, ChatRoutingSettings>;
  presence: Map<string, Map<string, RoutingPresence>>;
  pools: Map<string, { team: string[]; department: string[] | null }>;
}

export function createRoutingCache(): RoutingCache {
  return { settings: new Map(), presence: new Map(), pools: new Map() };
}

async function chatPool(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string | null,
  cache?: RoutingCache,
): Promise<{ team: string[]; department: string[] | null }> {
  const key = `${workspaceId}:${departmentId || ''}`;
  const hit = cache?.pools.get(key);
  if (hit) return hit;
  const pool = await resolveChatRoutingPool(config, workspaceId, departmentId);
  cache?.pools.set(key, pool);
  return pool;
}

async function presenceOf(
  config: ServerConfig,
  workspaceId: string,
  userIds: string[],
  cache?: RoutingCache,
): Promise<Map<string, RoutingPresence>> {
  const known = cache?.presence.get(workspaceId);
  const missing = userIds.filter((id) => !known?.has(id));
  if (!missing.length && known) return known;
  const read = await readRoutingPresence(config, workspaceId, missing);
  const merged = new Map([...(known || new Map()), ...read]);
  cache?.presence.set(workspaceId, merged);
  return merged;
}

// ─── Presence tiers ───────────────────────────────────────────────────────

/**
 * ROUTING ELIGIBILITY — deliberately NOT the same thing as customer-facing
 * availability:
 *
 *   active (connected, interacted <5m)        → eligible, highest priority
 *   away   (connected, idle 5–30m, or no
 *           interaction seen since a restart) → eligible, reduced priority
 *   away   (idle ≥30m)                         → NOT auto-assigned
 *   disconnected (customer-available but
 *     no live connection)                     → NOT auto-assigned
 *   offline (manual off/invisible or
 *     schedule closed)                        → ineligible
 *
 * "Messenger online" therefore never implies "assign a live chat to this
 * operator right now".
 */
export interface RoutingTiers {
  /** Tier 1 — always exhausted before tier 2 is considered. */
  active: string[];
  /** Tier 2 — only reached when no active operator could claim. */
  away: string[];
}

/** The tier an operator is in for routing right now, or null (not routable now). Pure. */
export function routingTierOf(p: RoutingPresence | undefined, now: number = Date.now()): 'active' | 'away' | null {
  if (!p) return null;
  if (p.state === 'active') return 'active';
  if (p.state !== 'away') return null;
  if (p.lastActivityAt === null) return 'away';
  return now - p.lastActivityAt < AWAY_ROUTING_MAX_IDLE_MS ? 'away' : null;
}

/**
 * Pure tier split — exported so the "active always before away" and the
 * 30-minute away cap are unit-testable without a database. Order is kept.
 */
export function splitPresenceTiers(
  userIds: string[],
  presenceById: Map<string, RoutingPresence>,
  now: number = Date.now(),
): RoutingTiers {
  const active: string[] = [];
  const away: string[] = [];
  for (const id of userIds) {
    const tier = routingTierOf(presenceById.get(id), now);
    if (tier === 'active') active.push(id);
    else if (tier === 'away') away.push(id);
  }
  return { active, away };
}

// ─── The atomic pick (migration 278) ──────────────────────────────────────

type ClaimOrder = 'least_busy' | 'round_robin' | 'given';

interface ClaimResult {
  outcome: 'assigned' | 'already_assigned' | 'assignment_changed' | 'all_busy' | 'none' | 'not_routable' | 'not_found' | 'error';
  userId: string | null;
}

/** One row of a set-returning RPC (an array, or one object). */
function firstRow<T>(data: unknown): T | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? row as T : null;
}

async function claimFromCandidates(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    candidates: string[];
    order: ClaimOrder;
    poolKey: string;
    method: AssignmentMethod;
    expectedAssignee?: string | null;
  },
): Promise<ClaimResult> {
  const { data, error } = await getServiceClient(config).rpc('chat_route_claim', {
    p_workspace_id: args.workspaceId,
    p_conversation_id: args.conversationId,
    p_candidates: args.candidates,
    p_order: args.order,
    p_pool_key: args.poolKey,
    p_method: args.method,
    p_expected_assignee: args.expectedAssignee ?? null,
  });
  if (error) {
    console.warn('[chat-routing] chat_route_claim failed:', error.message);
    return { outcome: 'error', userId: null };
  }
  const row = firstRow<{ outcome?: unknown; picked_user_id?: unknown }>(data);
  const outcome = typeof row?.outcome === 'string' ? row.outcome as ClaimResult['outcome'] : 'error';
  return { outcome, userId: typeof row?.picked_user_id === 'string' ? row.picked_user_id : null };
}

/** Department the visitor picked, if any — read from conversation metadata,
 * falling back to the most recent visitor message (widget currently only
 * stamps department_id per-message; this persists it onto the conversation
 * the first time we see it so routing/diagnostics only need one lookup). */
async function resolveConversationDepartment(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  if (typeof metadata.department_id === 'string' && metadata.department_id) {
    return metadata.department_id;
  }
  const sb = getServiceClient(config);
  const { data: msg } = await sb
    .from('conversation_messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'contact')
    .not('metadata->>department_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const deptId = (msg as { metadata?: Record<string, unknown> | null } | null)?.metadata?.department_id as string | undefined;
  if (!deptId) return null;
  // Atomic single-key patch — this used to write back the whole metadata
  // snapshot captured at routing entry, which could revert a concurrent AI
  // handoff/takeover transition.
  await patchConversationMetadata(config, conversationId, { department_id: deptId }, workspaceId);
  return deptId;
}

async function tryClaim(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('claim_conversation', {
    p_conversation_id: conversationId,
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_force: false,
  });
  if (error) {
    console.warn('[chat-routing] claim_conversation rpc failed:', error.message);
    return false;
  }
  return Array.isArray(data) ? data.length > 0 : !!data;
}

async function tagOutcome(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  metadata: Record<string, unknown>,
  outcome: RoutingOutcome,
  extra?: Record<string, unknown>,
): Promise<void> {
  // Routing runs immediately after a successful AI handoff commit, so it
  // must never write back a whole metadata document: only the routing keys
  // are patched, server-side (migration 057). A concurrent
  // `ai_state = needs_human`, `human_takeover_at` or `ai_memory` write
  // therefore survives verbatim.
  void metadata;
  await patchConversationMetadata(config, conversationId, {
    routing_outcome: outcome,
    routing_outcome_at: new Date().toISOString(),
    ...(extra || {}),
  }, workspaceId);

}

/**
 * The operator's full name, or null. Never an English stand-in: one stored
 * as `agent_name` was read as a name in every language ("a colleague به
 * گفتگو پیوست"); without a name each reader writes its own generic sentence.
 */
async function resolveAgentDisplayName(config: ServerConfig, userId: string): Promise<string | null> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb.from('profiles').select('full_name').eq('id', userId).maybeSingle();
    const name = (data as { full_name?: unknown } | null)?.full_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** A join notice's stored body: the English fallback every system row has (readers write it from `metadata`). */
function agentJoinedBody(name: string | null): string {
  return name ? `${name} joined the conversation.` : 'A colleague joined the conversation.';
}

/**
 * The stored (inbox-only) body of the "nobody is online" notice — the
 * English fallback; every reader writes the sentence from `metadata.kind`.
 * It says what happened (nobody of the team is online) and where the answer
 * will come (here), never "busy": a busy team is the queue notice. A bot
 * conversation's is the offline text its user was sent, in the same
 * language (offlineDelivery.ts conversationReplyLocale: the user's when the
 * platform offers it, else the primary one).
 */
async function resolveNoAgentVisitorBody(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  conversationMetadata: Record<string, unknown>,
): Promise<string> {
  const fallback = "Nobody from our team is online right now. Your message is saved and we'll reply here as soon as someone is back.";
  const provider = String(conversationMetadata.channel || '');
  if (!isBotProvider(provider)) return fallback;
  try {
    const [{ getInstallation }, telegram, offline] = await Promise.all([
      import('./plugins/state.js'),
      import('./channels/telegram/settings.js'),
      import('./channels/telegram/offlineDelivery.js'),
    ]);
    const installation = await getInstallation(config, workspaceId, provider);
    if (!installation) return fallback;
    const settings = telegram.parseTelegramSettings(installation.settings);
    const { locale, fallbackLocale } = await offline.conversationReplyLocale(config, workspaceId, conversationId);
    const key = settings.menu.lockWhenOffline ? 'offlineLocked' : 'offlineNotice';
    return telegram.resolveLocalizedMessage(settings, locale, key, fallbackLocale);
  } catch (err) {
    console.warn('[chat-routing] telegram visitor notice localization failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Visible routing-outcome messages (spec §22) — inserted as real
 * `sender_type: 'system'` conversation messages so they flow through the
 * exact same delivery paths (poll/history/realtime) the widget already
 * uses for everything else, rather than inventing a second signal. Body
 * is an English fallback only; the widget renders the actual text from
 * `metadata.kind` per-locale (same convention as the existing
 * `call_ended` system message — see server/services/calls/endSession.ts).
 * Never throws — a failed notice must never break routing itself.
 */
async function insertRoutingSystemMessage(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  body: string,
  metadata: Record<string, unknown>,
  deliverToChannel = false,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data: msgRow, error } = await sb
      .from('conversation_messages')
      .insert({ conversation_id: conversationId, sender_type: 'system', body, metadata })
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
      .single();
    if (error || !msgRow) return;
    // System messages are intentionally excluded from the database outbound
    // trigger. Only explicitly visitor-facing routing notices cross a channel;
    // internal events such as "agent joined" remain Inbox-only.
    if (deliverToChannel) {
      await dispatchOutboundIfChannelConversation(config, {
        workspaceId,
        conversationId,
        messageId: msgRow.id as string,
        body: msgRow.body as string,
      });
    }
    void publishConversationEvent(
      config,
      workspaceId,
      conversationId,
      buildMessageEnvelope({
        id: msgRow.id as string,
        conversation_id: msgRow.conversation_id as string,
        sender_type: 'system',
        body: msgRow.body as string,
        created_at: msgRow.created_at as string | null,
        metadata: (msgRow.metadata as Record<string, unknown>) ?? metadata,
        seen_at: (msgRow as { seen_at?: string | null }).seen_at ?? null,
      }),
    );
    // A platform-support conversation: the operator's chat shows the join.
    void onSupportConversationChanged(config, { workspaceId, conversationId });
  } catch { /* best-effort — never break routing */ }
}

// ─── The queue's place and wait (issue #340 g4; migration 276) ────────────
//
// A conversation waits in the manual queue while nobody has it: open or
// pending, `metadata.routing_outcome = 'manual_queue'`, no operator. Its
// place is 1 + the workspace's queued conversations that entered the queue
// before it (`metadata.queued_at`; every channel counts: it is the team's one
// Unassigned queue), and the wait is that place times the workspace's moving
// average of seconds per place (chat_queue_stats, sampled by 276's trigger
// at each claim, from `queued_at` and `queue_entry_position`).
// chat_queue_status() answers both; the partial index
// conversations_manual_queue_idx makes it one short range read.
//
// A hand-back (an operator unassigns it, or a paused seat is released) puts
// the conversation back in the queue at the place its `queued_at` keeps:
// 276's trigger on the unassignment records when (`queue_reentered_at`) and
// at which place (`queue_entry_position`), so the next claim's sample
// measures this wait, not the time an operator held it; and the next routing
// run posts a new `routing_in_queue` row (once per return,
// `queue_return_notice_at`), so the visitor's queue pill comes back. The
// inbox's unassign runs that routing at once (routeQueueReturn).

/**
 * How long an earlier `queued_at` stays the conversation's entry into the
 * queue. Every visitor message re-runs routing while it waits, and a
 * conversation an operator hands back keeps its place; a stamp older than
 * this belongs to an earlier wait (276's claim sampler ignores such waits
 * too), and the conversation joins the queue again at its end.
 */
export const QUEUE_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The `queued_at` to save when routing puts the conversation in the manual
 * queue: now, unless it already holds a valid one younger than
 * QUEUE_ENTRY_MAX_AGE_MS (then null: keep it). Pure; exported for its tests.
 */
export function queueEntryStamp(metadata: Record<string, unknown>, now: number = Date.now()): string | null {
  const stored = typeof metadata.queued_at === 'string' ? Date.parse(metadata.queued_at) : NaN;
  if (Number.isFinite(stored) && stored <= now && now - stored < QUEUE_ENTRY_MAX_AGE_MS) return null;
  return new Date(now).toISOString();
}

/** One row of chat_queue_status() (a set-returning function: an array, or one object). */
function queueStatusRow(data: unknown): { queue_position?: unknown; wait_minutes?: unknown } | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? row as { queue_position?: unknown; wait_minutes?: unknown } : null;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The place the conversation entered the queue at, which the claim sampler
 * divides its wait by. Cosmetic: before 276 (no chat_queue_status) or on any
 * error nothing is written and the sampler counts it as place 1.
 */
async function recordQueueEntryPosition(config: ServerConfig, workspaceId: string, conversationId: string): Promise<void> {
  try {
    const { data, error } = await getServiceClient(config).rpc('chat_queue_status', {
      p_workspace_id: workspaceId,
      p_conversation_id: conversationId,
    });
    if (error) return;
    const position = positiveInt(queueStatusRow(data)?.queue_position);
    if (position) await patchConversationMetadata(config, conversationId, { queue_entry_position: position }, workspaceId);
  } catch { /* before 276 */ }
}

export interface QueueStatus {
  /** 1 = next; null while the conversation is not waiting in the queue. */
  position: number | null;
  /** Estimated minutes, once 3 claims were measured (else null). */
  wait_minutes: number | null;
}

const NOT_QUEUED: QueueStatus = { position: null, wait_minutes: null };

/**
 * GET /api/widget/queue for a conversation the visitor owns (its row as the
 * ownership check read it): nulls without a query when it is plainly not
 * waiting (an operator has it, it is closed, routing never queued it), else
 * chat_queue_status(). Two integers and nothing else reach the visitor.
 * Before 276, or on any error: nulls, never a failure.
 */
export async function readQueueStatus(
  config: ServerConfig,
  workspaceId: string,
  conversation: { id: string; status?: string | null; assigned_to?: string | null; metadata?: Record<string, unknown> | null },
): Promise<QueueStatus> {
  const meta = conversation.metadata || {};
  if (conversation.assigned_to) return NOT_QUEUED;
  if (conversation.status !== 'open' && conversation.status !== 'pending') return NOT_QUEUED;
  if (meta.routing_outcome !== 'manual_queue' || typeof meta.queued_at !== 'string') return NOT_QUEUED;
  try {
    const { data, error } = await getServiceClient(config).rpc('chat_queue_status', {
      p_workspace_id: workspaceId,
      p_conversation_id: conversation.id,
    });
    if (error) return NOT_QUEUED;
    const row = queueStatusRow(data);
    const position = positiveInt(row?.queue_position);
    return position ? { position, wait_minutes: positiveInt(row?.wait_minutes) } : NOT_QUEUED;
  } catch {
    return NOT_QUEUED;
  }
}

/**
 * Whether this routing run should tell the phones about the handoff.
 *
 * Routing runs again on every visitor message while a conversation waits, so
 * the handoff's own stamp (`ai_handoff_at`) makes it one notification per
 * handoff: once it has been told (`handoff_push_at` holds the same stamp), a
 * later run does not even look up who to tell. Without a stamp only the run
 * that also sends the visitor notice pushes.
 */
export function handoffPushStamp(metadata: Record<string, unknown>, firstRun: boolean): string | null {
  const stamp = typeof metadata.ai_handoff_at === 'string' ? metadata.ai_handoff_at : null;
  if (stamp) return metadata.handoff_push_at === stamp ? null : stamp;
  return firstRun ? new Date().toISOString() : null;
}

/**
 * The AI let go of this conversation and routing gave it to nobody new — it
 * stays with whoever already held it, or waits in the queue — so the phones
 * hear it from here (a conversation routing DID give to someone is
 * `notifyAssignment`).
 */
function notifyHandoffOnce(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
  metadata: Record<string, unknown>,
  firstRun: boolean,
): void {
  const stamp = handoffPushStamp(metadata, firstRun);
  if (!stamp) return;
  void notifyHandoff(config, {
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    handoffAt: stamp,
  });
  // Remembered on the conversation, so the next visitor message's routing
  // run skips straight past this.
  if (typeof metadata.ai_handoff_at === 'string') {
    void patchConversationMetadata(
      config, args.conversationId, { handoff_push_at: stamp }, args.workspaceId,
    ).catch(() => {});
  }
}

/**
 * Whether routing owes the visitor a new queue row for a hand-back: the
 * conversation returned to the queue (`queue_reentered_at`, stamped by 276's
 * trigger on the unassignment) and that return has not been announced yet.
 * Pure; exported for its tests.
 */
export function queueReturnToAnnounce(metadata: Record<string, unknown>): string | null {
  const returned = typeof metadata.queue_reentered_at === 'string' ? metadata.queue_reentered_at : null;
  return returned && metadata.queue_return_notice_at !== returned ? returned : null;
}

/**
 * When `assignedTo`'s seat is paused by the plan, hands the conversation
 * back to the queue (only if it is still theirs) and announces it. Returns
 * the conversation's metadata as the release left it (276's trigger stamps
 * a queued conversation's return there), or null when nothing was released.
 * Never throws.
 */
async function releaseIfSeatLocked(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  assignedTo: string,
): Promise<Record<string, unknown> | null> {
  try {
    const state = await resolveLockState(config, workspaceId, ['member']);
    if (!isMemberLocked(state, assignedTo)) return null;
    const { data, error } = await getServiceClient(config)
      .from('conversations')
      .update({ assigned_to: null })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .eq('assigned_to', assignedTo)
      .select('id, metadata');
    if (error || !Array.isArray(data) || data.length === 0) return null;
    try {
      await publishOperatorEvent(config, {
        kind: 'conversation_updated',
        conversation_id: conversationId,
        workspace_id: workspaceId,
        actor_id: null,
        changes: { assigned_to: null },
        reason: 'seat_locked',
        updated_at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    const released = (data[0] as { metadata?: unknown }).metadata;
    return released && typeof released === 'object' && !Array.isArray(released) ? released as Record<string, unknown> : {};
  } catch (err) {
    console.warn('[chat-routing] seat-lock release failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Who gets it ──────────────────────────────────────────────────────────

/**
 * "The same operator as before" (last-agent routing): the operator already
 * writing in this conversation (the last one who replied in it), else the
 * assignee of the contact's most recent other conversation active within
 * the window, else the last operator who replied in that one. Null when
 * there is none. Uses conversations_contact_recent_idx and the messages'
 * (conversation, sender type, time) index.
 */
export async function findPreviousOperator(
  config: ServerConfig,
  workspaceId: string,
  conversation: { id: string; contact_id?: string | null },
  windowDays: number,
  now: number = Date.now(),
): Promise<string | null> {
  const sb = getServiceClient(config);
  const lastReplier = async (conversationId: string): Promise<string | null> => {
    const { data } = await sb
      .from('conversation_messages')
      .select('sender_id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .not('sender_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const id = (data as { sender_id?: unknown } | null)?.sender_id;
    return typeof id === 'string' && id ? id : null;
  };
  const own = await lastReplier(conversation.id);
  if (own) return own;
  if (!conversation.contact_id) return null;
  const since = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: prev } = await sb
    .from('conversations')
    .select('id, assigned_to')
    .eq('workspace_id', workspaceId)
    .eq('contact_id', conversation.contact_id)
    .neq('id', conversation.id)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = prev as { id?: string; assigned_to?: string | null } | null;
  if (!row?.id) return null;
  return row.assigned_to || await lastReplier(row.id);
}

interface PickArgs {
  workspaceId: string;
  conversationId: string;
  contactId: string | null;
  departmentId: string | null;
  settings: ChatRoutingSettings;
  cache?: RoutingCache;
  /** A first-response timeout: never this member, and only while they still hold it. */
  reassignFrom?: string | null;
}

interface PickResult {
  outcome: 'assigned' | 'already_assigned' | 'not_routable' | 'none' | 'error';
  userId: string | null;
  method: AssignmentMethod | null;
  waitReason: WaitReason;
}

/**
 * Who takes the conversation (DECISIONS §4 a–e, h), each step one atomic
 * chat_route_claim(): the previous operator (active, in the pool), then the
 * department's members and the whole team (active tier, then away), then
 * the owner. Never in manual mode (the caller queues instead).
 */
async function pickOperator(config: ServerConfig, a: PickArgs): Promise<PickResult> {
  const { settings } = a;
  const pool = await chatPool(config, a.workspaceId, a.departmentId, a.cache);
  const ownerId = settings.ownerFallback ? await resolveWorkspaceOwnerId(config, a.workspaceId) : null;
  const presence = await presenceOf(config, a.workspaceId, ownerId ? [...pool.team, ownerId] : pool.team, a.cache);
  const now = Date.now();
  const excluded = (id: string) => id === a.reassignFrom;
  const timeout = !!a.reassignFrom;
  const tried = new Set<string>();
  let anyOnline = false;

  const attempt = async (candidates: string[], order: ClaimOrder, poolKey: string, method: AssignmentMethod) => {
    for (const id of candidates) tried.add(id);
    const r = await claimFromCandidates(config, {
      workspaceId: a.workspaceId,
      conversationId: a.conversationId,
      candidates,
      order,
      poolKey,
      method: timeout ? 'timeout_reassign' : method,
      expectedAssignee: a.reassignFrom ?? null,
    });
    return r;
  };
  /** A claim answer that ends the search (someone has it now, or it cannot be routed). */
  const final = (r: ClaimResult): PickResult | null => {
    if (r.outcome === 'assigned') return null;
    if (r.outcome === 'already_assigned' || r.outcome === 'assignment_changed') {
      return { outcome: 'already_assigned', userId: r.userId, method: null, waitReason: 'all_busy' };
    }
    if (r.outcome === 'not_routable' || r.outcome === 'not_found') {
      return { outcome: 'not_routable', userId: r.userId, method: null, waitReason: 'all_busy' };
    }
    if (r.outcome === 'error') return { outcome: 'error', userId: null, method: null, waitReason: 'nobody_online' };
    return null;
  };

  // a. The previous operator, when they can take it right now: active (not
  // away), in the pool (and the chosen department), under capacity. No
  // waiting for them: otherwise straight on.
  const lastAgentPool = pool.department ?? pool.team;
  if (settings.lastAgentEnabled && lastAgentPool.some((id) => routingTierOf(presence.get(id), now) === 'active')) {
    const prev = await findPreviousOperator(config, a.workspaceId, { id: a.conversationId, contact_id: a.contactId }, settings.lastAgentWindowDays)
      .catch((err) => {
        console.warn('[chat-routing] previous operator lookup failed:', err instanceof Error ? err.message : err);
        return null;
      });
    const inPool = !!prev && lastAgentPool.includes(prev);
    if (prev && inPool && !excluded(prev) && routingTierOf(presence.get(prev), now) === 'active') {
      anyOnline = true;
      const r = await attempt([prev], 'given', 'last_agent', 'last_agent');
      if (r.outcome === 'assigned' && r.userId) return { outcome: 'assigned', userId: r.userId, method: timeout ? 'timeout_reassign' : 'last_agent', waitReason: 'all_busy' };
      const end = final(r);
      if (end) return end;
    }
  }

  // b. The department's members, then the whole team (unless the Super
  // Admin turned the general pool off); no department: the whole team.
  const order: ClaimOrder = settings.mode === 'round_robin' ? 'round_robin' : 'least_busy';
  const method: AssignmentMethod = settings.mode === 'round_robin' ? 'round_robin' : 'auto';
  const pools: Array<{ key: string; ids: string[] }> = [];
  if (pool.department && a.departmentId) pools.push({ key: a.departmentId, ids: pool.department });
  if (!pool.department || settings.generalPoolEnabled) pools.push({ key: 'team', ids: pool.team });
  for (const p of pools) {
    // TIER 1 = active, TIER 2 = away (idle under 30 minutes). Tier 2 is only
    // entered when no active operator could take it.
    const tiers = splitPresenceTiers(p.ids.filter((id) => !excluded(id)), presence, now);
    for (const tier of [tiers.active, tiers.away]) {
      if (!tier.length) continue;
      anyOnline = true;
      const r = await attempt(tier, order, p.key, method);
      if (r.outcome === 'assigned' && r.userId) return { outcome: 'assigned', userId: r.userId, method: timeout ? 'timeout_reassign' : method, waitReason: 'all_busy' };
      const end = final(r);
      if (end) return end;
    }
  }

  // c. The owner, under the global owner-fallback policy, when they receive
  // chats and are here (and were not tried above).
  if (ownerId && !tried.has(ownerId) && !excluded(ownerId) && routingTierOf(presence.get(ownerId), now)) {
    const member = await resolveChatRoutingMember(config, a.workspaceId, ownerId);
    if (member && !member.suspended && member.receivesChats) {
      anyOnline = true;
      const r = await attempt([ownerId], 'given', 'owner', 'owner_fallback');
      if (r.outcome === 'assigned' && r.userId) return { outcome: 'assigned', userId: r.userId, method: timeout ? 'timeout_reassign' : 'owner_fallback', waitReason: 'all_busy' };
      const end = final(r);
      if (end) return end;
    }
  }

  return { outcome: 'none', userId: null, method: null, waitReason: anyOnline ? 'all_busy' : 'nobody_online' };
}

function assignedOutcome(method: AssignmentMethod, mode: AssignmentMode): RoutingOutcome {
  if (method === 'last_agent') return 'assigned_last_agent';
  if (method === 'owner_fallback') return 'assigned_owner_fallback';
  return mode === 'round_robin' ? 'assigned_round_robin' : 'assigned_auto';
}

/**
 * Tell everyone a routing assignment happened: the routing keys (and, for a
 * thread the AI held, that a person has it now — an assigned chat must not
 * stay hidden in the AI's queue), the visitor's "X joined", the inboxes, the
 * assignee's phone and the conversation's timeline (method: auto,
 * round_robin, last_agent, owner_fallback, timeout_reassign).
 */
async function announceAssignment(
  config: ServerConfig,
  a: {
    workspaceId: string;
    conversationId: string;
    metadata: Record<string, unknown>;
    userId: string;
    method: AssignmentMethod;
    outcome: RoutingOutcome;
    from: string | null;
    extraPatch?: Record<string, unknown>;
  },
): Promise<void> {
  const aiHeld = a.metadata.ai_state === 'ai_managed';
  await tagOutcome(config, a.workspaceId, a.conversationId, a.metadata, a.outcome, {
    routing_notice_sent: true,
    ...(aiHeld ? { ai_state: 'human_assigned', managed_by_ai: false, ai_managed_by_ai: false } : {}),
    ...(a.extraPatch || {}),
  });
  const agentName = await resolveAgentDisplayName(config, a.userId);
  await insertRoutingSystemMessage(
    config, a.workspaceId, a.conversationId,
    agentJoinedBody(agentName),
    { kind: 'routing_agent_joined', agent_name: agentName, agent_id: a.userId },
  );
  try {
    await publishOperatorEvent(config, {
      kind: 'conversation_updated',
      conversation_id: a.conversationId,
      workspace_id: a.workspaceId,
      actor_id: null,
      changes: { assigned_to: { from: a.from, to: a.userId } },
      reason: a.method === 'timeout_reassign' ? 'timeout_reassigned' : 'auto_assigned',
    });
  } catch { /* best-effort */ }
  // The customer message that brought the conversation here was pushed
  // before anybody owned it; the operator routing just picked hears now.
  void notifyAssignment(config, {
    workspaceId: a.workspaceId,
    conversationId: a.conversationId,
    assigneeId: a.userId,
    actorId: null,
    stamp: new Date().toISOString(),
  });
  void recordConversationEvent(config, {
    workspaceId: a.workspaceId,
    conversationId: a.conversationId,
    eventType: 'assigned',
    actorType: 'system',
    actorId: null,
    payload: { from: a.from, to: a.userId, method: a.method },
  });
}

/** Whether the assignee can answer right now: a member, not suspended, here (routing tiers). */
async function assigneePresent(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  cache?: RoutingCache,
): Promise<boolean> {
  try {
    const member = await resolveChatRoutingMember(config, workspaceId, userId);
    if (!member || member.suspended) return false;
    const presence = await presenceOf(config, workspaceId, [userId], cache);
    return routingTierOf(presence.get(userId)) !== null;
  } catch {
    return false;
  }
}

async function recordWait(config: ServerConfig, workspaceId: string, conversationId: string, reason: WaitReason | null): Promise<void> {
  try {
    const { error } = await getServiceClient(config).rpc('chat_routing_wait', {
      p_workspace_id: workspaceId,
      p_conversation_id: conversationId,
      p_reason: reason,
    });
    if (error) console.warn('[chat-routing] chat_routing_wait failed:', error.message);
  } catch { /* the visitor's next message routes it again */ }
}

export interface RouteOptions {
  /** Lookups shared by one ticker pass. */
  cache?: RoutingCache;
  /** The ticker retrying a waiting chat: a manual-mode workspace stops the retries. */
  fromTicker?: boolean;
}

/**
 * Route an unassigned conversation that needs a person (an AI handoff, the
 * visitor's first message with no AI answering, the pre-chat form, the
 * ticker). Idempotent — a conversation that's already assigned is left
 * untouched. Never throws; the handoff must always succeed even if routing
 * fails.
 */
export async function routeConversationToOperator(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
  opts: RouteOptions = {},
): Promise<RouteResult> {
  try {
    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('id, assigned_to, status, is_spam, contact_id, metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    if (!conv) return { outcome: 'error', assignedTo: null };
    const row = conv as { assigned_to?: string | null; status?: string | null; is_spam?: boolean | null; contact_id?: string | null };
    let metadata = ((conv as { metadata?: Record<string, unknown> | null }).metadata || {}) as Record<string, unknown>;
    if (row.is_spam === true || row.status === 'resolved' || row.status === 'closed') {
      return { outcome: 'not_routable', assignedTo: row.assigned_to ?? null };
    }

    // Held by a member whose seat the plan paused: back to the queue, and
    // routed below like any unassigned conversation (from the metadata the
    // release left, which holds a queued conversation's return stamp).
    const released = row.assigned_to
      ? await releaseIfSeatLocked(config, args.workspaceId, args.conversationId, row.assigned_to)
      : null;
    if (released) {
      row.assigned_to = null;
      metadata = { ...metadata, ...released };
    }

    if (row.assigned_to) {
      // Already assigned, so nobody is being routed — but the visitor has
      // just been handed over from the AI and still needs to be told who
      // they are now talking to, once per conversation (a second handoff
      // does not repeat it) and only while that operator is actually here:
      // "X joined" about someone who left hours ago would be a promise.
      const firstRun = metadata.routing_notice_sent !== true;
      if (firstRun && await assigneePresent(config, args.workspaceId, row.assigned_to, opts.cache)) {
        const assignedName = await resolveAgentDisplayName(config, row.assigned_to);
        await insertRoutingSystemMessage(
          config, args.workspaceId, args.conversationId,
          agentJoinedBody(assignedName),
          { kind: 'routing_agent_joined', agent_name: assignedName, agent_id: row.assigned_to },
        );
        await tagOutcome(
          config, args.workspaceId, args.conversationId, metadata,
          'already_assigned', { routing_notice_sent: true },
        );
      }
      notifyHandoffOnce(config, args, metadata, firstRun);
      return { outcome: 'already_assigned', assignedTo: row.assigned_to };
    }
    // If routing waited for the pre-chat form (deferRoutingForPrechat), this
    // run is that wait ending: the flag is cleared with the outcome.
    const pending = metadata.routing_pending === true ? { routing_pending: false } : {};
    // A visitor may send several messages while still unassigned (manual
    // queue, or genuinely nobody eligible) — routing runs again on each one.
    // Without this guard the "queue"/"no one available" notice would repeat
    // itself on every message.
    const noticeAlreadySent = metadata.routing_notice_sent === true;
    const settings = await loadRoutingSettings(config, args.workspaceId, opts.cache);
    const departmentId = await resolveConversationDepartment(
      config, args.workspaceId, args.conversationId, metadata,
    );

    if (settings.mode === 'manual') {
      if (opts.fromTicker) await recordWait(config, args.workspaceId, args.conversationId, null);
      // The queue is the team's: everyone following all conversations.
      notifyHandoffOnce(config, args, metadata, !noticeAlreadySent);
      // The place in the queue (GET /api/widget/queue) counts from when the
      // conversation entered it. Saved before the visitor's queue row is
      // published, so the widget's first read of its place already finds it.
      const queuedAt = queueEntryStamp(metadata);
      // Handed back since its last notice: the visitor waits again, and is
      // told so again (once per return).
      const returned = queueReturnToAnnounce(metadata);
      await tagOutcome(
        config, args.workspaceId, args.conversationId, metadata, 'manual_queue',
        {
          ...pending,
          ...(noticeAlreadySent ? {} : { routing_notice_sent: true }),
          ...(queuedAt ? { queued_at: queuedAt } : {}),
          ...(returned ? { queue_return_notice_at: returned } : {}),
        },
      );
      if (queuedAt) await recordQueueEntryPosition(config, args.workspaceId, args.conversationId);
      if (!noticeAlreadySent || returned) {
        await insertRoutingSystemMessage(
          config, args.workspaceId, args.conversationId,
          'Your message is in the support queue.',
          { kind: 'routing_in_queue' },
        );
      }
      return { outcome: 'manual_queue', assignedTo: null };
    }

    const pick = await pickOperator(config, {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: row.contact_id ?? null,
      departmentId,
      settings,
      cache: opts.cache,
    });
    if (pick.outcome === 'already_assigned') return { outcome: 'already_assigned', assignedTo: pick.userId };
    if (pick.outcome === 'not_routable') return { outcome: 'not_routable', assignedTo: pick.userId };
    if (pick.outcome === 'error') return { outcome: 'error', assignedTo: null };

    if (pick.outcome === 'assigned' && pick.userId && pick.method) {
      const outcome = assignedOutcome(pick.method, settings.mode);
      await announceAssignment(config, {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        metadata,
        userId: pick.userId,
        method: pick.method,
        outcome,
        from: null,
        extraPatch: pending,
      });
      return { outcome, assignedTo: pick.userId };
    }

    // Nobody can take it now: it waits, and the ticker gives it out as soon
    // as someone can. The visitor is told which it is, once: nobody of the
    // team is online, or everyone is busy and they are in the queue.
    const outcome: RoutingOutcome = pick.waitReason === 'all_busy' ? 'all_agents_busy' : 'no_eligible_agent';
    await recordWait(config, args.workspaceId, args.conversationId, pick.waitReason);
    notifyHandoffOnce(config, args, metadata, !noticeAlreadySent);
    if (!noticeAlreadySent) {
      if (pick.waitReason === 'all_busy') {
        await insertRoutingSystemMessage(
          config, args.workspaceId, args.conversationId,
          "Everyone on our team is busy right now. You're in the queue and we'll reply here as soon as someone is free.",
          { kind: 'routing_in_queue', reason: 'all_busy' },
        );
      } else {
        const visitorBody = await resolveNoAgentVisitorBody(config, args.workspaceId, args.conversationId, metadata);
        const telegramScreenQueued = isBotProvider(String(metadata.channel || ''))
          ? await maybeQueueTelegramOfflineScreen(config, {
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              requireUnreachable: false,
            }).catch(() => false)
          : false;
        await insertRoutingSystemMessage(
          config, args.workspaceId, args.conversationId,
          visitorBody,
          {
            kind: 'routing_no_agent_available',
            reason: 'nobody_online',
            ...(isBotProvider(String(metadata.channel || ''))
              ? { channel_delivery_skip: 'true', telegram_offline_screen_queued: telegramScreenQueued }
              : {}),
          },
          // Telegram owns its visitor-facing away response in exactly one
          // specialized path: either the immediate runtime screen or the AI
          // handoff response inserted before routing. This generic routing
          // notice is always Inbox-only for Telegram; using a timestamp check
          // here is racy and previously created a second message_id/job.
          !isBotProvider(String(metadata.channel || '')),
        );
      }
    }
    await tagOutcome(
      config, args.workspaceId, args.conversationId, metadata, outcome,
      { ...pending, ...(noticeAlreadySent ? {} : { routing_notice_sent: true }) },
    );
    return { outcome, assignedTo: null };
  } catch (err) {
    console.warn('[chat-routing] routeConversationToOperator failed:', err instanceof Error ? err.message : err);
    return { outcome: 'error', assignedTo: null };
  }
}

/**
 * A first-response timeout (the ticker): the operator routing gave this
 * conversation to has not written in it within the workspace's timeout. It
 * goes to the next operator who can take it (never back to them: they join
 * the conversation's skip list), atomically and only while they still hold
 * it. Nobody else can: it leaves them all the same and waits, unassigned —
 * in every teammate's Unassigned list and the ticker's queue — for the next
 * operator; the visitor is told they wait. Never throws.
 */
export async function reassignAfterFirstResponseTimeout(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string; from: string },
  opts: RouteOptions = {},
): Promise<RouteResult> {
  try {
    const { data: conv } = await getServiceClient(config)
      .from('conversations')
      .select('id, assigned_to, status, is_spam, contact_id, metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    const row = conv as { assigned_to?: string | null; status?: string | null; is_spam?: boolean | null; contact_id?: string | null; metadata?: Record<string, unknown> | null } | null;
    if (!row) return { outcome: 'error', assignedTo: null };
    if (row.assigned_to !== args.from || row.is_spam === true || (row.status !== 'open' && row.status !== 'pending')) {
      return { outcome: 'not_routable', assignedTo: row.assigned_to ?? null };
    }
    const settings = await loadRoutingSettings(config, args.workspaceId, opts.cache);
    if (settings.mode === 'manual') return { outcome: 'already_assigned', assignedTo: args.from };
    const metadata = row.metadata || {};
    const departmentId = typeof metadata.department_id === 'string' && metadata.department_id ? metadata.department_id : null;
    const pick = await pickOperator(config, {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: row.contact_id ?? null,
      departmentId,
      settings,
      cache: opts.cache,
      reassignFrom: args.from,
    });
    if (pick.outcome === 'none') {
      return await releaseAfterTimeout(config, { ...args, metadata, reason: pick.waitReason });
    }
    if (pick.outcome !== 'assigned' || !pick.userId) {
      return { outcome: pick.outcome === 'error' ? 'error' : 'already_assigned', assignedTo: pick.userId };
    }
    const outcome = assignedOutcome('auto', settings.mode);
    await announceAssignment(config, {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      metadata,
      userId: pick.userId,
      method: 'timeout_reassign',
      outcome,
      from: args.from,
    });
    return { outcome, assignedTo: pick.userId };
  } catch (err) {
    console.warn('[chat-routing] first-response reassignment failed:', err instanceof Error ? err.message : err);
    return { outcome: 'error', assignedTo: null };
  }
}

/**
 * The timeout's other end: nobody can take the chat over, so it leaves the
 * member who did not answer (chat_routing_release: only while they still
 * hold it; they join its skip list) and waits for the next operator. The
 * inboxes hear it, the timeline records it (`unassigned`, method
 * timeout_release), and the visitor is told they wait — nobody online, or in
 * the queue.
 */
async function releaseAfterTimeout(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; from: string; metadata: Record<string, unknown>; reason: WaitReason },
): Promise<RouteResult> {
  const { data, error } = await getServiceClient(config).rpc('chat_routing_release', {
    p_workspace_id: a.workspaceId,
    p_conversation_id: a.conversationId,
    p_from: a.from,
    p_reason: a.reason,
  });
  if (error) {
    console.warn('[chat-routing] chat_routing_release failed:', error.message);
    return { outcome: 'error', assignedTo: null };
  }
  if (data !== true && firstRow<{ chat_routing_release?: unknown }>(data)?.chat_routing_release !== true) {
    // Someone else has it by now (or it closed): nothing to release.
    return { outcome: 'already_assigned', assignedTo: null };
  }
  try {
    await publishOperatorEvent(config, {
      kind: 'conversation_updated',
      conversation_id: a.conversationId,
      workspace_id: a.workspaceId,
      actor_id: null,
      changes: { assigned_to: { from: a.from, to: null } },
      reason: 'timeout_released',
    });
  } catch { /* best-effort */ }
  void recordConversationEvent(config, {
    workspaceId: a.workspaceId,
    conversationId: a.conversationId,
    eventType: 'unassigned',
    actorType: 'system',
    actorId: null,
    payload: { from: a.from, to: null, method: 'timeout_release' },
  });
  if (a.reason === 'all_busy') {
    await insertRoutingSystemMessage(
      config, a.workspaceId, a.conversationId,
      "Everyone on our team is busy right now. You're in the queue and we'll reply here as soon as someone is free.",
      { kind: 'routing_in_queue', reason: 'all_busy' },
    );
  } else {
    await insertRoutingSystemMessage(
      config, a.workspaceId, a.conversationId,
      await resolveNoAgentVisitorBody(config, a.workspaceId, a.conversationId, a.metadata),
      {
        kind: 'routing_no_agent_available',
        reason: 'nobody_online',
        ...(isBotProvider(String(a.metadata.channel || '')) ? { channel_delivery_skip: 'true' } : {}),
      },
      !isBotProvider(String(a.metadata.channel || '')),
    );
  }
  await tagOutcome(
    config, a.workspaceId, a.conversationId, a.metadata,
    a.reason === 'all_busy' ? 'all_agents_busy' : 'no_eligible_agent',
  );
  return { outcome: a.reason === 'all_busy' ? 'all_agents_busy' : 'no_eligible_agent', assignedTo: null };
}

// ─── New human-bound conversations ────────────────────────────────────────

/**
 * Whether an AI will answer the visitor's next message, so the conversation
 * is left to the AI (its handoff routes it): the platform gate, the
 * workspace's AI switch and mode, and for "auto-reply when operators are
 * offline" the same availability the AI engine reads. A thread a person
 * already took, or one handed off, is never the AI's. An unreadable setting
 * leaves it to the AI, as before.
 */
export async function aiWillAnswer(
  config: ServerConfig,
  workspaceId: string,
  metadata: Record<string, unknown>,
  platformAiOff?: boolean,
): Promise<boolean> {
  if (platformAiOff === true) return false;
  const state = typeof metadata.ai_state === 'string' ? metadata.ai_state : null;
  if (state === 'needs_human' || state === 'human_assigned' || state === 'human_active') return false;
  try {
    if (platformAiOff === undefined) {
      const { isAutoAnswerAllowedForWorkspace } = await import('./ai-agent/platformGuards.js');
      if ((await isAutoAnswerAllowedForWorkspace(config, workspaceId)).allowed !== true) return false;
    }
    const { data, error } = await getServiceClient(config)
      .from('ai_agent_settings')
      .select('enabled, mode')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (error) return true;
    const settings = data as { enabled?: boolean | null; mode?: string | null } | null;
    if (!settings || settings.enabled !== true) return false;
    if (settings.mode === 'auto_reply_always' || settings.mode === 'auto_reply_until_human_joins') return true;
    if (settings.mode === 'auto_reply_when_offline') {
      const { getOperatorAvailability } = await import('./ai-agent/availability.js');
      return (await getOperatorAvailability(config, workspaceId)).state === 'offline';
    }
    // off, suggest_only: the AI never answers the visitor.
    return false;
  } catch {
    return true;
  }
}

/**
 * A visitor message landed (widget /message, channel inbound): route the
 * conversation now when nobody has it and no AI will answer it — AI off
 * (the default), suggest-only, or auto-reply-when-offline while the team is
 * online. While the AI answers, its handoff routes it as before. When the
 * workspace's pre-chat asks for details the visitor has not given yet,
 * routing waits for the form, and routes anyway two minutes later (the
 * ticker). A resolved conversation the visitor writes into again starts a
 * new thread: its routing notices may be given again. Runs once at a time
 * per conversation; never throws; null when it did not route.
 */
export function routeHumanBoundConversation(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string; platformAiOff?: boolean; reopened?: boolean },
): Promise<RouteResult | null> {
  return coalesce(`route-human:${args.workspaceId}:${args.conversationId}`, () => routeHumanBoundConversationNow(config, args));
}

async function routeHumanBoundConversationNow(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string; platformAiOff?: boolean; reopened?: boolean },
): Promise<RouteResult | null> {
  try {
    const { data } = await getServiceClient(config)
      .from('conversations')
      .select('assigned_to, status, is_spam, metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    const conv = data as { assigned_to?: string | null; status?: string | null; is_spam?: boolean | null; metadata?: Record<string, unknown> | null } | null;
    if (!conv) return null;
    let metadata = conv.metadata || {};
    if (args.reopened && metadata.routing_notice_sent === true) {
      await patchConversationMetadata(config, args.conversationId, { routing_notice_sent: false }, args.workspaceId);
      metadata = { ...metadata, routing_notice_sent: false };
    }
    if (conv.assigned_to || conv.is_spam === true) return null;
    if (conv.status !== 'open' && conv.status !== 'pending') return null;
    // Waiting for the pre-chat form: the form, or the ticker, routes it.
    if (metadata.routing_pending === true) return null;
    if (await aiWillAnswer(config, args.workspaceId, metadata, args.platformAiOff)) return null;
    if (await shouldDeferRoutingForPrechat(config, args.workspaceId, args.conversationId)) {
      await deferRoutingForPrechat(config, args.workspaceId, args.conversationId);
      return { outcome: 'routing_deferred', assignedTo: null };
    }
    return await routeConversationToOperator(config, { workspaceId: args.workspaceId, conversationId: args.conversationId });
  } catch (err) {
    console.warn('[chat-routing] routeHumanBoundConversation failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Whether anyone could take a chat right now (routable, receiving chats,
 * present: the routing tiers; capacity not counted). The AI's handoff line
 * uses it so it never says "connecting you" when routing will find nobody.
 * Never throws; true when unknown.
 */
export async function anyChatOperatorPresent(config: ServerConfig, workspaceId: string): Promise<boolean> {
  try {
    const { team } = await resolveChatRoutingPool(config, workspaceId, null);
    if (!team.length) return false;
    const presence = await readRoutingPresence(config, workspaceId, team);
    const now = Date.now();
    return team.some((id) => routingTierOf(presence.get(id), now) !== null);
  } catch {
    return true;
  }
}

/**
 * The inbox handed a queued conversation back (PATCH assigned_to → NULL):
 * route it now, so the visitor's new queue row (276's trigger stamped the
 * return in that UPDATE) arrives at once instead of with their next message.
 * Only for a conversation waiting in the manual queue again (nobody has it,
 * open or pending, not spam, a return not announced yet, not the AI's again:
 * the AI answers its next message, and a handoff routes it) of a workspace
 * still in manual mode; anything else stays as the inbox left it. Routing
 * announces each return once (`queue_return_notice_at`), so the visitor's
 * next message posts nothing more. Two unassigns at once (a double click:
 * both PATCHes read the holder before either writes, so both get here) share
 * one run, which announces the return once. Never throws; null when it did
 * not route.
 */
export function routeQueueReturn(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
): Promise<RouteResult | null> {
  return coalesce(`queue-return:${args.workspaceId}:${args.conversationId}`, () => routeQueueReturnNow(config, args));
}

async function routeQueueReturnNow(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
): Promise<RouteResult | null> {
  try {
    const { data } = await getServiceClient(config)
      .from('conversations')
      .select('assigned_to, status, is_spam, metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    const conv = data as { assigned_to?: string | null; status?: string | null; is_spam?: boolean | null; metadata?: unknown } | null;
    if (!conv || conv.assigned_to || conv.is_spam === true) return null;
    if (conv.status !== 'open' && conv.status !== 'pending') return null;
    const metadata = conv.metadata && typeof conv.metadata === 'object' && !Array.isArray(conv.metadata)
      ? conv.metadata as Record<string, unknown> : {};
    if (metadata.routing_outcome !== 'manual_queue' || !queueReturnToAnnounce(metadata)) return null;
    if (metadata.ai_state === 'ai_managed') return null;
    if ((await loadRoutingSettings(config, args.workspaceId)).mode !== 'manual') return null;
    return await routeConversationToOperator(config, args);
  } catch (err) {
    console.warn('[chat-routing] routeQueueReturn failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Manual-mode claim: the first operator to press "claim" in the Unassigned
 * inbox owns the conversation. Atomic — two operators claiming at the same
 * instant can never both succeed.
 */
export async function claimConversationManually(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string; userId: string },
): Promise<{ claimed: boolean; assignedTo: string | null }> {
  const sb = getServiceClient(config);
  const ok = await tryClaim(config, args.workspaceId, args.conversationId, args.userId);
  if (!ok) {
    const { data } = await sb
      .from('conversations')
      .select('assigned_to')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    return { claimed: false, assignedTo: (data as { assigned_to?: string | null } | null)?.assigned_to || null };
  }
  const agentName = await resolveAgentDisplayName(config, args.userId);
  await insertRoutingSystemMessage(
    config, args.workspaceId, args.conversationId,
    agentJoinedBody(agentName),
    { kind: 'routing_agent_joined', agent_name: agentName, agent_id: args.userId },
  );
  try {
    await publishOperatorEvent(config, {
      kind: 'conversation_updated',
      conversation_id: args.conversationId,
      workspace_id: args.workspaceId,
      actor_id: args.userId,
      reason: 'manual_claim',
    });
  } catch { /* best-effort */ }
  return { claimed: true, assignedTo: args.userId };
}
