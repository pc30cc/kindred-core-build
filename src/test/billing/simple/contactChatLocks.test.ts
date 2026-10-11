/**
 * Simple billing phase 4 — the contact and chat lock rules the routes use
 * (server/services/contactChatLocks.ts), against a lock state as the lock
 * core reads it from migration 264:
 *   - a contact is locked only when the plan counts it (D1: never spam,
 *     never an anonymous visitor without a name, email or phone — the
 *     legacy 'Visitor' name included) and it ranks after the cutoff;
 *   - a chat is locked when its last activity is before the retention cutoff;
 *   - nothing is locked while the state is disabled;
 *   - the panel row is redacted only when locked;
 *   - the widget announces `quota_full` only when it was resolved.
 */
import { describe, it, expect } from 'vitest';
import {
  contactLockedBody,
  contactRowForPanel,
  conversationLockedBody,
  isContactLocked,
  isConversationLocked,
  isCountableContact,
} from '../../../../server/services/contactChatLocks.js';
import { unlockedState, type LockState } from '../../../../server/services/billing/locks/state.js';
import { snapshotToWirePayload, type AvailabilitySnapshot } from '../../../../server/services/widget/availability.js';

const CUT_ID = '33333333-3333-4333-8333-333333333333';

function lockedState(): LockState {
  return {
    enabled: true,
    kb: null,
    member: null,
    contact: { limit: 2, total: 4, locked: 2, cut: { ts: '2026-01-02 00:00:00+00', id: CUT_ID } },
    conversation: { limit: 30, total: 5, locked: 1, cut: { ts: '2026-03-01T00:00:00.000000+00:00', id: null } },
  };
}

const contact = (over: Record<string, unknown> = {}) => ({
  id: '44444444-4444-4444-8444-444444444444',
  created_at: '2026-01-05T00:00:00Z',
  is_spam: false,
  name: 'Cleo',
  email: 'cleo@example.com',
  phone: null,
  metadata: {},
  ...over,
});

describe('isCountableContact (D1)', () => {
  it('counts an ordinary contact, and an identified one that was anonymous', () => {
    expect(isCountableContact(contact())).toBe(true);
    expect(isCountableContact(contact({ metadata: { anonymous: true }, name: null, email: 'x@example.com' }))).toBe(true);
    expect(isCountableContact(contact({ metadata: { anonymous: 'true' }, name: null, email: null, phone: '+1555' }))).toBe(true);
  });

  it('never counts spam or an anonymous visitor without a name, email or phone', () => {
    expect(isCountableContact(contact({ is_spam: true }))).toBe(false);
    expect(isCountableContact(contact({ metadata: { anonymous: true }, name: null, email: null, phone: null }))).toBe(false);
    expect(isCountableContact(contact({ metadata: { anonymous: true }, name: '  ', email: '', phone: null }))).toBe(false);
    expect(isCountableContact(contact({ metadata: { anonymous: true }, name: 'Visitor', email: null, phone: null }))).toBe(false);
  });
});

describe('isContactLocked', () => {
  it('locks a counted contact ranked after the cutoff; the cutoff row itself stays', () => {
    const s = lockedState();
    expect(isContactLocked(s, contact())).toBe(true);
    expect(isContactLocked(s, contact({ created_at: '2026-01-01T00:00:00Z' }))).toBe(false);
    expect(isContactLocked(s, contact({ id: CUT_ID, created_at: '2026-01-02T00:00:00Z' }))).toBe(false);
    // Same time, larger id: after the cutoff.
    expect(isContactLocked(s, contact({ id: '44444444-0000-4000-8000-000000000000', created_at: '2026-01-02T00:00:00Z' }))).toBe(true);
  });

  it('never locks spam, an anonymous visitor, or anything while the state is off', () => {
    const s = lockedState();
    expect(isContactLocked(s, contact({ is_spam: true }))).toBe(false);
    expect(isContactLocked(s, contact({ metadata: { anonymous: true }, name: null, email: null }))).toBe(false);
    expect(isContactLocked(unlockedState(), contact())).toBe(false);
    expect(isContactLocked({ ...s, contact: { ...s.contact!, cut: null } }, contact())).toBe(false);
  });
});

describe('isConversationLocked (D2: by last activity)', () => {
  it('locks a chat whose last activity is before the cutoff, by updated_at first', () => {
    const s = lockedState();
    expect(isConversationLocked(s, { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' })).toBe(true);
    expect(isConversationLocked(s, { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-02T00:00:00Z' })).toBe(false);
    expect(isConversationLocked(s, { created_at: '2026-01-01T00:00:00Z', updated_at: null })).toBe(true);
    expect(isConversationLocked(s, { created_at: null, updated_at: null })).toBe(false);
  });

  it('locks nothing while the state is off or the plan keeps chats forever', () => {
    expect(isConversationLocked(unlockedState(), { updated_at: '2020-01-01T00:00:00Z' })).toBe(false);
    expect(isConversationLocked({ ...lockedState(), conversation: null }, { updated_at: '2020-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('contactRowForPanel and the 403 bodies', () => {
  it('redacts a locked contact (only id, workspace and creation time stay) and keeps an unlocked one', () => {
    const s = lockedState();
    const row = { ...contact(), workspace_id: 'ws-1', notes: 'secret', tags: ['vip'], visitor_code: 'V8KQ2M', avatar_url: 'x' };
    const locked = contactRowForPanel(s, row);
    expect(locked).toMatchObject({
      id: row.id, workspace_id: 'ws-1', created_at: row.created_at, locked: true,
      name: null, email: null, notes: null, tags: [], metadata: {}, avatar_url: null, visitor_code: 'V8••••',
    });
    const open = contactRowForPanel(s, { ...row, created_at: '2026-01-01T00:00:00Z' });
    expect(open).toMatchObject({ locked: false, name: 'Cleo', notes: 'secret' });
  });

  it('names the limit and the retention in the 403 bodies', () => {
    expect(contactLockedBody(lockedState())).toEqual({ error: 'contact_locked', upgrade_required: true, limit: 2 });
    expect(conversationLockedBody(lockedState())).toEqual({ error: 'conversation_locked', upgrade_required: true, retention_days: 30 });
  });
});

describe('widget availability payload: quota_full', () => {
  const snap: AvailabilitySnapshot = {
    state: 'online', reason: 'within_hours', next_open_at: null, timezone: 'UTC',
    offline_mode: 'capture_message', labels: { online: 'On', offline: 'Off' }, offline_message: '',
  };

  it('is left out unless it was resolved (switch off: the payload is unchanged)', () => {
    expect(snapshotToWirePayload(snap)).not.toHaveProperty('quota_full');
    expect(snapshotToWirePayload(snap, { quota_full: null })).not.toHaveProperty('quota_full');
    expect(snapshotToWirePayload(snap, { quota_full: true }).quota_full).toBe(true);
    expect(snapshotToWirePayload(snap, { quota_full: false }).quota_full).toBe(false);
  });
});
