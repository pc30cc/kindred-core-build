/**
 * System rows (`conversation_messages.sender_type = 'system'`): which kinds
 * there are, and what of one a visitor may read. Server, dashboard and tests
 * alike. Pure: no I/O.
 *
 * A system row's `body` is a frozen English fallback; every reader writes
 * the sentence itself from `metadata.kind`, in the reader's language. A new
 * system kind is added here first; the widget preview
 * (`server/routes/widget.ts`), Core's `systemRowText` and the operator
 * localizers (`shared/systemMessageText.ts`, the native apps) are tested
 * against this list.
 */

/**
 * Every system kind the server writes (producers: chatRouting.ts,
 * routes/conversations.ts PATCH, conversationClosedNotice.ts,
 * calls/invitations.ts, calls/endSession.ts, platformSupport/service.ts).
 */
export const SYSTEM_MESSAGE_KINDS = [
  'routing_agent_joined', 'routing_in_queue', 'routing_no_agent_available',
  'conversation_transferred', 'conversation_unassigned', 'conversation_closed',
  'call_invitation', 'call_ended', 'platform_support_requester', 'support_rating',
] as const;

export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/**
 * Kinds the visitor's widget can write as one sentence (Core runtime.js
 * systemRowText). conversation_closed is drawn in the t2 thread only and
 * never previews.
 */
export const VISITOR_PREVIEW_SYSTEM_KINDS = [
  'routing_agent_joined', 'conversation_transferred', 'routing_no_agent_available',
  'routing_in_queue', 'call_invitation', 'call_ended',
] as const satisfies readonly SystemMessageKind[];

export type VisitorPreviewSystemKind = (typeof VISITOR_PREVIEW_SYSTEM_KINDS)[number];

/** The metadata a visitor-side sentence needs, under the row's own key names. Names only, never ids. */
export const VISITOR_SYSTEM_META_KEYS = [
  'agent_name', 'to_name', 'channel', 'operator_name', 'ended_by', 'end_reason', 'duration_seconds',
] as const;

export type VisitorSystemMetaKey = (typeof VISITOR_SYSTEM_META_KEYS)[number];

export interface VisitorSystemPreview {
  kind: VisitorPreviewSystemKind;
  meta: Partial<Record<VisitorSystemMetaKey, string | number>>;
}

/** The keys among VISITOR_SYSTEM_META_KEYS that hold a person's name. */
const NAME_KEYS: ReadonlySet<string> = new Set(['agent_name', 'to_name', 'operator_name']);

/** Who ended a call (calls/endSession.ts EndCallActor); anything else reads as the system. */
const CALL_ENDED_BY: ReadonlySet<string> = new Set(['operator', 'visitor', 'system']);

/** An end reason is a short code ('failed', 'hangup', …), never text; longer is dropped. */
const MAX_END_REASON_CHARS = 64;

/**
 * English stand-ins the server once stored as a NAME ('a colleague':
 * chatRouting.resolveAgentDisplayName; 'An operator': the inbox PATCH's
 * body). Shown as a name they print English inside a Persian or Turkish
 * sentence, so readers take the generic sentence instead.
 */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(['a colleague', 'an operator']);

const VISITOR_PREVIEW_KIND_SET: ReadonlySet<string> = new Set(VISITOR_PREVIEW_SYSTEM_KINDS);

export function isPlaceholderName(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER_NAMES.has(value.trim().toLowerCase());
}

export function looksLikeEmail(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * The AI agent's name until the owner sets one (ai-agent/settings.ts, which
 * re-exports it). English in every widget language, so what the visitor
 * reads treats it as no name: the renderers show their localized AI badge.
 */
export const DEFAULT_AI_AGENT_NAME = 'AI Assistant';

export function isDefaultAiAgentName(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === DEFAULT_AI_AGENT_NAME;
}

/**
 * The AI's hand-over line until the owner writes one (the column's default,
 * ai-agent/settings.ts re-exports it). English: only an English visitor
 * reads it (ai-agent/engine/helpers.ts ownerFallbackMessage).
 */
export const DEFAULT_AI_FALLBACK_MESSAGE = "I'm not sure about that yet. I'll connect you with a human agent.";

/** A name a VISITOR may read: trimmed, not a placeholder, not an email address; else null. */
export function visitorDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || isPlaceholderName(name) || looksLikeEmail(name)) return null;
  return name;
}

/**
 * The structured preview of one row for the visitor, or null when the
 * widget cannot write it (not a system row's metadata, internal, closed,
 * unknown kind). `meta` holds VISITOR_SYSTEM_META_KEYS only: names through
 * visitorDisplayName, the duration as a finite number, the channel 'audio'
 * or 'video'. Never an id, an actor's or a previous holder's name.
 */
export function visitorSystemPreview(metadata: unknown): VisitorSystemPreview | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (m.internal === true) return null;
  const kind = typeof m.kind === 'string' ? m.kind : '';
  if (!VISITOR_PREVIEW_KIND_SET.has(kind)) return null;
  const meta: VisitorSystemPreview['meta'] = {};
  for (const key of VISITOR_SYSTEM_META_KEYS) {
    const value = m[key];
    if (value === undefined || value === null) continue;
    if (NAME_KEYS.has(key)) {
      const name = visitorDisplayName(value);
      if (name) meta[key] = name;
    } else if (key === 'duration_seconds') {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      if (Number.isFinite(n)) meta.duration_seconds = n;
    } else if (key === 'channel') {
      if (typeof value === 'string') meta.channel = value === 'video' ? 'video' : 'audio';
    } else if (key === 'ended_by') {
      if (typeof value === 'string' && CALL_ENDED_BY.has(value)) meta.ended_by = value;
    } else if (key === 'end_reason') {
      if (typeof value === 'string' && value.length <= MAX_END_REASON_CHARS) meta.end_reason = value;
    }
  }
  return { kind: kind as VisitorPreviewSystemKind, meta };
}
