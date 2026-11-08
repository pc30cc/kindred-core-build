import { describe, expect, it } from 'vitest';
import { SYNC_OVERLAP_MS, deltaLowerBound, inThreadOrder, nextSyncCursor, parseSyncCursor } from './messageSync.js';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

describe('parseSyncCursor', () => {
  it('accepts an ISO timestamp the server handed out', () => {
    expect(parseSyncCursor('2026-09-25T11:59:00.123Z', NOW)?.toISOString()).toBe('2026-09-25T11:59:00.123Z');
    expect(parseSyncCursor('2026-09-25T11:59:00.123456+00:00', NOW)).not.toBeNull();
  });

  it('means "read everything" for anything else', () => {
    for (const raw of [undefined, null, '', '   ', 'yesterday', '1727265540', '2026-09-25', ['2026-09-25T11:59:00Z'], 'x'.repeat(80)]) {
      expect(parseSyncCursor(raw, NOW)).toBeNull();
    }
  });

  it('ignores a cursor from far in the future (a clock problem)', () => {
    expect(parseSyncCursor('2026-09-25T13:00:00Z', NOW)).toBeNull();
    expect(parseSyncCursor('2026-09-25T12:01:00Z', NOW)).not.toBeNull();
  });
});

describe('deltaLowerBound', () => {
  it('reaches back by the overlap', () => {
    const cursor = new Date(NOW);
    expect(Date.parse(deltaLowerBound(cursor))).toBe(NOW - SYNC_OVERLAP_MS);
  });
});

describe('nextSyncCursor', () => {
  it('is the newest updated_at read', () => {
    const rows = [{ updated_at: '2026-09-25T11:00:00Z' }, { updated_at: '2026-09-25T11:30:00.5Z' }, { updated_at: '2026-09-25T11:10:00Z' }];
    expect(nextSyncCursor(rows, null)).toBe('2026-09-25T11:30:00.500Z');
  });

  it('never moves backwards when an overlap read returns only older rows', () => {
    const previous = new Date('2026-09-25T11:45:00Z');
    expect(nextSyncCursor([{ updated_at: '2026-09-25T11:44:55Z' }], previous)).toBe(previous.toISOString());
  });

  it('keeps the client cursor on an empty delta', () => {
    const previous = new Date('2026-09-25T11:45:00Z');
    expect(nextSyncCursor([], previous)).toBe(previous.toISOString());
  });

  it('is null when rows carry no updated_at (database not migrated)', () => {
    expect(nextSyncCursor([{}, { updated_at: null }], null)).toBeNull();
  });
});

describe('inThreadOrder', () => {
  it('orders by created_at, then id, without touching the input', () => {
    const rows = [
      { id: 'b', created_at: '2026-09-25T10:00:00Z' },
      { id: 'c', created_at: '2026-09-25T09:00:00Z' },
      { id: 'a', created_at: '2026-09-25T10:00:00Z' },
    ];
    expect(inThreadOrder(rows).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows[0].id).toBe('b');
  });
});

describe('delta order (2026-11-08)', () => {
  it('reads database timestamps to the microsecond, whatever their fraction', async () => {
    const { timestampMicros } = await import('./messageSync.js');
    expect(timestampMicros('2026-11-08T10:00:00.1+00:00')).toBe(Date.UTC(2026, 10, 8, 10) * 1000 + 100_000);
    expect(timestampMicros('2026-11-08T10:00:00.123456+00:00')).toBe(Date.UTC(2026, 10, 8, 10) * 1000 + 123_456);
    expect(timestampMicros('2026-11-08 13:30:00.000001+03:30')).toBe(Date.UTC(2026, 10, 8, 10) * 1000 + 1);
    expect(timestampMicros('2026-11-08T10:00:00Z')).toBe(Date.UTC(2026, 10, 8, 10) * 1000);
    expect(timestampMicros('nope')).toBeNaN();
  });

  it('orders by (updated_at, id), the fraction compared as a number, not as text', async () => {
    const { isChangedAfter } = await import('./messageSync.js');
    const at = '2026-11-08T10:00:00.1+00:00';
    expect(isChangedAfter({ updated_at: '2026-11-08T10:00:00.123+00:00', id: 'a' }, at, 'z')).toBe(true);
    expect(isChangedAfter({ updated_at: '2026-11-08T10:00:00.09+00:00', id: 'z' }, at, 'a')).toBe(false);
    expect(isChangedAfter({ updated_at: at, id: 'b' }, at, 'a')).toBe(true);
    expect(isChangedAfter({ updated_at: at, id: 'a' }, at, 'a')).toBe(false);
  });
});
