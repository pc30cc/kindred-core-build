/**
 * Crash-test child — a REAL backend process, for the crash tests to kill.
 *
 * The unit tests simulate a crash by dropping in-process state. That proves
 * the format and the watermark logic, and it cannot prove the thing that
 * actually matters in production: that bytes handed to `fs.writeSync` before
 * a `kill -9` are still on disk afterwards, because the page cache belongs
 * to the kernel and not to the process that died.
 *
 * Only a real process, really killed, can show that. This is that process.
 *
 * Usage:
 *   node scripts/analytics-spool-child.mjs <spoolDir> <rowCount> [mode]
 *
 *   mode = wait      append, print READY, then block until killed (SIGKILL)
 *          sigterm   append, print READY, then drain+fsync on SIGTERM
 *          commit    append, commit (simulating a successful flush), then wait
 *
 * It prints one line, `READY <n>`, once every row is on disk. The parent
 * waits for that line before signalling, so the kill lands at a known point
 * rather than a racy one.
 */

import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

const [, , spoolDir, rowCountRaw, mode = 'wait'] = process.argv;

if (!spoolDir) {
  console.error('usage: analytics-spool-child.mjs <spoolDir> <rowCount> [mode]');
  process.exit(2);
}

const rowCount = Number(rowCountRaw ?? 10);
process.env.ANALYTICS_SPOOL_DIR = spoolDir;

// Imported through tsx's loader (the parent runs us with --import tsx), so the
// child exercises the SAME module the backend does, not a copy.
const spoolPath = path.resolve(process.cwd(), 'server/services/analytics/spool.ts');
const spool = await import(pathToFileURL(spoolPath).href);

const config = {};

/** Deterministic ids so the parent can assert exactly-once by name. */
function row(index) {
  const occurredAt = Date.parse('2026-08-10T10:00:00.000Z') + index * 1000;
  return {
    schema_version: 2,
    event_id: `crash-${String(index).padStart(5, '0')}`,
    workspace_id: process.env.CRASH_TEST_WORKSPACE || 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    visitor_id: `visitor-${index % 3}`,
    session_id: `session-${index % 3}`,
    event_type: 'page_view',
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    session_started_at: Date.parse('2026-08-10T10:00:00.000Z'),
    session_last_seen_at: Date.parse('2026-08-10T10:20:00.000Z'),
    url: `https://shop.test/p${index % 7}`,
    path: `/p${index % 7}`,
    title: `Page ${index % 7}`,
    referrer: null,
    referrer_domain: null,
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
    browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US',
    country: 'Iran', country_code: 'IR', city: 'Tehran',
    event_name: null, properties: null,
  };
}

const rows = Array.from({ length: rowCount }, (_, i) => row(i));
const ok = spool.appendRows(config, rows);
if (!ok) {
  console.error('CHILD: append failed');
  process.exit(3);
}

if (mode === 'commit') {
  // Models a flush that reached S3: the rows are acknowledged, so a crash
  // after this point must replay NOTHING.
  spool.commitSpool(config);
}

if (mode === 'sigterm') {
  process.on('SIGTERM', () => {
    // What the real shutdown handler does before re-raising the signal.
    spool.fsyncSpool();
    console.log('DRAINED');
    process.exit(0);
  });
}

console.log(`READY ${rows.length}`);

// Block forever. The parent decides how this process dies.
setInterval(() => {}, 1 << 30);
