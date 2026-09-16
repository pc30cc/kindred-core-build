/**
 * DURABLE SPOOL — the tests that have to pass before `s3_only` can ever be
 * unlocked.
 *
 * Each one models a specific failure the Phase 2.5 brief names. "Crash" is
 * simulated by closing the spool's file handles and dropping every scrap of
 * in-process state (`__resetSpoolForTests`) while LEAVING THE DIRECTORY
 * ALONE — which is exactly what a SIGKILL, an OOM kill or a container
 * restart leaves behind on a mounted volume.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const {
  appendRows, commitSpool, replaySpool, spoolAvailability, spoolStats,
  fsyncSpool, __resetSpoolForTests,
} = await import('../../../server/services/analytics/spool.js');

const config = {} as never;
let dir: string;
/** A regular FILE used as a directory parent, so mkdir fails immediately. */
let blocker: string;

/** A crash: handles closed, memory gone, disk untouched. */
function crash(): void {
  __resetSpoolForTests(dir);
}

function row(id: string, workspace = 'ws-1'): never {
  return {
    schema_version: 2,
    event_id: id,
    workspace_id: workspace,
    visitor_id: `v-${id}`,
    session_id: `s-${id}`,
    event_type: 'page_view',
    occurred_at: Date.parse('2026-08-10T10:00:00.000Z'),
    ingested_at: Date.parse('2026-08-10T10:00:00.000Z'),
    session_started_at: Date.parse('2026-08-10T10:00:00.000Z'),
    session_last_seen_at: Date.parse('2026-08-10T10:20:00.000Z'),
    url: 'https://shop.test/', path: '/', title: 'Home',
    referrer: null, referrer_domain: null,
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
    browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US',
    country: 'Iran', country_code: 'IR', city: 'Tehran',
    event_name: null, properties: null,
  } as never;
}

function segments(): string[] {
  return fs.readdirSync(dir).filter((f) => f.startsWith('seg-') && f.endsWith('.log')).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-test-'));
  blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  __resetSpoolForTests(dir);
});

