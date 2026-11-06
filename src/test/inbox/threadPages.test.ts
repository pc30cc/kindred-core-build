import { describe, expect, it } from 'vitest';
import {
  compareThreadRows,
  mergeNewestPage,
  mergeOlderPage,
  stampMicros,
  type ThreadRow,
} from '@/lib/threadPages';

/** Row `n`: created n seconds after a fixed start, with an id that sorts by n. */
const row = (n: number, extra: Record<string, unknown> = {}): ThreadRow & Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  created_at: new Date(Date.UTC(2026, 10, 6, 10, 0, 0) + n * 1000).toISOString().replace('Z', '000+00:00'),
  ...extra,
});
const ids = (rows: ThreadRow[]) => rows.map((r) => Number(r.id.slice(-12)));
const cursorOf = (r: ThreadRow) => ({ before: r.created_at, before_id: r.id });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

describe('stampMicros and thread order', () => {
  it('keeps microseconds and reads the server\'s and the browser\'s formats alike', () => {
    expect(stampMicros('2026-11-06T10:00:00.000001+00:00') - stampMicros('2026-11-06T10:00:00+00:00')).toBe(1);
    expect(stampMicros('2026-11-06T10:00:00.5Z')).toBe(stampMicros('2026-11-06T10:00:00.500000+00:00'));
    expect(stampMicros('2026-11-06T13:30:00+03:30')).toBe(stampMicros('2026-11-06T10:00:00Z'));
    expect(stampMicros('2026-11-06 10:00:00.25+00')).toBe(stampMicros('2026-11-06T10:00:00.250Z'));
    expect(Number.isNaN(stampMicros('yesterday'))).toBe(true);
  });

  it('orders by time to the microsecond, then by id (rows of one instant)', () => {
    const a = { id: 'b', created_at: '2026-11-06T10:00:00.000002+00:00' };
    const b = { id: 'a', created_at: '2026-11-06T10:00:00.000001+00:00' };
    const c = { id: 'c', created_at: '2026-11-06T10:00:00.000001+00:00' };
    expect([a, b, c].sort(compareThreadRows).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    // A browser's millisecond stamp and the server's microsecond one compare by value, not by text.
    const ms = { id: 'x', created_at: '2026-11-06T10:00:00.001Z' };
    const us = { id: 'y', created_at: '2026-11-06T10:00:00.000999+00:00' };
    expect(compareThreadRows(us, ms)).toBe(-1);
  });
});

describe('mergeNewestPage', () => {
  it('the first read is the page', () => {
    const page = { rows: range(51, 100), older: cursorOf(row(51)) };
    expect(mergeNewestPage(null, page)).toEqual(page);
  });

  it('a page at the thread\'s start is the whole thread (a deleted row goes)', () => {
    const held = { rows: range(1, 10), older: null };
    const page = { rows: range(1, 10).filter((r) => ids([r])[0] !== 4), older: null };
    expect(ids(mergeNewestPage(held, page).rows)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps the older pages loaded before the newest page, and takes the page\'s copy of its own range', () => {
    // Held: 1..100 (two pages loaded), its older null. New: 101..103 arrived, 60 edited, 70 deleted.
    const held = { rows: range(1, 100), older: null };
    const pageRows = [...range(54, 103)].filter((r) => ids([r])[0] !== 70).map((r) => (ids([r])[0] === 60 ? { ...r, body: 'edited' } : r));
    const merged = mergeNewestPage(held, { rows: pageRows, older: cursorOf(row(54)) });
    expect(ids(merged.rows)).toEqual([...Array.from({ length: 103 }, (_, i) => i + 1)].filter((n) => n !== 70));
    expect(merged.rows.find((r) => ids([r])[0] === 60)).toMatchObject({ body: 'edited' });
    expect(merged.older).toBeNull();
  });

  it('more new messages than one page: the run starts again from the page, never with a hole', () => {
    const held = { rows: range(1, 50), older: null };
    const page = { rows: range(60, 99), older: cursorOf(row(60)) };
    expect(mergeNewestPage(held, page)).toEqual(page);
  });

  it('a held run entirely inside the page: the page and its cursor', () => {
    const held = { rows: range(70, 90), older: cursorOf(row(70)) };
    const page = { rows: range(51, 100), older: cursorOf(row(51)) };
    expect(mergeNewestPage(held, page)).toEqual(page);
  });

  it('no duplicates when a row is in both', () => {
    const held = { rows: range(1, 60), older: null };
    const page = { rows: range(51, 61), older: cursorOf(row(51)) };
    const merged = mergeNewestPage(held, page);
    expect(ids(merged.rows)).toEqual(Array.from({ length: 61 }, (_, i) => i + 1));
  });
});

describe('mergeOlderPage', () => {
  it('goes before the run and takes the page\'s cursor; empty pages keep paging while older is set', () => {
    const held = { rows: range(51, 100), older: cursorOf(row(51)) };
    const merged = mergeOlderPage(held, { rows: range(1, 50), older: null });
    expect(ids(merged.rows)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(merged.older).toBeNull();
    const empty = mergeOlderPage(held, { rows: [], older: cursorOf(row(30)) });
    expect(ids(empty.rows)).toEqual(ids(held.rows));
    expect(empty.older).toEqual(cursorOf(row(30)));
  });

  it('a newer copy of a row the page also carries wins, the run stays in order', () => {
    const held = { rows: [row(5, { body: 'old' }), ...range(6, 8)], older: cursorOf(row(5)) };
    const merged = mergeOlderPage(held, { rows: [...range(1, 4), row(5, { body: 'new' })], older: null });
    expect(ids(merged.rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(merged.rows[4]).toMatchObject({ body: 'new' });
  });
});
