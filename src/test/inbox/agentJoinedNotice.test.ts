import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Who writes the visitor's "X joined the conversation", and when.
 *
 * It used to be written at ASSIGNMENT — by routing (every method), by the
 * already-assigned branch of an AI handoff, by a claim, and by the PATCH or
 * transfer from unassigned to X. The owner's screenshot (2026-10-23) shows
 * what that gives: a join after the operator's first message (the
 * assignment landed after the reply), and a join naming someone who never
 * wrote. Now ONE place writes it: the operator's reply
 * (POST /api/conversations/send-message, server/services/operatorReplyJoin.ts),
 * right before their first message after the AI. The order and the name are
 * right by construction.
 */
const ASSIGNMENT = readFileSync('server/services/conversationAssignment.ts', 'utf8');
const ROUTING = readFileSync('server/services/chatRouting.ts', 'utf8');
const JOIN = readFileSync('server/services/operatorReplyJoin.ts', 'utf8');
const ROUTE = readFileSync('server/routes/conversations.ts', 'utf8');
const WIDGET_RENDERER = readFileSync('public/widget/presentation-default.js', 'utf8');

/** The send-message handler. */
function sendMessage(): string {
  const start = ROUTE.indexOf("conversationsRouter.post('/send-message'");
  expect(start, 'the send-message route must exist').toBeGreaterThan(-1);
  return ROUTE.slice(start, ROUTE.indexOf('conversationsRouter.', start + 10));
}

/** The assignment-notice function (postAssignmentNotice). */
function noticeBlock(): string {
  const start = ASSIGNMENT.indexOf('async function postAssignmentNotice(');
  expect(start, 'postAssignmentNotice must exist').toBeGreaterThan(-1);
  return ASSIGNMENT.slice(start, ASSIGNMENT.indexOf('/**', start));
}

describe('only the operator\'s reply introduces them', () => {
  it('operatorReplyJoin.ts writes the join, under the same kind the readers already know', () => {
    expect(JOIN).toContain("kind: 'routing_agent_joined', agent_id: a.userId, agent_name: name");
    expect(JOIN).toContain('agentJoinedBody(name)');
    expect(JOIN).toContain('resolveAgentDisplayName(config, a.userId)');
  });

  it('nothing else on the server writes one', () => {
    for (const [file, src] of [['chatRouting.ts', ROUTING], ['conversationAssignment.ts', ASSIGNMENT], ['conversations.ts', ROUTE]] as const) {
      expect(src, file).not.toContain("kind: 'routing_agent_joined'");
    }
  });

  it('routing\'s assignment, the already-assigned handoff and a claim post nothing in the thread', () => {
    const announce = ROUTING.slice(ROUTING.indexOf('async function announceAssignment('), ROUTING.indexOf('/**', ROUTING.indexOf('async function announceAssignment(')));
    expect(announce).not.toContain('insertRoutingSystemMessage');
    expect(announce).toContain("eventType: 'assigned'");
    const assigned = ROUTING.slice(ROUTING.indexOf('if (row.assigned_to) {'), ROUTING.indexOf("return { outcome: 'already_assigned'", ROUTING.indexOf('if (row.assigned_to) {')));
    expect(assigned).not.toContain('insertRoutingSystemMessage');
    expect(assigned).toContain("'already_assigned', { routing_notice_sent: true, ...pending }");
    const claim = ROUTING.slice(ROUTING.indexOf('export async function claimConversationManually('));
    expect(claim).not.toContain('insertRoutingSystemMessage');
    expect(claim).toContain("reason: 'manual_claim'");
  });

  it('send-message writes the line before the reply\'s insert, under the conversation\'s lock', () => {
    const handler = sendMessage();
    const lock = handler.indexOf('await lockConversationReplies(parsed.data.conversation_id)');
    const join = handler.indexOf('join = await introduceOperatorBeforeReply(config, {');
    const insert = handler.indexOf("sender_type: 'agent',");
    const release = handler.indexOf('releaseReplyLock?.();');
    expect(lock).toBeGreaterThan(-1);
    expect(join).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(join);
    expect(release).toBeGreaterThan(insert);
  });

  it('send-message awaits the line\'s publish before the reply\'s', () => {
    const handler = sendMessage();
    // A millisecond before the reply first (joinTimeBefore), then published.
    const separated = handler.indexOf('join = await separateJoinFromReply(config, join, ');
    const joinPublish = handler.indexOf('await publishReplyJoin(config, parsed.data.workspace_id, join);');
    const replyPublish = handler.indexOf('await publishConversationEvent(');
    expect(separated).toBeGreaterThan(-1);
    expect(joinPublish).toBeGreaterThan(separated);
    expect(replyPublish).toBeGreaterThan(joinPublish);
    expect(JOIN).toContain('await publishConversationEvent(config, workspaceId, row.conversation_id, buildMessageEnvelope(');
  });

  it('a reply that was not written by this request takes its line back', () => {
    const handler = sendMessage();
    expect(handler).toMatch(/if \(join\) await dropReplyJoin\(config, join\.id\);\s*return res\.status\(500\)/);
    expect(handler).toMatch(/if \(duplicate && join\) \{\s*await dropReplyJoin\(config, join\.id\);\s*join = null;/);
  });
});

describe('a hand-made assignment tells the Inbox, not the visitor', () => {
  it('unassigned → X posts nothing (X\'s line comes with X\'s first message)', () => {
    expect(noticeBlock()).toContain('if (!a.from && a.to) return;');
  });

  it('a transfer and an unassign are internal and never published on the conversation channel', () => {
    const block = noticeBlock();
    expect(block).toContain("kind: a.to ? 'conversation_transferred' : 'conversation_unassigned'");
    expect(block).toContain('internal: true,');
    expect(ASSIGNMENT).not.toContain('publishConversationEvent');
    expect(ASSIGNMENT).not.toContain('buildMessageEnvelope');
  });

  it('colleagues\' open thread shows the line live: an operator-only event once it is written', () => {
    const block = noticeBlock();
    const written = block.indexOf("if (insertError) throw new Error(insertError.message);");
    const told = block.indexOf("kind: 'timeline_event'");
    expect(written).toBeGreaterThan(-1);
    expect(told).toBeGreaterThan(written);
    expect(block.slice(told)).toContain('{ skipConversationChannel: true }');
  });
});

describe('both sides can render it', () => {
  it('the widget draws a joined notice from the kind', () => {
    expect(WIDGET_RENDERER).toContain("kind === 'routing_agent_joined'");
    expect(WIDGET_RENDERER).toContain("m.metadata.kind === 'routing_agent_joined'");
  });

  it('the inbox draws one too', () => {
    expect(ASSIGNMENT.length).toBeGreaterThan(0);
    // Every system row goes to SystemNoticeRow, which writes it with the
    // shared localizer (src/test/inbox/inboxSystemRows.test.tsx).
    const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');
    const LOCALIZER = readFileSync('shared/systemMessageText.ts', 'utf8');
    expect(INBOX).toContain('<SystemNoticeRow');
    expect(LOCALIZER).toContain("case 'routing_agent_joined'");
  });
});
