import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isInternalMessage } from '../../../server/routes/widget.js';

/**
 * Who is told what when a conversation changes hands.
 *
 * Three different events used to be conflated, and the visitor got the worst
 * of all three:
 *
 *   - Several places in the server carried a comment saying the widget
 *     filters `metadata.internal === true` out of /poll and /history.
 *     NOTHING EVER DID. The widget has no renderer branch for a staffing
 *     notice, so it fell through to a plain chat bubble and the visitor read
 *     "Ali unassigned this conversation" — in English, as if an operator had
 *     typed it.
 *   - A transfer between operators was marked internal, so the person who
 *     most needed to know that somebody new had arrived was the one person
 *     not told.
 *   - Being unassigned is genuinely internal: "nobody is handling you right
 *     now" helps no one.
 */
const WIDGET_ROUTE = readFileSync('server/routes/widget.ts', 'utf8');
const CONVERSATIONS_ROUTE = readFileSync('server/routes/conversations.ts', 'utf8');
const RENDERER = readFileSync('public/widget/presentation-default.js', 'utf8');
const ROUTING = readFileSync('server/services/chatRouting.ts', 'utf8');

describe('the internal filter the comments always promised', () => {
  it('drops a system notice marked internal', () => {
    expect(isInternalMessage({
      sender_type: 'system',
      metadata: { kind: 'conversation_unassigned', internal: true },
    })).toBe(true);
  });

  it('keeps a system notice that is not marked internal', () => {
    for (const metadata of [
      { kind: 'conversation_transferred', to_name: 'Sara' },
      { kind: 'routing_agent_joined', agent_name: 'Sara' },
      { kind: 'call_ended', ended_by: 'operator' },
      { kind: 'conversation_unassigned', internal: false },
      {},
    ]) {
      expect(isInternalMessage({ sender_type: 'system', metadata }), JSON.stringify(metadata))
        .toBe(false);
    }
  });

  it('never touches a real message, whatever its metadata says', () => {
    // `internal` is a system-notice concept. A visitor or operator message
    // carrying the key by accident must still be delivered.
    for (const sender of ['contact', 'agent', 'ai']) {
      expect(isInternalMessage({ sender_type: sender, metadata: { internal: true } }), sender)
        .toBe(false);
    }
  });

  it('survives a missing or malformed metadata column', () => {
    expect(isInternalMessage({ sender_type: 'system' })).toBe(false);
    expect(isInternalMessage({ sender_type: 'system', metadata: null })).toBe(false);
    expect(isInternalMessage({ sender_type: 'system', metadata: 'not an object' })).toBe(false);
  });

  it('is applied on both delivery paths, not just one', () => {
    // /poll and /history both build the visitor's view of a thread; a filter
    // on only one of them is a filter that does nothing.
    const uses = WIDGET_ROUTE.match(/\.filter\(\(m\) => !isInternalMessage\(m\)\)/g);
    expect(uses).toHaveLength(2);
  });
});

describe('a transfer is news for the visitor; an unassign is not', () => {
  it('marks only the unassign internal', () => {
    expect(CONVERSATIONS_ROUTE).toContain('internal: !parsed.data.assigned_to,');
    // The blanket `internal: true` on both is what hid transfers.
    const block = CONVERSATIONS_ROUTE.slice(
      CONVERSATIONS_ROUTE.indexOf('const isJoin = !before.assigned_to'),
      CONVERSATIONS_ROUTE.indexOf('normalizedTags !== undefined'),
    );
    expect(block).not.toContain('internal: true,');
  });

  it('pushes a transfer to the widget in real time, like a join', () => {
    expect(CONVERSATIONS_ROUTE)
      .toContain('if (noticeRow && (isJoin || !!parsed.data.assigned_to)) {');
  });

  it('reads a transfer as the next operator arriving, on the visitor side', () => {
    // One row, two audiences: the inbox says who moved it, the widget says
    // who is here now.
    expect(RENDERER).toContain("m.metadata.kind === 'conversation_transferred'");
    expect(RENDERER).toContain("if (kind === 'conversation_transferred') kind = 'routing_agent_joined';");
    // The name that matters to the visitor is whoever now holds it.
    expect(RENDERER).toContain('String(meta.agent_name || meta.to_name || \'\')');
  });
});

describe('a handoff from the AI always names the human', () => {
  it('announces the assignee even when nobody needed routing', () => {
    // `already_assigned` returned early and said nothing, so a visitor handed
    // over from the AI to an operator who already held the conversation was
    // never told who they were now talking to.
    const block = ROUTING.slice(
      ROUTING.indexOf('if (conv.assigned_to) {'),
      ROUTING.indexOf("return { outcome: 'already_assigned'"),
    );
    expect(block).toContain("kind: 'routing_agent_joined'");
    expect(block).toContain('resolveAgentDisplayName(config, conv.assigned_to as string)');
  });

  it('says it once per conversation, not on every handoff', () => {
    const block = ROUTING.slice(
      ROUTING.indexOf('if (conv.assigned_to) {'),
      ROUTING.indexOf("return { outcome: 'already_assigned'"),
    );
    expect(block).toContain("metadata.routing_notice_sent !== true");
    expect(block).toContain('routing_notice_sent: true');
  });
});

describe('the Persian wording', () => {
  it('calls a conversation a conversation, not a case file', () => {
    const fa = readFileSync('src/i18n/locales/fa.ts', 'utf8');
    const line = fa.split('\n').find((l) => l.includes("'system.transferred':"))!;
    expect(line).toContain('گفتگو');
    expect(line).not.toContain('پرونده');
    const unassigned = fa.split('\n').find((l) => l.includes("'system.unassigned':"))!;
    expect(unassigned).not.toContain('پرونده');
  });
});
