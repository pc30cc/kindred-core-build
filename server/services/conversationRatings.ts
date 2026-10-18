/**
 * THE RATING AFTER A CHAT (CSAT, issue #340 g1; migration 276).
 *
 * A visitor rates one CLOSURE of a widget conversation: the
 * `conversation_closed` line the thread ends with (conversationClosedNotice.ts),
 * 1–5 and an optional comment, kept in `conversation_ratings` with the
 * operator that line names. Rules (owner, 2026-10-17):
 *   - only the closure the thread still ends with (latestClosedRow: nothing
 *     said after it), within RATING_WINDOW_DAYS of it;
 *   - only when a human operator answered in the conversation (an AI-only
 *     conversation gets the line but no card, like platform support);
 *   - once per closure, never changed (409 `already_rated` with the stored
 *     rating; the unique closed_message_id settles a race);
 *   - only for a workspace whose effective template draws the card and has
 *     its `csat` option on (the route's check, 403 `csat_disabled`).
 *
 * The inbox learns of it through the conversation's timeline (`rated`, with
 * the score and the comment); no message row, so the visitor's thread and
 * list stay as they were. Before migration 276 every read answers "nothing to
 * rate" and a rating 503 `csat_unavailable`, never a 500.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient, type ServiceClient } from '../supabase.js';
import { recordConversationEvent } from './conversationEvents.js';
import { normalizeRatingComment, normalizeScore } from './platformSupport/text.js';
import { readLatestClosedRow, type ConversationRow } from './conversationClosedNotice.js';
import { resolveOperatorIdentities } from './widget/senderIdentity.js';
import { isRelationMissing } from './billing/entitlementParse.js';
import type { EffectiveChatTemplate } from './widget/configSnapshot.js';
import { chatTemplateOptionKeys } from '../../shared/chatTemplateCatalog.js';

export const RATING_WINDOW_DAYS = 7;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConversationRating {
  score: number;
  comment: string | null;
  rated_at: string;
}

export interface CsatState {
  /** The closed line the thread ends with, or null. */
  closed_id: string | null;
  /** The visitor may rate it now. */
  rateable: boolean;
  /** Their rating of it, once given. */
  rating: ConversationRating | null;
  /** The operator the card asks about (avatar derived now, never frozen). */
  operator: { name: string | null; avatar: string | null } | null;
}

export class RatingError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'invalid_rating' | 'not_ratable' | 'already_rated' | 'csat_unavailable',
    readonly rating: ConversationRating | null = null,
  ) {
    super(code);
  }
}

/**
 * Whether the workspace's effective template asks for ratings: it draws the
 * closed line and its card (descriptor `closedNotice`), reads the `csat`
 * option, and the option is on.
 */
export function csatEnabledFor(template: EffectiveChatTemplate): boolean {
  return !!template.descriptor?.closedNotice
    && chatTemplateOptionKeys(template.id).includes('csat')
    && template.options.csat !== false;
}

/** conversation_ratings does not exist: migration 276 is not applied. */
function ratingsTableMissing(error: unknown): boolean {
  return isRelationMissing(error as { code?: string; message?: string }, 'conversation_ratings');
}

function metaOf(row: { metadata?: unknown }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
}

/** The operator a closed line rates (its `operator_id`), when it is a uuid. */
function operatorIdOf(row: ConversationRow): string | null {
  const id = metaOf(row).operator_id;
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
}

/** Whether a human operator wrote in the conversation (an AI-only one is not rated). */
export async function humanOperatorAnswered(sb: ServiceClient, conversationId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent');
  if (error) throw error;
  return (count ?? 0) > 0;
}

