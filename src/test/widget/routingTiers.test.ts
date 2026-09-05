/**
 * ROUTING TIERS — "active is ALWAYS preferred over away".
 *
 * The previous implementation merged active+away into one candidate list and
 * then sorted it by load (auto) or alphabetically-rotated it (round robin),
 * which silently destroyed the priority. These tests pin the two real tiers.
 */
import { describe, it, expect } from 'vitest';
import {
  splitPresenceTiers,
  orderTierCandidates,
  rankAutoCandidates,
} from '../../../server/services/chatRouting';

const states = new Map<string, string | undefined>([
  ['active-a', 'active'],
  ['away-b', 'away'],
  ['disconnected-c', 'disconnected'],
  ['offline-d', 'offline'],
]);

describe('splitPresenceTiers', () => {
  it('keeps active and away in separate tiers and drops the rest', () => {
    const t = splitPresenceTiers(
      ['away-b', 'active-a', 'disconnected-c', 'offline-d', 'unknown-e'],
      states,
    );
    expect(t.active).toEqual(['active-a']);
    expect(t.away).toEqual(['away-b']);
  });
});

describe('two-tier ordering', () => {
  it('auto: a heavily loaded ACTIVE operator still beats an idle AWAY one', () => {
    const t = splitPresenceTiers(['active-a', 'away-b'], states);
    const load = new Map([['active-a', 8], ['away-b', 0]]);
    // Old behaviour (merged then ranked) would have picked the away operator.
    expect(rankAutoCandidates(['active-a', 'away-b'], load)[0]).toBe('away-b');
    // New behaviour: tier 1 is exhausted first.
    expect(orderTierCandidates(t.active, 'auto', null, load)[0]).toBe('active-a');
  });

  it('round robin: the cursor rotates INSIDE the active tier only', () => {
    const st = new Map<string, string | undefined>([
      ['a', 'active'], ['b', 'active'], ['z', 'away'],
    ]);
    const t = splitPresenceTiers(['a', 'b', 'z'], st);
    // Alphabetical rotation across the merged list would surface 'z'.
    expect(orderTierCandidates(t.active, 'round_robin', 'a', new Map())).toEqual(['b', 'a']);
    expect(orderTierCandidates(t.active, 'round_robin', 'b', new Map())).toEqual(['a', 'b']);
    // The away tier is only ordered when tier 1 produced no claim.
    expect(orderTierCandidates(t.away, 'round_robin', 'b', new Map())).toEqual(['z']);
  });

  it('away is used when there is no active operator at all', () => {
    const t = splitPresenceTiers(['away-b', 'offline-d'], states);
    expect(t.active).toEqual([]);
    expect(orderTierCandidates(t.away, 'auto', null, new Map())).toEqual(['away-b']);
  });
});
