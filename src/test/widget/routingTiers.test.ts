/**
 * ROUTING TIERS — "active is ALWAYS preferred over away", and away only while
 * idle under 30 minutes (DECISIONS §4 e; R-11).
 *
 * The previous implementation merged active+away into one candidate list and
 * then sorted it by load (auto) or alphabetically-rotated it (round robin),
 * which silently destroyed the priority; and an operator whose tab was open
 * but who had left their desk hours ago still got chats. The pick inside a
 * tier is chat_route_claim's (src/test/integration/chatRouting278.pg.test.ts);
 * these tests pin the tiers the engine hands it.
 */
import { describe, it, expect } from 'vitest';
import {
  AWAY_ROUTING_MAX_IDLE_MS,
  routingTierOf,
  splitPresenceTiers,
} from '../../../server/services/chatRouting';
import type { RoutingPresence } from '../../../server/services/widget/operatorPresence';

const NOW = Date.parse('2026-10-21T10:00:00Z');
const at = (msAgo: number) => NOW - msAgo;

const presence = new Map<string, RoutingPresence>([
  ['active-a', { state: 'active', lastActivityAt: at(60_000) }],
  ['away-b', { state: 'away', lastActivityAt: at(10 * 60_000) }],
  ['away-long-c', { state: 'away', lastActivityAt: at(AWAY_ROUTING_MAX_IDLE_MS) }],
  ['away-unknown-d', { state: 'away', lastActivityAt: null }],
  ['disconnected-e', { state: 'disconnected', lastActivityAt: at(30_000) }],
  ['offline-f', { state: 'offline', lastActivityAt: at(30_000) }],
]);

describe('routingTierOf', () => {
  it('active is tier 1; away is tier 2 only while idle under 30 minutes', () => {
    expect(routingTierOf(presence.get('active-a'), NOW)).toBe('active');
    expect(routingTierOf(presence.get('away-b'), NOW)).toBe('away');
    expect(routingTierOf(presence.get('away-long-c'), NOW)).toBeNull();
    expect(routingTierOf({ state: 'away', lastActivityAt: at(AWAY_ROUTING_MAX_IDLE_MS - 1) }, NOW)).toBe('away');
  });

  it('an away operator whose last interaction is unknown (e.g. since a restart) stays tier 2', () => {
    expect(routingTierOf(presence.get('away-unknown-d'), NOW)).toBe('away');
  });

  it('disconnected, offline and unknown operators get nothing', () => {
    expect(routingTierOf(presence.get('disconnected-e'), NOW)).toBeNull();
    expect(routingTierOf(presence.get('offline-f'), NOW)).toBeNull();
    expect(routingTierOf(undefined, NOW)).toBeNull();
  });
});

describe('splitPresenceTiers', () => {
  it('keeps active and away in separate tiers, in the given order, and drops the rest', () => {
    const t = splitPresenceTiers(
      ['away-unknown-d', 'away-b', 'active-a', 'away-long-c', 'disconnected-e', 'offline-f', 'nobody-g'],
      presence,
      NOW,
    );
    expect(t.active).toEqual(['active-a']);
    expect(t.away).toEqual(['away-unknown-d', 'away-b']);
  });

  it('an empty pool is two empty tiers', () => {
    expect(splitPresenceTiers([], presence, NOW)).toEqual({ active: [], away: [] });
  });
});
