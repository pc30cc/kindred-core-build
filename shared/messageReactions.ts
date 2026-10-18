/**
 * Message reactions (issue #340 g2; migration 276): which emojis exist, who
 * may react to which message, and how the rows read back. Server, dashboard
 * and tests alike. Pure: no I/O.
 *
 * Rules (owner, 2026-10-17):
 *   - The visitor reacts with ❤️ only (one tap), to a message of the team:
 *     an operator's, the AI's or a bot's, never a system row, an inbox-only
 *     row or their own.
 *   - An operator reacts in the inbox with any of MESSAGE_REACTION_EMOJIS, to
 *     a visitor's message only, and only where the visitor sees it (a widget
 *     conversation of a workspace whose template draws reactions; the
 *     server's `workspaceShowsReactions`).
 *   - One reaction per (message, actor, emoji): a conversation has one
 *     visitor side, and each workspace member is an actor of their own. A
 *     write sets or unsets (`on`), never toggles blindly, so a retry is
 *     harmless.
 *
 * What a reader gets is a summary per message, in the allow-list's order:
 * `{ emoji, count, visitor, mine }`. Nothing anywhere names an operator: the
 * visitor's answers and the live event carry counts and the visitor's own
 * part only (visitorReactionList / eventReactionList).
 */

/** The reactions there are, in the order a summary lists them (❤️ is U+2764 U+FE0F). */
export const MESSAGE_REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const;

export type MessageReactionEmoji = (typeof MESSAGE_REACTION_EMOJIS)[number];

/** The one reaction a visitor gives. */
export const VISITOR_REACTION_EMOJI: MessageReactionEmoji = '❤️';

/** Characters a stored or requested emoji may have (the table's own bound). */
export const MESSAGE_REACTION_MAX_CHARS = 16;

/** Variation selectors: text (U+FE0E) and emoji (U+FE0F) presentation of the same character. */
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

const BY_BARE: ReadonlyMap<string, MessageReactionEmoji> = new Map(
  MESSAGE_REACTION_EMOJIS.map((e) => [e.replace(VARIATION_SELECTORS, ''), e]),
);

/**
 * The allow-listed emoji `value` stands for, or null. Surrounding spaces and
 * the presentation selectors are ignored, so a bare U+2764 (what some
 * keyboards send) is ❤️; anything else must be exactly one of the list: a
 * skin tone, a ZWJ sequence (❤️‍🔥) or a second emoji is not.
 */
export function normalizeReactionEmoji(value: unknown): MessageReactionEmoji | null {
  if (typeof value !== 'string' || value.length > MESSAGE_REACTION_MAX_CHARS) return null;
  const bare = value.trim().replace(VARIATION_SELECTORS, '');
  return BY_BARE.get(bare) ?? null;
}

/**
 * The emoji a reader may take back (`on: false`): an allow-listed one
 * (normalizeReactionEmoji), or exactly a stored one since dropped from the
 * list — one to sixteen characters with no space, as the table bounds it —
 * which nobody can give any more but whoever gave it can still take back.
 */
export function reactionEmojiToTakeBack(value: unknown): string | null {
  const listed = normalizeReactionEmoji(value);
  if (listed) return listed;
  if (typeof value !== 'string') return null;
  const stored = value.trim();
  return stored && [...stored].length <= MESSAGE_REACTION_MAX_CHARS && !/\s/.test(stored) ? stored : null;
}

export type ReactionActorType = 'visitor' | 'operator';

/** One stored reaction (conversation_message_reactions). */
export interface ReactionRow {
  message_id: string;
  emoji: string;
  actor_type: ReactionActorType | string;
  actor_id: string | null;
}

/** One emoji of a message's reactions, as a reader sees it. */
export interface MessageReactionSummary {
  emoji: string;
  /** Reactions of this emoji, everyone's. */
  count: number;
  /** The visitor gave it. */
  visitor: boolean;
  /** The reader gave it (the visitor reading as the visitor, an operator as themselves). */
  mine: boolean;
}

export type ReactionViewer = { type: 'visitor' } | { type: 'operator'; userId: string };

function emojiRank(emoji: string): number {
  const i = (MESSAGE_REACTION_EMOJIS as readonly string[]).indexOf(emoji);
  return i === -1 ? MESSAGE_REACTION_EMOJIS.length : i;
}

