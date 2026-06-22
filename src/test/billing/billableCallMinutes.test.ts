/**
 * Foundation tests for max_call_minutes_per_month.
 *
 * Scope:
 *   1. Canonical billable-minute helper (`computeBillable`) matches
 *      the locked policy exactly.
 *   2. The DB trigger contract is the sole writer of
 *      `workspace_usage_counters.call_minutes_used` — verified at the
 *      lint level (no application-side writes to that column).
 *
 * Trigger-level behavioral verification (idempotency, UTC bucketing,
 * non-connected outcomes producing no write) is covered by the SQL
 * guards in the migration itself; we exercise the pure helper to
 * lock in the read-side semantics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeBillable } from '../../../server/services/calls/billableMinutes';

describe('computeBillable — canonical billable-minute signal', () => {
  it('non-ended state is never billable', () => {
    const r = computeBillable({ state: 'active', connected_at: '2026-06-01T10:00:00Z', ended_at: '2026-06-01T10:05:00Z' });
    expect(r.billable).toBe(false);
    expect(r.minutes).toBe(0);
    expect(r.reason).toBe('not_ended');
  });

  it('ended with no connected_at is never billable', () => {
    const r = computeBillable({ state: 'ended', connected_at: null, ended_at: '2026-06-01T10:05:00Z' });
    expect(r.billable).toBe(false);
    expect(r.minutes).toBe(0);
    expect(r.reason).toBe('never_connected');
  });

  it('ended with connected_at + ended_at computes from connected_at, not created_at', () => {
    // 3m 1s of connected time → CEIL = 4 minutes
    const r = computeBillable({
      state: 'ended',
      connected_at: '2026-06-15T12:00:00Z',
      ended_at:     '2026-06-15T12:03:01Z',
    });
    expect(r.billable).toBe(true);
    expect(r.seconds).toBe(181);
    expect(r.minutes).toBe(4);
    expect(r.periodUtc).toBe('2026-06');
  });

  it('zero connected duration produces no billable usage', () => {
    const r = computeBillable({
      state: 'ended',
      connected_at: '2026-06-15T12:00:00Z',
      ended_at:     '2026-06-15T12:00:00Z',
    });
    expect(r.billable).toBe(false);
    expect(r.minutes).toBe(0);
    expect(r.reason).toBe('zero_duration');
  });

  it('1-second connected duration rounds up to 1 minute', () => {
    const r = computeBillable({
      state: 'ended',
      connected_at: '2026-06-15T12:00:00Z',
      ended_at:     '2026-06-15T12:00:01Z',
    });
    expect(r.billable).toBe(true);
    expect(r.minutes).toBe(1);
  });

  it('UTC month bucketing uses ended_at (month boundary)', () => {
    // ended just after UTC midnight on July 1 → July bucket even though
    // connected was June.
    const r = computeBillable({
      state: 'ended',
      connected_at: '2026-06-30T23:59:30Z',
      ended_at:     '2026-07-01T00:00:30Z',
    });
    expect(r.billable).toBe(true);
    expect(r.periodUtc).toBe('2026-07');
  });
});

describe('call_minutes_used — single-writer invariant', () => {
  it('no application code writes to call_minutes_used (DB trigger is sole writer)', () => {
    const ROOT = resolve(__dirname, '../../..');
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    function* walk(dir: string): Generator<string> {
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          if (entry === 'node_modules' || entry === 'dist') continue;
          yield* walk(full);
        } else if (full.endsWith('.ts')) {
          yield full;
        }
      }
    }

    for (const dir of ['server', 'worker']) {
      const abs = resolve(ROOT, dir);
      for (const file of walk(abs)) {
        const src = readFileSync(file, 'utf8');
        if (!src.includes('call_minutes_used')) continue;
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes('call_minutes_used')) continue;
          // Reads (select, column-name in a type literal) are fine. Flag
          // assignment-style writes only.
          if (/call_minutes_used\s*:/.test(line) || /\bset\s+call_minutes_used\b/i.test(line)) {
            offenders.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: line.trim() });
          }
        }
      }
    }

    expect(
      offenders,
      `Forbidden call_minutes_used writes detected — DB trigger tg_call_sessions_bill_minutes is the sole writer:\n` +
        offenders.map((o) => `  ${o.file}:${o.line} → ${o.text}`).join('\n'),
    ).toEqual([]);
  });
});