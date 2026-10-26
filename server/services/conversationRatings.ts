/**
 * THE RATING AFTER A CHAT (CSAT, issue #340 g1; migrations 276 and 284).
 *
 * A visitor rates one CLOSURE of a widget conversation: the
 * `conversation_closed` line the thread ends with (conversationClosedNotice.ts),
 * whoever closed it (an operator, or the system after the quiet period),
 * 1–5 and an optional comment, kept in `conversation_ratings`. Rules (owner,
 * 2026-10-17; the AI's rating, decision B.5 of 2026-10-24):
 *   - only the closure the thread still ends with (latestClosedRow: nothing
 *     said after it), within RATING_WINDOW_DAYS of it;
 *   - only when the visitor wrote, and somebody answered them (answeredBy):
 *       a person (an agent row, or a call that connected): subject
 *       'operator', credited to the operator the line names
 *       (ratedOperatorOf: a person who only called is not named, so the
 *       closer of an operator's close, else nobody);
 *       only the AI (a qualified AI answer, never its greeting or its
 *       hand-over line): subject 'ai', operator_id NULL, kept out of
 *       every operator's satisfaction (operatorActivity.ts shows it as the
 *       AI's line). The card has no name and wears the workspace mark;
 *       nobody: no card;
 *   - once per closure, never changed (409 `already_rated` with the stored
 *     rating; the unique closed_message_id settles a race). A close after
 *     an older server's resolve line the visitor rated, nothing said since,
 *     is that same closure: its line carries that rating (`rated_line_id`);
 *   - only for a workspace whose effective template draws the card and has
 *     its `csat` option on (the route's check, 403 `csat_disabled`).
 *
 * The inbox learns of it through the conversation's timeline (`rated`, with
 * the score, the comment and the subject); no message row, so the visitor's
 * thread and list stay as they were. Before migration 276 every read answers
 * "nothing to rate" and a rating 503 `csat_unavailable`, never a 500; before
 * 284 (no `subject` column) an AI-only conversation's rating answers 503 too,
 * and a person's is stored as before. The transcript by email stays a
 * person's conversation's only (visitorTranscript.ts, humanOperatorAnswered).
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient, type ServiceClient } from '../supabase.js';
import { recordConversationEvent } from './conversationEvents.js';
import { normalizeRatingComment, normalizeScore } from './platformSupport/text.js';
import { readLatestClosedRow, type ConversationRow } from './conversationClosedNotice.js';
import { resolveOperatorIdentities } from './widget/senderIdentity.js';
import { isRelationMissing } from './billing/entitlementParse.js';
import { isQualifiedCustomerFacingAnswer } from './needsReply.js';
import type { EffectiveChatTemplate } from './widget/configSnapshot.js';
import { chatTemplateOptionKeys } from '../../shared/chatTemplateCatalog.js';

export const RATING_WINDOW_DAYS = 7;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many of the AI's newest rows answeredBy looks through for a real answer. */
const AI_ROWS = 20;

export interface ConversationRating {
  score: number;
  comment: string | null;
  rated_at: string;
}

/** Who answered the visitor: a person, only the AI, or nobody. */
export type AnsweredBy = 'human' | 'ai' | null;

/** Who a rating is about: an operator (a person answered) or the AI (only the AI did). */
export type RatingSubject = 'operator' | 'ai';

