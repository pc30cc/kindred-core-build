import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Nobody was told when an operator picked a conversation up.
 *
 * Auto-routing has always written a `routing_agent_joined` notice, and both
 * the inbox and the widget have always known how to render one. But the
 * commonest path — an operator assigning an unassigned conversation from the
 * inbox — goes through the conversations PATCH route, which filed it as a
 * TRANSFER: `metadata.internal = true`, so the widget dropped it entirely,
 * and the operator read "X transferred this conversation to Y" about a
 * conversation nobody had been holding.
 *
 * Unassigned → assigned is somebody joining, and the visitor is the person
 * who has been waiting to hear it.
 */
const ROUTE = readFileSync('server/routes/conversations.ts', 'utf8');
const ROUTING = readFileSync('server/services/chatRouting.ts', 'utf8');
const WIDGET_RENDERER = readFileSync('public/widget/presentation-web-yar.js', 'utf8');

/** The assignment-notice block inside the PATCH route. */
function noticeBlock(): string {
  const start = ROUTE.indexOf('const isJoin = !before.assigned_to && !!parsed.data.assigned_to;');
  expect(start, 'the join/transfer split must exist').toBeGreaterThan(-1);
  return ROUTE.slice(start, ROUTE.indexOf('normalizedTags !== undefined', start));
}

describe('a conversation nobody held is JOINED, not transferred', () => {
  it('splits the two cases on whether anyone held it before', () => {
    expect(noticeBlock()).toContain('const isJoin = !before.assigned_to && !!parsed.data.assigned_to;');
  });

  it('files a join under the same kind auto-routing already emits', () => {
    // One kind means one renderer on each side, so the two paths can never
    // drift into showing different things for the same event.
    const block = noticeBlock();
    expect(block).toContain("kind: 'routing_agent_joined'");
    expect(block).toContain('agent_name: toName');
    expect(ROUTING).toContain("kind: 'routing_agent_joined'");
  });

  it('lets the visitor see a join', () => {
    const block = noticeBlock();
    const joinMeta = block.slice(block.indexOf('? {'), block.indexOf(': {'));
    // `internal: true` is what /poll and /history filter out — see
    // staffingNoticeVisibility.test.ts for who is told what, and why only
    // being UNASSIGNED stays inbox-only now.
    expect(joinMeta).not.toContain('internal');
    const transferMeta = block.slice(block.indexOf(': {'));
    expect(transferMeta).toContain("kind: parsed.data.assigned_to ? 'conversation_transferred' : 'conversation_unassigned'");
  });

  it('pushes it to the widget in real time', () => {
    // Otherwise the visitor only learns who joined on their next reload.
    const block = noticeBlock();
    expect(block).toContain('if (noticeRow && (isJoin || !!parsed.data.assigned_to)) {');
    expect(block).toContain('publishConversationEvent(');
    expect(block).toContain('buildMessageEnvelope({');
  });

  it('names the person who joined, not the person who did the assigning', () => {
    // Assigning someone else to an unheld conversation still reads as that
    // person joining, because from the visitor's side that is what happened.
    const block = noticeBlock();
    expect(block).toContain('`${toName || \'An operator\'} joined the conversation.`');
  });
});

describe('both sides can render it', () => {
  it('the widget draws a joined notice from the kind', () => {
    expect(WIDGET_RENDERER).toContain("kind === 'routing_agent_joined'");
    expect(WIDGET_RENDERER).toContain("m.metadata.kind === 'routing_agent_joined'");
  });

  it('the inbox draws one too', () => {
    expect(ROUTE.length).toBeGreaterThan(0);
    const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');
    expect(INBOX).toContain("meta.kind === 'routing_agent_joined'");
  });
});
