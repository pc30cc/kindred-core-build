// @vitest-environment node
/**
 * The rules of message reactions (shared/messageReactions.ts, issue #340 g2):
 * which emojis exist (a bare U+2764 is ❤️; skin tones, ZWJ sequences and
 * anything longer than 16 characters are not), how stored rows read back for
 * the visitor and for an operator (counts, `visitor`, `mine`, allow-list
 * order), the optimistic toggle, who may react to what, and that only
 * Template 2's descriptor offers reactions.
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_REACTION_EMOJIS,
  applyReactionToggle,
  eventReactionList,
  isWidgetChannel,
  normalizeReactionEmoji,
  reactableByOperator,
  reactionEmojiToTakeBack,
  reactableByVisitor,
  summarizeReactions,
  visitorReactionList,
  type ReactionRow,
} from '../../../shared/messageReactions';
import { CHAT_WIDGET_TEMPLATES, type ChatWidgetTemplateId } from '../../../shared/widgetTemplates';

const HEART = '❤️';
const SARA = '22222222-2222-4222-8222-222222222222';
const ALI = '33333333-3333-4333-8333-333333333333';

describe('normalizeReactionEmoji', () => {
  it('knows exactly the six reactions, ❤️ as U+2764 U+FE0F', () => {
    expect(MESSAGE_REACTION_EMOJIS).toEqual([HEART, '👍', '😂', '😮', '😢', '🙏']);
    for (const e of MESSAGE_REACTION_EMOJIS) expect(normalizeReactionEmoji(e)).toBe(e);
  });

  it('a bare heart, a text-style heart, a stray selector and spaces read as the listed emoji', () => {
    expect(normalizeReactionEmoji('❤')).toBe(HEART);
    expect(normalizeReactionEmoji('❤︎')).toBe(HEART);
    expect(normalizeReactionEmoji(' ❤️ ')).toBe(HEART);
    expect(normalizeReactionEmoji('👍️')).toBe('👍');
  });

  it('refuses everything else: other emojis, skin tones, ZWJ sequences, two emojis, text, non-strings, > 16 chars', () => {
    for (const v of [
      '🔥', '👍🏽', '❤️‍🔥', '❤‍🔥', '👍👍', '❤️❤️', 'like', '', ' ', '<3',
      null, undefined, 1, {}, [HEART], `${' '.repeat(15)}${HEART}`,
    ]) {
      expect(normalizeReactionEmoji(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe('reactionEmojiToTakeBack', () => {
  it('a listed emoji as normalizeReactionEmoji reads it, or a stored one since dropped: 1-16 characters, no space', () => {
    expect(reactionEmojiToTakeBack('❤')).toBe(HEART);
    expect(reactionEmojiToTakeBack(' 🔥 ')).toBe('🔥');
    expect(reactionEmojiToTakeBack('❤️\u200d🔥')).toBe('❤️\u200d🔥');
    for (const v of ['', '   ', 'a b', 'x'.repeat(17), null, 3, {}]) expect(reactionEmojiToTakeBack(v), String(v)).toBeNull();
  });
});

describe('summarizeReactions', () => {
  const rows: ReactionRow[] = [
    { message_id: 'm1', emoji: '👍', actor_type: 'operator', actor_id: SARA },
    { message_id: 'm1', emoji: HEART, actor_type: 'visitor', actor_id: null },
    { message_id: 'm1', emoji: HEART, actor_type: 'operator', actor_id: ALI },
    { message_id: 'm1', emoji: '🔥', actor_type: 'operator', actor_id: SARA },
    { message_id: 'm2', emoji: '🙏', actor_type: 'operator', actor_id: ALI },
  ];

  it('counts per emoji in the allow-list order, an emoji no longer listed after the rest; messages without rows are absent', () => {
    const map = summarizeReactions(rows, { type: 'visitor' });
    expect([...map.keys()].sort()).toEqual(['m1', 'm2']);
    expect(map.get('m1')).toEqual([
      { emoji: HEART, count: 2, visitor: true, mine: true },
      { emoji: '👍', count: 1, visitor: false, mine: false },
      { emoji: '🔥', count: 1, visitor: false, mine: false },
    ]);
    expect(map.get('m2')).toEqual([{ emoji: '🙏', count: 1, visitor: false, mine: false }]);
  });

  it('`mine` is the reader\'s own: the visitor reads the visitor rows, each operator their own', () => {
    const sara = summarizeReactions(rows, { type: 'operator', userId: SARA }).get('m1')!;
    const ali = summarizeReactions(rows, { type: 'operator', userId: ALI }).get('m1')!;
    expect(sara.map((r) => [r.emoji, r.mine])).toEqual([[HEART, false], ['👍', true], ['🔥', true]]);
    expect(ali.map((r) => [r.emoji, r.mine])).toEqual([[HEART, true], ['👍', false], ['🔥', false]]);
  });

  it('the visitor and the event get counts and no ids: the visitor its own part, the event the visitor\'s', () => {
    const list = summarizeReactions(rows, { type: 'operator', userId: SARA }).get('m1')!;
    expect(eventReactionList(list)).toEqual([
      { emoji: HEART, count: 2, visitor: true },
      { emoji: '👍', count: 1, visitor: false },
      { emoji: '🔥', count: 1, visitor: false },
    ]);
    const forVisitor = visitorReactionList(summarizeReactions(rows, { type: 'visitor' }).get('m1')!);
    expect(forVisitor[0]).toEqual({ emoji: HEART, count: 2, mine: true });
    expect(JSON.stringify(forVisitor) + JSON.stringify(eventReactionList(list))).not.toMatch(/actor|[0-9a-f]{8}-/);
  });
});

describe('applyReactionToggle (the inbox\'s optimistic screen)', () => {
  const list = [{ emoji: HEART, count: 1, visitor: true, mine: false }];

  it('adds the reader\'s reaction to a kind or as a new kind in its place, and takes it back', () => {
    const added = applyReactionToggle(list, '👍', true, 'operator');
    expect(added).toEqual([...list, { emoji: '👍', count: 1, visitor: false, mine: true }]);
    const both = applyReactionToggle(added, HEART, true, 'operator');
    expect(both[0]).toEqual({ emoji: HEART, count: 2, visitor: true, mine: true });
    expect(applyReactionToggle(both, HEART, false, 'operator')[0]).toEqual({ emoji: HEART, count: 1, visitor: true, mine: false });
    // A kind left with nobody goes.
    expect(applyReactionToggle(added, '👍', false, 'operator')).toEqual(list);
    // Order follows the allow-list, whatever the order of clicks.
    expect(applyReactionToggle([{ emoji: '🙏', count: 1, visitor: false, mine: false }], HEART, true, 'operator').map((r) => r.emoji))
      .toEqual([HEART, '🙏']);
  });

  it('setting what is set, or taking back what is not, changes nothing (as on the server); the input is not mutated', () => {
    const mine = [{ emoji: HEART, count: 1, visitor: false, mine: true }];
    expect(applyReactionToggle(mine, HEART, true, 'operator')).toEqual(mine);
    expect(applyReactionToggle(list, HEART, false, 'operator')).toEqual(list);
    expect(applyReactionToggle(undefined, HEART, false, 'visitor')).toEqual([]);
    applyReactionToggle(list, HEART, true, 'visitor');
    expect(list).toEqual([{ emoji: HEART, count: 1, visitor: true, mine: false }]);
  });

  it('the visitor\'s own toggle moves the `visitor` flag with `mine`', () => {
    const on = applyReactionToggle([], HEART, true, 'visitor');
    expect(on).toEqual([{ emoji: HEART, count: 1, visitor: true, mine: true }]);
    expect(applyReactionToggle(on, HEART, false, 'visitor')).toEqual([]);
  });
});

describe('who may react to what', () => {
  it('the visitor: the team\'s messages (operator, AI, bot), never a system row, an inbox-only row or their own', () => {
    expect(reactableByVisitor({ sender_type: 'agent' })).toBe(true);
    expect(reactableByVisitor({ sender_type: 'ai', metadata: { agent_name: 'Bot' } })).toBe(true);
    expect(reactableByVisitor({ sender_type: 'bot' })).toBe(true);
    expect(reactableByVisitor({ sender_type: 'agent', metadata: { internal: true } })).toBe(false);
    expect(reactableByVisitor({ sender_type: 'system', metadata: { kind: 'routing_agent_joined' } })).toBe(false);
    expect(reactableByVisitor({ sender_type: 'contact' })).toBe(false);
    expect(reactableByVisitor({ sender_type: null })).toBe(false);
  });

  it('an operator: the visitor\'s messages only', () => {
    expect(reactableByOperator({ sender_type: 'contact' })).toBe(true);
    expect(reactableByOperator({ sender_type: 'contact', metadata: { internal: true } })).toBe(false);
    for (const t of ['agent', 'ai', 'bot', 'system']) expect(reactableByOperator({ sender_type: t })).toBe(false);
  });

  it('a widget conversation: no channel, or the widget\'s', () => {
    expect(isWidgetChannel(null)).toBe(true);
    expect(isWidgetChannel('')).toBe(true);
    expect(isWidgetChannel(' Widget ')).toBe(true);
    for (const ch of ['telegram', 'whatsapp', 'instagram', 'bale', 'platform_support', 'email']) expect(isWidgetChannel(ch)).toBe(false);
  });

  it('only Template 2\'s renderer draws reactions: t2 and its RESPOK skin t2-intl (the inbox offers React for no other workspace)', () => {
    const ids = Object.keys(CHAT_WIDGET_TEMPLATES) as ChatWidgetTemplateId[];
    const withReactions = ids.filter((id) => CHAT_WIDGET_TEMPLATES[id].reactions);
    expect(withReactions).toEqual(['t2', 't2-intl']);
    for (const id of withReactions) expect(CHAT_WIDGET_TEMPLATES[id].script, id).toBe(CHAT_WIDGET_TEMPLATES.t2.script);
  });
});
