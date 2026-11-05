/**
 * readRowsByKey (server/lib/pagedRows.ts): keyset pages for the reads that
 * drive a delete, a sweep, a hand-back or money. Behind a data layer that
 * returns at most a few rows per read, every row comes back; a row leaving
 * the filter between pages shifts nothing; a failed page comes back as an
 * error with the rows read so far, never as a complete set.
 */
import { describe, expect, it } from 'vitest';
import { readRowsByKey } from '../../../server/lib/pagedRows';

type Row = { id: string };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `k${String(i).padStart(3, '0')}`);

/** A table behind a data layer capped at `cap` rows per read. */
function table(rows: string[], cap: number) {
  return async (after: string | null, size: number) => ({
    data: rows.filter((id) => after === null || id > after).sort().slice(0, Math.min(size, cap)).map((id) => ({ id })),
    error: null,
  });
}

describe('readRowsByKey', () => {
  it('reads every row past the data layer\'s cap', async () => {
    const out = await readRowsByKey<Row>('id', table(ids(10), 3));
    expect(out.error).toBeNull();
    expect(out.data.map((r) => r.id)).toEqual(ids(10));
  });

  it('a row read before leaves the filter between pages: nothing after it is skipped', async () => {
    const rows = ids(9);
    const read = table(rows, 3);
    let pages = 0;
    const out = await readRowsByKey<Row>('id', async (after, size) => {
      if (pages++ === 1) rows.splice(0, 1); // the first row leaves after page 1
      return read(after, size);
    });
    expect(out.data.map((r) => r.id)).toEqual(ids(9));
  });

  it('a failed page: the error, with what was read, never a whole set', async () => {
    const read = table(ids(9), 3);
    let pages = 0;
    const out = await readRowsByKey<Row>('id', async (after, size) => (
      pages++ === 2 ? { data: null, error: { message: 'connection reset' } } : read(after, size)
    ));
    expect(out.error).toEqual({ message: 'connection reset' });
    expect(out.data).toHaveLength(6);
  });

  it('rows without their key, or out of order, are an error, not a loop', async () => {
    const noKey = await readRowsByKey<{ id?: string }>('id', async () => ({ data: [{}], error: null }));
    expect(noKey.error?.code).toBe('pagedrows_key_missing');
    const unordered = await readRowsByKey<Row>('id', async () => ({ data: [{ id: 'b' }], error: null }));
    expect(unordered.error?.code).toBe('pagedrows_key_order');
  });
});
