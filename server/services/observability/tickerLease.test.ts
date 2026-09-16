/**
 * The cycle gate introduced by migration 192 lives in two places at once: the
 * seeded `observability_ticker_lease.min_interval_seconds` rows, and
 * TICKER_CYCLE_SECONDS here in the code. Neither is derived from the other at
 * runtime, so nothing stops them drifting apart — and drift is silent and
 * expensive in both directions:
 *
 *   gate too high  -> cycles get skipped, alerts fire late
 *   gate too low   -> replicas resume double-running, which is the exact
 *                     Disk IO regression 192 exists to close
 *
 * So the migration is parsed and compared here, and each ticker's TICK_MS is
 * checked against the gate it is supposed to correspond to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TICKER_CYCLE_SECONDS } from './tickerLease.js';

const MIGRATION = 'database/migrations/192_ticker_lease_cycle_gate.sql';

/** Evaluates the small integer products the tickers write, e.g. `6 * 60 * 60 * 1000`. */
function evalIntProduct(expr: string): number {
  return expr
    .split('*')
    .map((part) => Number(part.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1);
}

function tickMsOf(file: string): number {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/const TICK_MS\s*=\s*([0-9_\s*]+);/);
  if (!m) throw new Error(`no TICK_MS found in ${file}`);
  return evalIntProduct(m[1]);
}

/** The seeded `('name', seconds)` pairs from the migration's INSERT. */
function seededGates(): Record<string, number> {
  const sql = readFileSync(MIGRATION, 'utf8');
  const insert = sql.slice(sql.indexOf('INSERT INTO public.observability_ticker_lease (name, min_interval_seconds)'));
  const body = insert.slice(0, insert.indexOf('ON CONFLICT'));
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/\('([a-z_]+)',\s*(\d+)\)/g)) out[m[1]] = Number(m[2]);
  return out;
}

const TICKER_SOURCES: Record<string, string> = {
  alerting: 'server/services/observability/alertingTicker.ts',
  failover_health: 'server/services/realtime/failoverTicker.ts',
  seo_rank_tracking: 'server/services/seo/rankTrackingTicker.ts',
  gmail_watch_renewal: 'server/services/channels/gmail/watchRenewalTicker.ts',
};

describe('ticker lease cycle gate', () => {
  it('the migration seeds exactly the gates the code declares', () => {
    expect(seededGates()).toEqual({ ...TICKER_CYCLE_SECONDS });
  });

  it('every gated ticker has a source file backing its lease name', () => {
    expect(Object.keys(TICKER_CYCLE_SECONDS).sort()).toEqual(Object.keys(TICKER_SOURCES).sort());
  });

  it.each(Object.entries(TICKER_SOURCES))('%s: the gate is ~85%% of its TICK_MS', (leaseName, file) => {
    const tickSeconds = tickMsOf(file) / 1000;
    const gate = TICKER_CYCLE_SECONDS[leaseName];

    // Below the tick, or a cycle that legitimately came due is refused.
    expect(gate).toBeLessThan(tickSeconds);
    // But not so far below that a second replica slips a duplicate pass in.
    // Floor, not round: on a 30s ticker round() would give 26s and shave the
    // jitter headroom rather than widen it.
    expect(gate).toBe(Math.floor(tickSeconds * 0.85));
  });

  it('the acquire predicate actually consults last_finished_at', () => {
    // A gate nobody reads is the bug 192 fixes, so assert the SQL reads it
    // rather than trusting the column's presence.
    const sql = readFileSync(MIGRATION, 'utf8');
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.observability_try_acquire_ticker_lease'));
    const predicate = fn.slice(fn.indexOf('UPDATE public.observability_ticker_lease'), fn.indexOf('RETURNING true'));
    expect(predicate).toMatch(/last_finished_at/);
    expect(predicate).toMatch(/min_interval_seconds/);
  });
});