export function withinRatingWindow(closedAt: string, now: number = Date.now()): boolean {
  const at = Date.parse(closedAt);
  return Number.isFinite(at) && now - at <= RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The stored rating of one closed line of this conversation; `undefined` when
 * the table is missing (before 276).
 */
async function storedRating(
  sb: ServiceClient,
  workspaceId: string,
  conversationId: string,
  closedId: string,
): Promise<ConversationRating | null | undefined> {
  const { data, error } = await sb
    .from('conversation_ratings')
    .select('score, comment, created_at')
    .eq('workspace_id', workspaceId)
    .eq('conversation_id', conversationId)
    .eq('closed_message_id', closedId)
    .maybeSingle();
  if (error) {
    if (ratingsTableMissing(error)) return undefined;
    throw error;
  }
  if (!data) return null;
  return { score: Number(data.score), comment: (data.comment as string | null) ?? null, rated_at: String(data.created_at) };
}

/**
 * GET …/csat: the closed line the thread ends with, whether it may be rated,
 * the rating once given, and who the card asks about. `csatEnabled` is the
 * template's (descriptor and option); off, nothing is rateable.
 */
export async function csatState(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; csatEnabled: boolean; humanAnswered?: boolean },
  now: number = Date.now(),
): Promise<CsatState> {
  const sb = getServiceClient(config);
  const closed = await readLatestClosedRow(sb, input.conversationId);
  if (!closed) return { closed_id: null, rateable: false, rating: null, operator: null };

  const rating = await storedRating(sb, input.workspaceId, input.conversationId, closed.id);
  const answered = input.humanAnswered ?? await humanOperatorAnswered(sb, input.conversationId);
  const rateable = input.csatEnabled
    && rating === null
    && answered
    && withinRatingWindow(closed.created_at, now);

  const operatorId = operatorIdOf(closed);
  const meta = metaOf(closed);
  const frozenName = typeof meta.operator_name === 'string' ? meta.operator_name : null;
  let operator: CsatState['operator'] = null;
  if (operatorId) {
    const who = (await resolveOperatorIdentities(config, sb, [operatorId])).get(operatorId);
    operator = { name: who?.name ?? frozenName, avatar: who?.avatar ?? null };
  } else if (frozenName) {
    operator = { name: frozenName, avatar: null };
  }
  return { closed_id: closed.id, rateable, rating: rating ?? null, operator };
}

/**
 * POST …/csat: rates the closed line `closedId`. Throws RatingError
 * (400 invalid_rating, 409 not_ratable, 409 already_rated with the stored
 * rating, 503 csat_unavailable).
 */
export async function rateClosedConversation(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; closedId: unknown; score: unknown; comment: unknown },
  now: number = Date.now(),
): Promise<ConversationRating> {
  const score = normalizeScore(input.score);
  const comment = normalizeRatingComment(input.comment);
  if (score === null || comment === undefined) throw new RatingError(400, 'invalid_rating');

  const sb = getServiceClient(config);
  const closed = await readLatestClosedRow(sb, input.conversationId);
  // Only the line the thread ends with: an older closure, another
  // conversation's line or a made-up id is never looked up.
  if (!closed || typeof input.closedId !== 'string' || closed.id !== input.closedId) {
    throw new RatingError(409, 'not_ratable');
  }

  const existing = await storedRating(sb, input.workspaceId, input.conversationId, closed.id);
  if (existing === undefined) throw new RatingError(503, 'csat_unavailable');
  if (existing) throw new RatingError(409, 'already_rated', existing);
  if (!withinRatingWindow(closed.created_at, now) || !(await humanOperatorAnswered(sb, input.conversationId))) {
    throw new RatingError(409, 'not_ratable');
  }

  const operatorId = operatorIdOf(closed);
  const { data, error } = await sb
    .from('conversation_ratings')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      closed_message_id: closed.id,
      operator_id: operatorId,
      score,
      comment,
    })
    .select('score, comment, created_at')
    .single();
  if (error) {
    if (ratingsTableMissing(error)) throw new RatingError(503, 'csat_unavailable');
    // Another tab got there first.
    if ((error as { code?: string }).code === '23505') {
      const stored = await storedRating(sb, input.workspaceId, input.conversationId, closed.id);
      throw new RatingError(409, 'already_rated', stored ?? null);
    }
    throw error;
  }

  void recordConversationEvent(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    eventType: 'rated',
    actorType: 'visitor',
    actorId: null,
    payload: { score, comment, closed_id: closed.id, operator_id: operatorId, source: 'widget' },
  });
  return { score: Number(data.score), comment: (data.comment as string | null) ?? null, rated_at: String(data.created_at) };
}
