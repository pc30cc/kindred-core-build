/**
 * Who has an Inbox, who may widen it to every conversation, and who may move
 * a conversation — the panel's half of shared/chatRoles.ts.
 *
 * Before: the Inbox was every member's (billing and SEO staff included);
 * "All conversations" appeared for the owner only, and only while a colleague
 * happened to be online — so at night, with chats still in the names of
 * operators who had gone home, it was hidden; admins and team leads, whom
 * the server allowed, never had it. Any member could move anyone's chat.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  assignmentActions,
  canSeeAllConversations,
  effectiveInboxScope,
  inboxAllowed,
  INBOX_SCOPE_EVENT,
  isAssignmentConflict,
  isTransferTarget,
  readStoredInboxScope,
  writeStoredInboxScope,
} from '@/lib/inboxAccess';
import { planAccessOf, sectionVisible, type SectionContext } from '@/lib/planAccess';
import { quickStatusAction, replyNeedsReopen } from '@/lib/inboxReply';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { AssignmentError } from '@/lib/conversations-api';

const STAFF = ['marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer'];
const TEAM = ['agent', 'team_lead', 'support_agent', 'sales_agent'];

describe('the Inbox itself', () => {
  it('is the owner\'s, the admins\' and the chat team\'s', () => {
    for (const role of ['owner', 'admin', ...TEAM]) expect(inboxAllowed(role), role).toBe(true);
  });

  it('is not offered to staff who do not answer chats', () => {
    for (const role of STAFF) expect(inboxAllowed(role), role).toBe(false);
    expect(inboxAllowed(null)).toBe(false);
  });

  it('stays offered while the role is still loading (the server refuses staff anyway)', () => {
    expect(inboxAllowed(undefined)).toBe(true);
  });

  it('is a section every surface reads the same way', () => {
    const ctx = (allowed: boolean): SectionContext => ({
      plan: planAccessOf(null, false),
      isAdmin: false,
      inboxAllowed: allowed,
      aiSurface: null,
      aiAutoAnswer: null,
      callCenterEnabled: null,
    });
    // Never plan-gated: a plan snapshot that has not loaded does not hide it.
    expect(sectionVisible('inbox', ctx(true))).toBe(true);
    expect(sectionVisible('inbox', ctx(false))).toBe(false);
  });
});

describe('"All conversations"', () => {
  beforeEach(() => window.localStorage.clear());

  it('is offered to every supervisor, whoever else is online', () => {
    for (const role of ['owner', 'admin', 'team_lead']) expect(canSeeAllConversations(role), role).toBe(true);
    for (const role of ['agent', 'support_agent', 'sales_agent', ...STAFF]) {
      expect(canSeeAllConversations(role), role).toBe(false);
    }
  });

  it('is only asked for by a role the server allows it', () => {
    expect(effectiveInboxScope('team_lead', 'all')).toBe('all');
    expect(effectiveInboxScope('admin', 'all')).toBe('all');
    expect(effectiveInboxScope('agent', 'all')).toBe('mine');
    expect(effectiveInboxScope(undefined, 'all')).toBe('mine');
    expect(effectiveInboxScope('owner', 'mine')).toBe('mine');
  });

  it('is remembered on this device and announced to the alerts', () => {
    expect(readStoredInboxScope()).toBe('mine');
    const heard: string[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent<{ scope: string }>).detail.scope);
    window.addEventListener(INBOX_SCOPE_EVENT, listener);
    writeStoredInboxScope('all');
    window.removeEventListener(INBOX_SCOPE_EVENT, listener);
    expect(readStoredInboxScope()).toBe('all');
    expect(heard).toEqual(['all']);
  });
});

describe('moving a conversation', () => {
  const ME = 'me';
  const OTHER = 'colleague';

  it('supervisors move anyone\'s', () => {
    for (const role of ['owner', 'admin', 'team_lead']) {
      expect(assignmentActions(role, ME, OTHER), role).toEqual({ take: true, transfer: true, unassign: true });
      expect(assignmentActions(role, ME, null), role).toEqual({ take: true, transfer: true, unassign: false });
      expect(assignmentActions(role, ME, ME), role).toEqual({ take: false, transfer: true, unassign: true });
    }
  });

  it('the rest of the team takes an unassigned one, or hands on and gives back their own', () => {
    for (const role of ['agent', 'support_agent', 'sales_agent']) {
      expect(assignmentActions(role, ME, null), role).toEqual({ take: true, transfer: false, unassign: false });
      expect(assignmentActions(role, ME, ME), role).toEqual({ take: false, transfer: true, unassign: true });
      // A colleague's: not theirs to move.
      expect(assignmentActions(role, ME, OTHER), role).toEqual({ take: false, transfer: false, unassign: false });
    }
  });

  it('staff without an Inbox move nothing', () => {
    for (const role of STAFF) expect(assignmentActions(role, ME, null), role).toEqual({ take: false, transfer: false, unassign: false });
  });

  it('is handed only to the owner and the chat team, never a suspended or paused seat', () => {
    expect(isTransferTarget({ role: 'owner' })).toBe(true);
    for (const role of TEAM) expect(isTransferTarget({ role }), role).toBe(true);
    for (const role of ['admin', ...STAFF]) expect(isTransferTarget({ role }), role).toBe(false);
    expect(isTransferTarget({ role: 'agent', suspended_at: '2026-10-01T00:00:00Z' })).toBe(false);
    expect(isTransferTarget({ role: 'agent', seat_locked: true })).toBe(false);
  });
});

describe('a finished conversation', () => {
  it('offers "Reopen" next to it, closed or resolved, and "Resolve" otherwise', () => {
    expect(quickStatusAction('closed')).toBe('reopen');
    expect(quickStatusAction('resolved')).toBe('reopen');
    expect(quickStatusAction('open')).toBe('resolve');
    expect(quickStatusAction('pending')).toBe('resolve');
  });

  it('is reopened before a reply only when closed (a resolved one reopens when the visitor writes)', () => {
    expect(replyNeedsReopen('closed')).toBe(true);
    expect(replyNeedsReopen('resolved')).toBe(false);
    expect(replyNeedsReopen('open')).toBe(false);
    expect(replyNeedsReopen(undefined)).toBe(false);
  });
});

describe('a take-over somebody else won', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POST …/take-over answering 409 already_assigned reads as "someone else has it", other refusals do not', async () => {
    const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    answer(409, { error: 'already_assigned', assigned_to: 'u-2' });
    const lost = await aiAgentApi.takeOverConversation('ws-1', 'c-1').catch((e: unknown) => e);
    expect(isAssignmentConflict(lost)).toBe(true);
    answer(500, { error: 'boom' });
    const failed = await aiAgentApi.takeOverConversation('ws-1', 'c-1').catch((e: unknown) => e);
    expect(isAssignmentConflict(failed)).toBe(false);
    expect(isAssignmentConflict(new AssignmentError('assignment_changed', 409, 'u-2'))).toBe(true);
    expect(isAssignmentConflict(new AssignmentError('not_allowed', 403))).toBe(false);
    expect(isAssignmentConflict(null)).toBe(false);
  });
});