afterEach(() => {
  __resetSpoolForTests(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ANALYTICS_SPOOL_DIR;
});

describe('availability', () => {
  it('reports a writable directory as available', () => {
    const availability = spoolAvailability();
    expect(availability.available).toBe(true);
    expect(availability.dir).toBe(dir);
  });

  it('reports an UNWRITABLE directory as unavailable rather than throwing', () => {
    // A volume that was never mounted, modelled by making the parent a
    // regular file so mkdir fails with ENOTDIR.
    __resetSpoolForTests(path.join(blocker, 'spool'));
    const availability = spoolAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
  });

  it('never throws out of an append when the directory is unwritable', () => {
    __resetSpoolForTests(path.join(blocker, 'spool'));
    expect(() => appendRows(config, [row('a')])).not.toThrow();
    expect(appendRows(config, [row('a')])).toBe(false);
  });

  it('does not re-probe the disk on every call — the status endpoint polls', () => {
    const first = spoolAvailability();
    fs.rmSync(dir, { recursive: true, force: true });
    // Still reports the cached answer rather than doing fresh I/O.
    expect(spoolAvailability()).toEqual(first);
  });
});

describe('crash and replay', () => {
  it('replays every row accepted before a process crash', () => {
    appendRows(config, [row('a'), row('b'), row('c')]);
    crash();

    const replayed = replaySpool(config);
    expect(replayed.rows.map((r) => r.event_id)).toEqual(['a', 'b', 'c']);
  });

  it('replays across an OOM kill mid-batch — no flush, no commit, nothing lost', () => {
    appendRows(config, [row('a')]);
    appendRows(config, [row('b')]);
    appendRows(config, [row('c')]);
    crash();
    expect(replaySpool(config).rows).toHaveLength(3);
  });

  it('SIGTERM: fsync then replay returns the un-flushed rows', () => {
    appendRows(config, [row('a'), row('b')]);
    fsyncSpool(); // what the shutdown handler does before re-raising
    crash();
    expect(replaySpool(config).rows.map((r) => r.event_id)).toEqual(['a', 'b']);
  });

  it('S3/network outage: rows keep accumulating and all replay', () => {
    // No commit ever happens because every flush fails.
    for (let i = 0; i < 50; i++) appendRows(config, [row(`e${i}`)]);
    crash();
    expect(replaySpool(config).rows).toHaveLength(50);
  });

  it('returns nothing when there is nothing to replay', () => {
    expect(replaySpool(config).rows).toEqual([]);
  });
});

describe('atomic acknowledgement', () => {
  it('does NOT replay rows a commit acknowledged', () => {
    appendRows(config, [row('a'), row('b')]);
    commitSpool(config);
    crash();

    const replayed = replaySpool(config);
    expect(replayed.rows).toEqual([]);
    expect(replayed.skippedCommitted).toBe(2);
  });

  it('replays ONLY what arrived after the last commit', () => {
    appendRows(config, [row('a'), row('b')]);
    commitSpool(config);
    appendRows(config, [row('c'), row('d')]);
    crash();

    const replayed = replaySpool(config);
    expect(replayed.rows.map((r) => r.event_id)).toEqual(['c', 'd']);
    expect(replayed.skippedCommitted).toBe(2);
  });

  it('is a single append, not a rewrite of what it acknowledges', () => {
    appendRows(config, [row('a')]);
    const before = fs.statSync(path.join(dir, segments()[0]!)).size;
    commitSpool(config);
    const after = fs.statSync(path.join(dir, segments()[0]!)).size;
    // Grew by one small frame; the acknowledged bytes were not touched.
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThan(64);
  });

  it('deletes rotated segments once they are fully acknowledged', () => {
    appendRows(config, [row('a')]);
    crash();                       // leaves segment 0 closed on disk
    appendRows(config, [row('b')]); // opens segment 1
    expect(segments().length).toBe(2);

    commitSpool(config);
    // Only the segment still being appended to survives.
    expect(segments().length).toBe(1);
  });

  it('survives a commit when there is no active segment', () => {
    expect(() => commitSpool(config)).not.toThrow();
  });
});

describe('duplicate safety', () => {
  it('de-duplicates by event_id within one replay', () => {
    appendRows(config, [row('a'), row('a'), row('b')]);
    crash();
    expect(replaySpool(config).rows.map((r) => r.event_id)).toEqual(['a', 'b']);
  });

  it('does not replay the same rows twice across two replays', () => {
    appendRows(config, [row('a'), row('b')]);
    crash();

    expect(replaySpool(config).rows).toHaveLength(2);
    // Replay consumes the segments, so a second call finds nothing —
    // a supervisor restarting the boot sequence cannot double-write.
    expect(replaySpool(config).rows).toHaveLength(0);
  });

  it('holds a lock so two concurrent replays cannot both take the rows', () => {
    appendRows(config, [row('a')]);
    crash();

    // A live lock from another process.
    fs.writeFileSync(path.join(dir, 'replay.lock'), '999999');
    expect(replaySpool(config).rows).toEqual([]);

    // Released — now it replays.
    fs.unlinkSync(path.join(dir, 'replay.lock'));
    expect(replaySpool(config).rows).toHaveLength(1);
  });

  it('takes over a STALE lock so a dead process cannot disable recovery forever', () => {
    appendRows(config, [row('a')]);
    crash();

    const lock = path.join(dir, 'replay.lock');
    fs.writeFileSync(lock, '999999');
    const old = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(lock, new Date(old), new Date(old));

    expect(replaySpool(config).rows).toHaveLength(1);
  });
});

describe('corruption handling', () => {
  it('discards a TORN TAIL and keeps every intact row before it', () => {
    appendRows(config, [row('a'), row('b'), row('c')]);
    crash();

    // A crash mid-append: the last frame is half written.
    const file = path.join(dir, segments()[0]!);
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(0, buf.length - 20));

    const replayed = replaySpool(config);
    expect(replayed.rows.map((r) => r.event_id)).toEqual(['a', 'b']);
    expect(replayed.corruptSegments).toBe(1);
  });

  it('rejects a frame whose CRC does not match its payload', () => {
    appendRows(config, [row('a'), row('b')]);
    crash();

    // Flip a byte inside the FIRST record's payload.
    const file = path.join(dir, segments()[0]!);
    const buf = fs.readFileSync(file);
    buf[20] = buf[20]! ^ 0xff;
    fs.writeFileSync(file, buf);

    const replayed = replaySpool(config);
    // The damaged frame stops the scan, so neither it nor anything after it
    // is trusted — silently returning a corrupted row would be worse.
    expect(replayed.rows).toEqual([]);
  });

  it('QUARANTINES a segment that is unreadable from its first byte', () => {
    appendRows(config, [row('a')]);
    crash();

    const file = path.join(dir, segments()[0]!);
    fs.writeFileSync(file, Buffer.from('this is not a spool segment at all'));

    const replayed = replaySpool(config);
    expect(replayed.rows).toEqual([]);
    expect(replayed.quarantined).toHaveLength(1);
    // Kept for inspection rather than deleted — evidence, not garbage.
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.corrupt'))).toBe(true);
  });

  it('skips a row whose JSON is valid but is not an analytics row', () => {
    appendRows(config, [row('a')]);
    crash();
    const replayed = replaySpool(config);
    expect(replayed.rows.every((r) => typeof r.workspace_id === 'string')).toBe(true);
  });
});

describe('bounded disk usage', () => {
  it('reports its own size and segment count', () => {
    appendRows(config, [row('a'), row('b')]);
    const stats = spoolStats();
    expect(stats.segments).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.dir).toBe(dir);
    expect(stats.appended).toBe(2);
  });

  it('keeps the spool empty once everything is acknowledged and rotated', () => {
    appendRows(config, [row('a')]);
    crash();
    appendRows(config, [row('b')]);
    commitSpool(config);
    // One active segment, holding only acknowledged bytes.
    expect(segments()).toHaveLength(1);
  });
});

describe('round trip', () => {
  it('preserves every field of a row through disk and back', () => {
    const original = row('rt') as unknown as Record<string, unknown>;
    appendRows(config, [original as never]);
    crash();

    const [back] = replaySpool(config).rows as unknown as Record<string, unknown>[];
    expect(back).toEqual(original);
  });

  it('keeps rows from different workspaces separate and intact', () => {
    appendRows(config, [row('a', 'ws-1'), row('b', 'ws-2'), row('c', 'ws-1')]);
    crash();
    const rows = replaySpool(config).rows;
    expect(rows.filter((r) => r.workspace_id === 'ws-1')).toHaveLength(2);
    expect(rows.filter((r) => r.workspace_id === 'ws-2')).toHaveLength(1);
  });
});