export interface CsatState {
  /** The closed line the thread ends with, or null. */
  closed_id: string | null;
  /** The visitor may rate it now. */
  rateable: boolean;
  /** Their rating of it, once given. */
  rating: ConversationRating | null;
  /** The operator the card asks about (avatar derived now, never frozen); null for the AI. */
  operator: { name: string | null; avatar: string | null } | null;
  /** Who the card asks about ('ai': a nameless card with the workspace mark), or null when nobody answered. */
  subject: RatingSubject | null;
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

/** conversation_ratings has no `subject` column: migration 284 is not applied. */
function subjectColumnMissing(error: unknown): boolean {
  const e = (error || {}) as { code?: string; message?: string; details?: string };
  return (e.code === '42703' || e.code === 'PGRST204') && /subject/.test(`${e.message || ''} ${e.details || ''}`);
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

/**
 * The rating a closed line has: its own, else the one it carries (an older
 * server's resolve line the visitor rated with nothing said since,
 * `rated_line_id`, conversationClosedNotice.ts): the same closure for the
 * visitor, rated once. `undefined` before migration 276.
 */
async function ratingOfLine(
  sb: ServiceClient,
  workspaceId: string,
  conversationId: string,
  closed: ConversationRow,
): Promise<ConversationRating | null | undefined> {
  const own = await storedRating(sb, workspaceId, conversationId, closed.id);
  const carried = metaOf(closed).rated_line_id;
  if (own !== null || typeof carried !== 'string' || !UUID_RE.test(carried)) return own;
  return storedRating(sb, workspaceId, conversationId, carried);
}

/** Whether a human operator wrote in the conversation (the transcript by email is theirs only). */
export async function humanOperatorAnswered(sb: ServiceClient, conversationId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent');
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Whether a call of the conversation connected: a person answered the visitor on it. */
async function callConnected(sb: ServiceClient, conversationId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('call_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('context_type', 'conversation')
    .eq('context_id', conversationId)
    .not('connected_at', 'is', null);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** The AI's greeting (ai-agent/intro.ts, source 'ai_agent_intro'): written before the visitor's first word, it answers nothing. */
function isAiGreeting(m: { metadata?: Record<string, unknown> | null }): boolean {
  return String(m.metadata?.source ?? '').startsWith('ai_agent_intro');
}

/**
 * Who answered the visitor in the conversation: 'human' when a person did
 * (an agent row, or a call that connected), else 'ai' when the AI gave a
 * real answer (needsReply.ts isQualifiedCustomerFacingAnswer: content,
 * delivered, never its hand-over line; and never its greeting), else null.
 * The SQL closed_outcome (migration 284 conversation_idle_check) reads it
 * the same way.
 */
export async function answeredBy(sb: ServiceClient, conversationId: string): Promise<AnsweredBy> {
  if (await humanOperatorAnswered(sb, conversationId)) return 'human';
  if (await callConnected(sb, conversationId)) return 'human';
  const { data, error } = await sb
    .from('conversation_messages')
    .select('sender_type, body, metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'ai')
    .order('created_at', { ascending: false })
    .limit(AI_ROWS);
  if (error) throw error;
  const rows = (data || []) as Array<{ sender_type: string; body?: string | null; metadata?: Record<string, unknown> | null }>;
  return rows.some((m) => isQualifiedCustomerFacingAnswer(m) && !isAiGreeting(m)) ? 'ai' : null;
}

/** Whether the visitor wrote in the conversation (a greeting nobody answered is never rated). */
export async function visitorWrote(sb: ServiceClient, conversationId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'contact');
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** The rating's subject for who answered, or null when nobody did. */
function subjectOf(answered: AnsweredBy): RatingSubject | null {
  return answered === 'human' ? 'operator' : answered === 'ai' ? 'ai' : null;
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
 * the rating once given, and who the card asks about (`subject`, and the
 * operator for a person's conversation). `csatEnabled` is the template's
 * (descriptor and option); off, nothing is rateable. `answered`: the route's
 * answeredBy read, when it already made it.
 */
export async function csatState(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; csatEnabled: boolean; answered?: AnsweredBy },
  now: number = Date.now(),
): Promise<CsatState> {
  const sb = getServiceClient(config);
  const closed = await readLatestClosedRow(sb, input.conversationId);
  if (!closed) return { closed_id: null, rateable: false, rating: null, operator: null, subject: null };

  const rating = await ratingOfLine(sb, input.workspaceId, input.conversationId, closed);
  const answered = input.answered !== undefined ? input.answered : await answeredBy(sb, input.conversationId);
  const subject = subjectOf(answered);
  const rateable = input.csatEnabled
    && rating === null
    && subject !== null
    && withinRatingWindow(closed.created_at, now)
    && await visitorWrote(sb, input.conversationId);

  // The AI's card names nobody (the workspace mark): no operator, even when
  // the line names the operator who closed it.
  let operator: CsatState['operator'] = null;
  if (subject !== 'ai') {
    const operatorId = operatorIdOf(closed);
    const meta = metaOf(closed);
    const frozenName = typeof meta.operator_name === 'string' ? meta.operator_name : null;
    if (operatorId) {
      const who = (await resolveOperatorIdentities(config, sb, [operatorId])).get(operatorId);
      operator = { name: who?.name ?? frozenName, avatar: who?.avatar ?? null };
    } else if (frozenName) {
      operator = { name: frozenName, avatar: null };
    }
  }
  return { closed_id: closed.id, rateable, rating: rating ?? null, operator, subject };
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

  const existing = await ratingOfLine(sb, input.workspaceId, input.conversationId, closed);
  if (existing === undefined) throw new RatingError(503, 'csat_unavailable');
  if (existing) throw new RatingError(409, 'already_rated', existing);
  const subject = withinRatingWindow(closed.created_at, now) ? subjectOf(await answeredBy(sb, input.conversationId)) : null;
  if (!subject || !(await visitorWrote(sb, input.conversationId))) {
    throw new RatingError(409, 'not_ratable');
  }

  // A person's rating is credited to the operator the line names; the AI's
  // to nobody. `subject` is written only for the AI's: a person's row reads
  // the column's default, so it is stored on a database before 284 too.
  const operatorId = subject === 'ai' ? null : operatorIdOf(closed);
  const { data, error } = await sb
    .from('conversation_ratings')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      closed_message_id: closed.id,
      operator_id: operatorId,
      score,
      comment,
      ...(subject === 'ai' ? { subject } : {}),
    })
    .select('score, comment, created_at')
    .single();
  if (error) {
    if (ratingsTableMissing(error) || subjectColumnMissing(error)) throw new RatingError(503, 'csat_unavailable');
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
    payload: { score, comment, closed_id: closed.id, operator_id: operatorId, subject, source: 'widget' },
  });
  return { score: Number(data.score), comment: (data.comment as string | null) ?? null, rated_at: String(data.created_at) };
}
