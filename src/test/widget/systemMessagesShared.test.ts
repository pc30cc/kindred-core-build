/**
 * shared/systemMessages.ts: the kinds there are, and what of a system row a
 * visitor may read (the widget's home card, list, toast and quote write the
 * sentence from it in the visitor's language).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_AGENT_NAME,
  SYSTEM_MESSAGE_KINDS,
  isDefaultAiAgentName,
  VISITOR_PREVIEW_SYSTEM_KINDS,
  VISITOR_SYSTEM_META_KEYS,
  isPlaceholderName,
  looksLikeEmail,
  visitorDisplayName,
  visitorSystemPreview,
} from '../../../shared/systemMessages';

describe('system message kinds', () => {
  it('lists every kind once, and the visitor kinds are among them without the closed line', () => {
    expect(new Set(SYSTEM_MESSAGE_KINDS).size).toBe(SYSTEM_MESSAGE_KINDS.length);
    for (const kind of VISITOR_PREVIEW_SYSTEM_KINDS) expect(SYSTEM_MESSAGE_KINDS).toContain(kind);
    expect(VISITOR_PREVIEW_SYSTEM_KINDS).not.toContain('conversation_closed');
    expect(VISITOR_PREVIEW_SYSTEM_KINDS).not.toContain('conversation_unassigned');
    expect([...VISITOR_PREVIEW_SYSTEM_KINDS].sort()).toEqual([
      'call_ended', 'call_invitation', 'conversation_transferred',
      'routing_agent_joined', 'routing_in_queue', 'routing_no_agent_available',
    ]);
  });

  it('never lets an id or an actor through as visitor metadata', () => {
    for (const key of VISITOR_SYSTEM_META_KEYS) {
      expect(key).not.toMatch(/_id$/);
      expect(key).not.toMatch(/^(actor|from)_/);
    }
  });
});

describe('names a visitor may read', () => {
  it('knows the English placeholders, trimmed and in any case', () => {
    expect(isPlaceholderName('a colleague')).toBe(true);
    expect(isPlaceholderName('  A Colleague ')).toBe(true);
    expect(isPlaceholderName('An operator')).toBe(true);
    expect(isPlaceholderName('Sara')).toBe(false);
    expect(isPlaceholderName(null)).toBe(false);
    expect(isPlaceholderName(42)).toBe(false);
  });

  it('knows an email address', () => {
    expect(looksLikeEmail('sara@example.com')).toBe(true);
    expect(looksLikeEmail(' sara@example.com ')).toBe(true);
    expect(looksLikeEmail('Sara Ahmadi')).toBe(false);
    expect(looksLikeEmail('sara@local')).toBe(false);
    expect(looksLikeEmail(undefined)).toBe(false);
  });

  it('knows the AI agent\'s built-in English name', () => {
    expect(DEFAULT_AI_AGENT_NAME).toBe('AI Assistant');
    expect(isDefaultAiAgentName('AI Assistant')).toBe(true);
    expect(isDefaultAiAgentName(' AI Assistant ')).toBe(true);
    expect(isDefaultAiAgentName('نیلو')).toBe(false);
    expect(isDefaultAiAgentName(null)).toBe(false);
  });

  it('keeps a real name trimmed and drops placeholders, emails and non-strings', () => {
    expect(visitorDisplayName('  سارا  ')).toBe('سارا');
    expect(visitorDisplayName('Sara')).toBe('Sara');
    expect(visitorDisplayName('a colleague')).toBeNull();
    expect(visitorDisplayName('ops@example.com')).toBeNull();
    expect(visitorDisplayName('   ')).toBeNull();
    expect(visitorDisplayName(7)).toBeNull();
    expect(visitorDisplayName(null)).toBeNull();
  });
});

describe('visitorSystemPreview', () => {
  it('queue and no-agent rows carry their kind and nothing else', () => {
    expect(visitorSystemPreview({ kind: 'routing_in_queue' })).toEqual({ kind: 'routing_in_queue', meta: {} });
    expect(visitorSystemPreview({ kind: 'routing_no_agent_available', provider: 'telegram' }))
      .toEqual({ kind: 'routing_no_agent_available', meta: {} });
  });

  it('a join keeps the agent name and drops its id', () => {
    expect(visitorSystemPreview({ kind: 'routing_agent_joined', agent_name: ' Sara ', agent_id: 'u-1', actor_id: 'u-2', actor_name: 'Ali' }))
      .toEqual({ kind: 'routing_agent_joined', meta: { agent_name: 'Sara' } });
  });

  it('a join named with a placeholder or an email loses the name', () => {
    expect(visitorSystemPreview({ kind: 'routing_agent_joined', agent_name: 'a colleague', agent_id: 'u-1' }))
      .toEqual({ kind: 'routing_agent_joined', meta: {} });
    expect(visitorSystemPreview({ kind: 'routing_agent_joined', agent_name: 'sara@example.com' }))
      .toEqual({ kind: 'routing_agent_joined', meta: {} });
  });

  it('a transfer keeps the new holder only', () => {
    expect(visitorSystemPreview({
      kind: 'conversation_transferred', internal: false,
      actor_id: 'u-1', actor_name: 'Ali', from_id: 'u-1', from_name: 'Ali', to_id: 'u-2', to_name: 'Sara',
    })).toEqual({ kind: 'conversation_transferred', meta: { to_name: 'Sara' } });
  });

  it('an invitation keeps its channel and a real operator name, never an email', () => {
    expect(visitorSystemPreview({
      kind: 'call_invitation', invitation_id: 'inv-1', channel: 'video', status: 'pending',
      expires_at: '2026-10-18T10:00:00Z', operator_name: 'Sara',
    })).toEqual({ kind: 'call_invitation', meta: { channel: 'video', operator_name: 'Sara' } });
    expect(visitorSystemPreview({ kind: 'call_invitation', channel: 'audio', operator_name: 'ops@example.com' }))
      .toEqual({ kind: 'call_invitation', meta: { channel: 'audio' } });
    expect(visitorSystemPreview({ kind: 'call_invitation', channel: 'phone' }))
      .toEqual({ kind: 'call_invitation', meta: { channel: 'audio' } });
  });

  it('a call summary keeps who ended it, why and a finite duration', () => {
    expect(visitorSystemPreview({
      kind: 'call_ended', call_session_id: 'cs-1', call_type: 'video', ended_by: 'operator',
      end_reason: 'hangup', duration_seconds: 75, ended_at: '2026-10-18T10:00:00Z',
    })).toEqual({ kind: 'call_ended', meta: { ended_by: 'operator', end_reason: 'hangup', duration_seconds: 75 } });
    expect(visitorSystemPreview({ kind: 'call_ended', ended_by: 'someone', duration_seconds: Number.NaN }))
      .toEqual({ kind: 'call_ended', meta: {} });
    expect(visitorSystemPreview({ kind: 'call_ended', duration_seconds: '42' }))
      .toEqual({ kind: 'call_ended', meta: { duration_seconds: 42 } });
    expect(visitorSystemPreview({ kind: 'call_ended', duration_seconds: Infinity, end_reason: 'x'.repeat(65) }))
      .toEqual({ kind: 'call_ended', meta: {} });
  });

  it('is null for internal, closed, unknown and non-object rows', () => {
    expect(visitorSystemPreview({ kind: 'conversation_unassigned', internal: true })).toBeNull();
    expect(visitorSystemPreview({ kind: 'conversation_transferred', internal: true, to_name: 'Sara' })).toBeNull();
    expect(visitorSystemPreview({ kind: 'conversation_closed', by: 'agent' })).toBeNull();
    expect(visitorSystemPreview({ kind: 'support_rating' })).toBeNull();
    expect(visitorSystemPreview({ kind: 'platform_support_requester' })).toBeNull();
    expect(visitorSystemPreview({ kind: 'something_new' })).toBeNull();
    expect(visitorSystemPreview({})).toBeNull();
    expect(visitorSystemPreview(null)).toBeNull();
    expect(visitorSystemPreview('routing_in_queue')).toBeNull();
    expect(visitorSystemPreview([{ kind: 'routing_in_queue' }])).toBeNull();
  });
});
