/**
 * The analytics reports' bounded reads (webAnalytics/reportService.ts
 * readCapped): the data layer caps a single read at DATABASE_MAX_ROWS, so a
 * report reads its bound page by page and says `truncated` only when there
 * were really more rows than the bound (audit 2026-11-04).
 */
import { describe, expect, it } from 'vitest';
import { readCapped } from '../../../server/services/webAnalytics/reportService';

/** A table of `n` rows behind a data layer that returns at most `maxRows` per read. */
function table(n: number, maxRows: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` }));
  return async (from: number, to: number) => ({
    data: rows.slice(from, Math.min(to + 1, from + maxRows)),
    error: null,
  });
}

describe('readCapped', () => {
  it('reads past the data layer\'s cap up to the bound, and flags the bound when there is more', async () => {
    const out = await readCapped(table(25, 3), 10);
    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(true);
    expect(out.error).toBeNull();
  });

  it('exactly the bound is not truncated', async () => {
    const out = await readCapped(table(10, 3), 10);
    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(false);
  });

  it('fewer rows than the bound: all of them, not truncated', async () => {
    const out = await readCapped(table(7, 3), 10);
    expect(out.rows.map((r) => r.id)).toEqual(['r00000', 'r00001', 'r00002', 'r00003', 'r00004', 'r00005', 'r00006']);
    expect(out.truncated).toBe(false);
  });
});
