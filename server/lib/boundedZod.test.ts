/**
 * server/lib/boundedZod.ts: an oversized collection fails on its size alone
 * (one issue, no element parsed), which zod 3's own `.max()` does not do
 * (GHSA-mrhx-c7xc-m3w5).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedArray, boundedRecord } from './boundedZod.js';

describe('boundedArray', () => {
  const ids = boundedArray(z.string().uuid(), 3, 1);

  it('parses an array within its bounds like z.array', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(ids.parse([id, id])).toEqual([id, id]);
    const bad = ids.safeParse([id, 'nope']);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.map((i) => i.path)).toEqual([[1]]);
  });

  it('rejects an oversized array with one issue, without parsing its elements', () => {
    // zod 3 itself: one too_big issue plus one issue per bad element.
    const huge = Array.from({ length: 10_000 }, () => 'nope');
    expect(z.array(z.string().uuid()).max(3).safeParse(huge).error?.issues.length).toBe(10_001);
    const res = ids.safeParse(huge);
    expect(res.success).toBe(false);
    expect(res.error?.issues).toHaveLength(1);
  });

  it('keeps min, non-arrays and optional/default working', () => {
    expect(ids.safeParse([]).success).toBe(false);
    expect(ids.safeParse('x').success).toBe(false);
    expect(ids.safeParse({ length: 1 }).success).toBe(false);
    expect(z.object({ a: boundedArray(z.string(), 2).optional() }).parse({})).toEqual({});
    expect(z.object({ a: boundedArray(z.string(), 2).default([]) }).parse({})).toEqual({ a: [] });
  });
});

describe('boundedRecord', () => {
  const flags = boundedRecord(z.boolean(), 2);

  it('parses a record within its bound like z.record', () => {
    expect(flags.parse({ a: true, b: false })).toEqual({ a: true, b: false });
    expect(flags.safeParse({ a: 'yes' }).success).toBe(false);
  });

  it('rejects too many keys with one issue', () => {
    const huge = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, 'nope']));
    const res = flags.safeParse(huge);
    expect(res.success).toBe(false);
    expect(res.error?.issues).toHaveLength(1);
    expect(flags.safeParse([true]).success).toBe(false);
    expect(flags.safeParse(null).success).toBe(false);
  });
});
