/**
 * Chat conversation routing — pure ranking/rotation algorithm unit tests.
 *
 * Chat conversations previously had no automatic assignment at all; the
 * spec explicitly forbids random assignment. These are the two decision
 * functions that pick who gets a conversation in 'auto' and 'round_robin'
 * modes (server/services/chatRouting.ts) — pure, no database, so the
 * "never random, always deterministic" requirement is directly testable.
 */
import { describe, it, expect } from 'vitest';
import { rankAutoCandidates, rotateFromCursor } from '../../../server/services/chatRouting';

describe('rankAutoCandidates', () => {
  it('picks the least-loaded candidate first', () => {
    const load = new Map([
      ['user-b', 3],
      ['user-a', 1],
      ['user-c', 2],
    ]);
    expect(rankAutoCandidates(['user-b', 'user-a', 'user-c'], load)).toEqual([
      'user-a', 'user-c', 'user-b',
    ]);
  });

  it('breaks load ties alphabetically — never randomly', () => {
    const load = new Map([
      ['user-z', 0],
      ['user-a', 0],
      ['user-m', 0],
    ]);
    const ranked = rankAutoCandidates(['user-z', 'user-a', 'user-m'], load);
    expect(ranked).toEqual(['user-a', 'user-m', 'user-z']);
  });

  it('treats a candidate missing from the load map as zero load', () => {
    const load = new Map([['user-a', 5]]);
    expect(rankAutoCandidates(['user-a', 'user-b'], load)).toEqual(['user-b', 'user-a']);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const load = new Map([['a', 1], ['b', 1], ['c', 0]]);
    const candidates = ['a', 'b', 'c'];
    const first = rankAutoCandidates(candidates, load);
    for (let i = 0; i < 20; i++) {
      expect(rankAutoCandidates(candidates, load)).toEqual(first);
    }
  });

  it('does not mutate the input array', () => {
    const candidates = ['b', 'a'];
    const load = new Map([['a', 0], ['b', 0]]);
    rankAutoCandidates(candidates, load);
    expect(candidates).toEqual(['b', 'a']);
  });
});

describe('rotateFromCursor', () => {
  it('sorts alphabetically with no cursor (first-ever assignment)', () => {
    expect(rotateFromCursor(['c', 'a', 'b'], null)).toEqual(['a', 'b', 'c']);
  });

  it('starts right after the stored cursor for fairness', () => {
    expect(rotateFromCursor(['a', 'b', 'c', 'd'], 'b')).toEqual(['c', 'd', 'a', 'b']);
  });

  it('wraps around when the cursor was the last candidate', () => {
    expect(rotateFromCursor(['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('falls back to plain sort when the cursor is no longer an eligible candidate', () => {
    // e.g. the last-assigned operator went offline or left the department.
    expect(rotateFromCursor(['a', 'b', 'c'], 'zzz-not-a-candidate')).toEqual(['a', 'b', 'c']);
  });

  it('never picks the same operator twice in a row across a full cycle', () => {
    let cursor: string | null = null;
    const seen: string[] = [];
    const pool = ['a', 'b', 'c'];
    for (let i = 0; i < pool.length; i++) {
      const ordered = rotateFromCursor(pool, cursor);
      const picked = ordered[0];
      expect(picked).not.toBe(cursor);
      seen.push(picked);
      cursor = picked;
    }
    // A full cycle visits every candidate exactly once.
    expect(new Set(seen)).toEqual(new Set(pool));
  });
});