/** A summary list in display order: the allow-list's, then any emoji no longer in it. */
function ordered(list: MessageReactionSummary[]): MessageReactionSummary[] {
  return list.slice().sort((a, b) => emojiRank(a.emoji) - emojiRank(b.emoji) || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0));
}

/**
 * The rows' summary per message id, for one reader. Messages without a row
 * are absent. An emoji since dropped from the list stays visible after the
 * others (nobody can add it any more; whoever gave it can still take it back).
 */
export function summarizeReactions(rows: readonly ReactionRow[], viewer: ReactionViewer): Map<string, MessageReactionSummary[]> {
  const byMessage = new Map<string, Map<string, MessageReactionSummary>>();
  for (const row of rows) {
    if (!row || typeof row.message_id !== 'string' || typeof row.emoji !== 'string' || !row.emoji) continue;
    let kinds = byMessage.get(row.message_id);
    if (!kinds) byMessage.set(row.message_id, (kinds = new Map()));
    let entry = kinds.get(row.emoji);
    if (!entry) kinds.set(row.emoji, (entry = { emoji: row.emoji, count: 0, visitor: false, mine: false }));
    entry.count += 1;
    const byVisitor = row.actor_type === 'visitor';
    if (byVisitor) entry.visitor = true;
    if (viewer.type === 'visitor' ? byVisitor : row.actor_type === 'operator' && row.actor_id === viewer.userId) entry.mine = true;
  }
  const out = new Map<string, MessageReactionSummary[]>();
  for (const [id, kinds] of byMessage) out.set(id, ordered([...kinds.values()]));
  return out;
}

/** What the visitor's widget gets for one message: no `visitor` flag (it is `mine`), no ids. */
export function visitorReactionList(list: readonly MessageReactionSummary[]): Array<{ emoji: string; count: number; mine: boolean }> {
  return list.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine }));
}

/** What the live event carries for one message, the same for every reader: no `mine`, no ids. */
export function eventReactionList(list: readonly MessageReactionSummary[]): Array<{ emoji: string; count: number; visitor: boolean }> {
  return list.map((r) => ({ emoji: r.emoji, count: r.count, visitor: r.visitor }));
}

/**
 * The list after the reader sets (`on`) or takes back their reaction of
 * `emoji`, for an optimistic screen until the server answers. Setting what
 * the reader already gave, or taking back what they did not, changes nothing
 * (as on the server); a kind left with nobody goes.
 */
export function applyReactionToggle(
  list: readonly MessageReactionSummary[] | null | undefined,
  emoji: string,
  on: boolean,
  actor: ReactionActorType,
): MessageReactionSummary[] {
  const current = (list || []).map((r) => ({ ...r }));
  const entry = current.find((r) => r.emoji === emoji);
  if (on) {
    if (entry?.mine) return current;
    if (entry) {
      entry.count += 1;
      entry.mine = true;
      if (actor === 'visitor') entry.visitor = true;
      return current;
    }
    return ordered([...current, { emoji, count: 1, visitor: actor === 'visitor', mine: true }]);
  }
  if (!entry || !entry.mine) return current;
  entry.count -= 1;
  entry.mine = false;
  if (actor === 'visitor') entry.visitor = false;
  return current.filter((r) => r.count > 0);
}

/** The part of a message row the rules below read. */
export interface ReactableMessage {
  sender_type?: string | null;
  metadata?: unknown;
}

function isInboxOnly(m: ReactableMessage): boolean {
  const meta = m.metadata && typeof m.metadata === 'object' && !Array.isArray(m.metadata)
    ? m.metadata as Record<string, unknown>
    : null;
  return !!meta && meta.internal === true;
}

/** A message the visitor may react to: the team's (operator, AI, bot), visitor-visible. */
export function reactableByVisitor(m: ReactableMessage): boolean {
  return (m.sender_type === 'agent' || m.sender_type === 'ai' || m.sender_type === 'bot') && !isInboxOnly(m);
}

/** A message an operator may react to: the visitor's own. */
export function reactableByOperator(m: ReactableMessage): boolean {
  return m.sender_type === 'contact' && !isInboxOnly(m);
}

/** A conversation the widget shows: no channel recorded, or the widget's own. */
export function isWidgetChannel(channel: unknown): boolean {
  const ch = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  return !ch || ch === 'widget';
}
