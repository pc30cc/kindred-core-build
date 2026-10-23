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
 *     not told. Since 2026-10-23 they are told by the newcomer's own first
 *     message: "X joined" right before it (operatorReplyJoin.ts), so the
 *     transfer line itself is the Inbox's again (written at the transfer,
 *     it named someone who had not written yet).
 *   - Being unassigned is genuinely internal: "nobody is handling you right
 *     now" helps no one.
 */
const WIDGET_ROUTE = readFileSync('server/routes/widget.ts', 'utf8');
// The inbox's assignee change, transfer and unassign write their notice here
// (the conversations PATCH and transfer routes call it).
const ASSIGNMENT = readFileSync('server/services/conversationAssignment.ts', 'utf8');
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

describe('a transfer and an unassign are the Inbox\'s; the visitor hears from the newcomer', () => {
  /** postAssignmentNotice, the notice of a hand-made assignee change. */
  const notice = () => ASSIGNMENT.slice(
    ASSIGNMENT.indexOf('async function postAssignmentNotice('),
    ASSIGNMENT.indexOf('/**', ASSIGNMENT.indexOf('async function postAssignmentNotice(')),
  );

  it('marks both internal', () => {
    expect(notice()).toContain('internal: true,');
    expect(notice()).not.toContain('internal: !a.to');
  });

  it('publishes neither on the visitor\'s channel', () => {
    expect(ASSIGNMENT).not.toContain('publishConversationEvent');
  });

  it('a transfer row stored before still reads as the next operator arriving, on the visitor side', () => {
    // One row, two audiences: the inbox says who moved it, the widget says
    // who is here now.
    expect(RENDERER).toContain("m.metadata.kind === 'conversation_transferred'");
    expect(RENDERER).toContain("if (kind === 'conversation_transferred') kind = 'routing_agent_joined';");
    // The name that matters to the visitor is whoever now holds it.
    expect(RENDERER).toContain('String(meta.agent_name || meta.to_name || \'\')');
  });
});

describe('a handoff from the AI names the human with their first message', () => {
  it('the already-assigned branch writes no join (it came after the reply, or named someone who never wrote)', () => {
    const start = ROUTING.indexOf('if (row.assigned_to) {');
    const block = ROUTING.slice(start, ROUTING.indexOf("return { outcome: 'already_assigned'", start));
    expect(block).not.toContain("kind: 'routing_agent_joined'");
    expect(block).not.toContain('insertRoutingSystemMessage');
  });

  it('still tags the outcome once per conversation, not on every handoff', () => {
    const start = ROUTING.indexOf('if (row.assigned_to) {');
    const block = ROUTING.slice(start, ROUTING.indexOf("return { outcome: 'already_assigned'", start));
    expect(block).toContain('metadata.routing_notice_sent !== true');
    expect(block).toContain('routing_notice_sent: true');
  });

  it('the reply writes the join, before the message, once per stretch after the AI', () => {
    const JOIN = readFileSync('server/services/operatorReplyJoin.ts', 'utf8');
    expect(JOIN).toContain("if (row.sender_type === 'ai') inStretch = false;");
    expect(JOIN).toContain("kind: 'routing_agent_joined'");
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
