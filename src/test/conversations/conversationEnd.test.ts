/**
 * How a conversation ended, for the reports (shared/inactivityClose.ts
 * conversationEndOf), and the inactivity window that applies to a workspace
 * (effectiveInactivityCloseHours). Every status × closed_reason × closed_from.
 */
import { describe, expect, it } from 'vitest';
import {
  clearedClosedMarkers,
  CLOSED_KEYS,
  conversationEndOf,
  effectiveInactivityCloseHours,
  operatorCloseMarkers,
} from '../../../shared/inactivityClose';

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const REASONS = [undefined, null, 'operator', 'inactivity', 'something_else'] as const;
const FROMS = [undefined, null, 'open', 'pending', 'resolved', 'closed'] as const;

describe('conversationEndOf', () => {
  it('every status × closed_reason × closed_from', () => {
    for (const status of STATUSES) {
      for (const reason of REASONS) {
        for (const from of FROMS) {
          const meta = { ...(reason !== undefined ? { closed_reason: reason } : {}), ...(from !== undefined ? { closed_from: from } : {}) };
          const end = conversationEndOf(status, meta);
          const label = `${status} ${String(reason)} ${String(from)}`;
          if (status === 'open' || status === 'pending') expect(end, label).toBeNull();
          else if (status === 'resolved') expect(end, label).toBe('resolved');
          else if (reason !== 'inactivity') expect(end, label).toBe('closed_operator');
          else expect(end, label).toBe(from === 'resolved' ? 'closed_inactive_after_resolve' : 'closed_inactive');
        }
      }
    }
  });

  it('the markers are read only while closed; a legacy close (none) is an operator\'s; any metadata shape', () => {
    // A reopened conversation whose markers a stale writer left: not closed, not ended.
    expect(conversationEndOf('open', { closed_reason: 'inactivity', closed_from: 'open' })).toBeNull();
    expect(conversationEndOf('resolved', { closed_reason: 'inactivity' })).toBe('resolved');
    for (const meta of [null, undefined, 'x', 42, [], {}]) expect(conversationEndOf('closed', meta), String(meta)).toBe('closed_operator');
    expect(conversationEndOf('archived', { closed_reason: 'inactivity' })).toBeNull();
  });
});

describe('effectiveInactivityCloseHours', () => {
  it('the workspace\'s own value, else the platform\'s, else 24; clamped to 1–48, whole hours', () => {
    expect(effectiveInactivityCloseHours(12, 24)).toBe(12);
    expect(effectiveInactivityCloseHours(null, 6)).toBe(6);
    expect(effectiveInactivityCloseHours(undefined, 30)).toBe(30);
    expect(effectiveInactivityCloseHours(null, undefined)).toBe(24);
    expect(effectiveInactivityCloseHours(0, 24)).toBe(1);
    expect(effectiveInactivityCloseHours(-5, 24)).toBe(1);
    expect(effectiveInactivityCloseHours(49, 24)).toBe(48);
    expect(effectiveInactivityCloseHours(500, 24)).toBe(48);
    expect(effectiveInactivityCloseHours(null, 0)).toBe(1);
    expect(effectiveInactivityCloseHours(null, 99)).toBe(48);
    expect(effectiveInactivityCloseHours(12.9, 24)).toBe(12);
    expect(effectiveInactivityCloseHours(Number.NaN, 7)).toBe(7);
    expect(effectiveInactivityCloseHours(null, Number.NaN)).toBe(24);
    expect(effectiveInactivityCloseHours('8' as unknown as number, 24)).toBe(8);
  });
});

describe('the markers a close writes and a reopen clears', () => {
  it('an operator\'s close: reason, by, at, from; the others null; a reopen nulls all ten', () => {
    expect(operatorCloseMarkers('2026-10-25T08:00:00.000Z', 'resolved')).toEqual({
      closed_reason: 'operator', closed_by: 'agent', closed_at: '2026-10-25T08:00:00.000Z', closed_from: 'resolved',
      closed_source: null, closed_idle_hours: null, closed_last_exchange_at: null, closed_outcome: null,
      closed_line_id: null, closed_prev_stamps: null,
    });
    expect(Object.keys(clearedClosedMarkers())).toEqual([...CLOSED_KEYS]);
    expect(Object.values(clearedClosedMarkers()).every((v) => v === null)).toBe(true);
    expect(CLOSED_KEYS).toHaveLength(10);
  });
});
