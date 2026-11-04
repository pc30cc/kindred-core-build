// @vitest-environment node
/**
 * The two small pieces behind the audit fixes of 2026-11-04 that need no
 * database: readRows (every row past DATABASE_MAX_ROWS, page by page) and the
 * thread's `before` cursor. The routes themselves run on a real database in
 * src/test/integration/conversationsAudit.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ROWS_PAGE, readRows } from '../../../server/lib/pagedRows';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({}) }));

/** A table of `n` rows read through a cap of `cap` rows per request. */
const table = (n: number, cap: number) => {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` }));
  const calls: Array<[number, number]> = [];
  const read = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null };
  };
  return { rows, calls, read };
};

describe('readRows', () => {
  it('reads every row through a cap smaller than a page, and stops on an empty page', async () => {
    const t = table(2345, 1000);
    const { data, error } = await readRows(t.read);
    expect(error).toBeNull();
    expect(data).toEqual(t.rows);
    expect(t.calls[0]).toEqual([0, ROWS_PAGE - 1]);
    const t2 = table(12, 5);
    expect((await readRows(t2.read)).data).toHaveLength(12);
  });

  it('stops at `max`, asking for no more than it still needs', async () => {
    const t = table(5000, 1000);
    const { data } = await readRows(t.read, 2000);
    expect(data).toHaveLength(2000);
    expect(t.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it('drops a row read twice (a row inserted ahead of the offset between pages)', async () => {
    let n = 0;
    const read = async (from: number) => {
      n++;
      if (n === 1) return { data: [{ id: 'a' }, { id: 'b' }], error: null };
      if (n === 2) return { data: [{ id: 'b' }, { id: 'c' }], error: null };
      return { data: [], error: null };
    };
    expect((await readRows(read)).data.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns the error of a failed page, with what was read before it', async () => {
    let n = 0;
    const read = async () => (++n === 1
      ? { data: [{ id: 'a' }], error: null }
      : { data: null, error: { message: 'boom' } });
    const { data, error } = await readRows(read);
    expect(error).toEqual({ message: 'boom' });
    expect(data).toEqual([{ id: 'a' }]);
  });
});

describe('parseThreadBefore', () => {
  it('takes the oldest row a client holds, as the thread gave it; refuses anything else', async () => {
    const { parseThreadBefore } = await import('../../../server/routes/conversations');
    const id = '0b6a7f4e-3c1d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(parseThreadBefore(undefined, undefined)).toBeNull();
    expect(parseThreadBefore('2026-11-04T17:21:56.123456+00:00', id)).toEqual({ createdAt: '2026-11-04T17:21:56.123456+00:00', id });
    expect(parseThreadBefore('2026-11-04T17:21:56Z', id)).toEqual({ createdAt: '2026-11-04T17:21:56Z', id });
    for (const [before, beforeId] of [
      ['2026-11-04T17:21:56Z', undefined],
      [undefined, id],
      ['yesterday', id],
      ['2026-11-04T17:21:56Z', 'not-a-uuid'],
      ['2026-11-04T17:21:56Z,id.gt.0', id],
      ['2026-13-45T99:99:99Z', id],
    ]) {
      expect(parseThreadBefore(before, beforeId)).toBe('invalid');
    }
  });
});
