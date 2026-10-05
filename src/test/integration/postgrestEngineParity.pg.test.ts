// @vitest-environment node
/**
 * The in-process PostgREST engine (server/db/postgrest) answers supabase-js
 * exactly as the PostgREST the production project runs answers it.
 *
 * Each case in postgrestParity/cases.ts is a real supabase-js call. What a
 * real PostgREST answered — data, error, count, status, key order — and what
 * the fixture's tables held afterwards (rows kept or rolled back, identity
 * values consumed) is recorded in postgrestParity/expected.json (record.ts;
 * the version is its `recordedWith`, 14.5 — read from the production
 * project's connections). This suite runs every case through the engine over
 * the live database and compares all of it, with no exceptions.
 *
 * Driven by TEST_DATABASE_URL (any PostgreSQL 15+; the fixture lives in its own
 * schema). Skipped without it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineResults, expectedResults } from './postgrestParity/compareEngine';
import { PARITY_DIR } from './postgrestParity/runner';

const DSN = process.env.PARITY_DATABASE_URL || process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

describe('the recorded reference', () => {
  it('comes from the PostgREST version production runs', () => {
    const recorded = JSON.parse(readFileSync(join(PARITY_DIR, 'expected.json'), 'utf8')).recordedWith;
    expect(recorded).toBe('postgrest/14.5');
  });

  it('holds the database state after every case, not only the response', () => {
    const want = expectedResults() as Record<string, { state?: unknown }>;
    const missing = Object.entries(want).filter(([, v]) => v.state === undefined).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});

suite('in-process PostgREST engine matches the production PostgREST', () => {
  let got: Record<string, unknown>;
  const want = expectedResults();

  it('runs every case', async () => {
    got = await engineResults(DSN!);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  }, 180_000);

  for (const name of Object.keys(want)) {
    it(name, () => {
      // Stringified so that key order — which callers can observe — counts.
      expect(JSON.stringify(got[name])).toBe(JSON.stringify(want[name]));
    });
  }
});
