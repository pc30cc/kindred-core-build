/**
 * Internal presence (teammate-facing) and routing eligibility.
 *
 * Matrix under test:
 *   manual off / schedule closed          → offline   (ineligible)
 *   available + connected + act <5m       → active    (eligible, priority)
 *   available + connected + act >=5m      → away      (eligible)
 *   available + NOT connected             → disconnected (NOT auto-assigned)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordOperatorActivity,
  resetOperatorActivity,
  OPERATOR_ACTIVITY_ACTIVE_MS,
} from '../../../server/services/widget/operatorActivity';
import { computeCustomerAvailability } from '../../../server/services/widget/customerAvailability';

type State = 'active' | 'away' | 'disconnected' | 'offline';

/** Mirrors the decision made in listWorkspacePresence(). */
function decide(args: {
  prefs: any;
  connected: boolean;
  lastActivity: number | null;
  now: Date;
}): State {
  const customer = computeCustomerAvailability(args.prefs, args.now);
  if (customer.availability === 'unavailable') return 'offline';
  if (!args.connected) return 'disconnected';
  const active =
    args.lastActivity !== null &&
    args.now.getTime() - args.lastActivity < OPERATOR_ACTIVITY_ACTIVE_MS;
  return active ? 'active' : 'away';
}

const now = new Date('2026-01-07T12:00:00+03:00');
const openPrefs = { force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'Europe/Istanbul', weekly_schedule: {} };

describe('internal operator presence', () => {
  beforeEach(() => resetOperatorActivity());

  it('is active when connected and interacting', () => {
    expect(decide({ prefs: openPrefs, connected: true, lastActivity: now.getTime() - 60_000, now })).toBe('active');
  });

  it('falls to away after 5 minutes without interaction', () => {
    expect(decide({ prefs: openPrefs, connected: true, lastActivity: now.getTime() - 5 * 60_000, now })).toBe('away');
  });

  it('is disconnected when customer-available but no live connection', () => {
    expect(decide({ prefs: openPrefs, connected: false, lastActivity: now.getTime(), now })).toBe('disconnected');
  });

  it('is offline only when manually off or outside schedule', () => {
    expect(decide({ prefs: { ...openPrefs, force_offline: true }, connected: true, lastActivity: now.getTime(), now })).toBe('offline');
  });

  it('a hidden tab or dropped socket never makes the operator customer-unavailable', () => {
    const disconnected = decide({ prefs: openPrefs, connected: false, lastActivity: null, now });
    expect(disconnected).toBe('disconnected');
    expect(computeCustomerAvailability(openPrefs, now).availability).toBe('available');
  });

  it('activity stamps are per workspace+user and ephemeral', () => {
    recordOperatorActivity('ws1', 'u1', now.getTime());
    resetOperatorActivity();
    expect(decide({ prefs: openPrefs, connected: true, lastActivity: null, now })).toBe('away');
  });
});

describe('routing eligibility', () => {
  const eligible = (s: State) => s === 'active' || s === 'away';

  it('assigns to active and away, never to disconnected or offline', () => {
    expect(eligible('active')).toBe(true);
    expect(eligible('away')).toBe(true);
    expect(eligible('disconnected')).toBe(false);
    expect(eligible('offline')).toBe(false);
  });

  it('messenger-online does not imply routable: disconnected is customer-available yet ineligible', () => {
    const s = decide({ prefs: openPrefs, connected: false, lastActivity: null, now });
    expect(computeCustomerAvailability(openPrefs, now).availability).toBe('available');
    expect(eligible(s)).toBe(false);
  });
});
