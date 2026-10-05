// @vitest-environment node
/**
 * The in-process PostgREST engine (server/db/postgrest) answers supabase-js
 * exactly as PostgREST 13 — the version Supabase runs — answers it.
 *
 * Each case in postgrestParity/cases.ts is a real supabase-js call. Its answer
 * from a real PostgREST 13.0.8 is recorded in postgrestParity/expected.json
 * (record.ts); this suite runs every case through the engine over the live
 * database and compares data, error, count and status, key order included.
 *
 * Two answers are deliberately NOT PostgREST's. With `return=representation`
 * (a mutation followed by `.select()`), PostgREST re-applies an `or()` filter
 * to the rows it returns — against their NEW values and only the selected
 * columns. So an update can report no rows, and a delete whose or() columns
 * are not selected fails with 42703 and is rolled back. The second is how
 * server/services/privacy/anonymizer.ts deletes identity_merges, so on
 * Supabase that GDPR deletion silently removes nothing. The engine applies the
 * filter once, to the rows being changed, as the code intends; those two cases
 * are asserted against the correct result below.
 *
 * Driven by TEST_DATABASE_URL (any PostgreSQL 15+; the fixture lives in its own
 * schema). Skipped without it.
 */
import { describe, expect, it } from 'vitest';
import { engineResults, expectedResults } from './postgrestParity/compareEngine';

const DSN = process.env.PARITY_DATABASE_URL || process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const INTENDED_DEVIATIONS: Record<string, unknown> = {
  'update with or filter': {
    result: {
      data: [
        { label: 'c1', sent_at: '2026-05-05T00:00:00+00:00' },
        { label: 'c2', sent_at: '2026-05-05T00:00:00+00:00' },
      ],
      error: null,
      count: null,
      status: 200,
    },
  },
  'delete with or and select id': {
    result: { data: [{ id: 1 }, { id: 2 }], error: null, count: null, status: 200 },
    after: { data: [{ id: 3, label: 'c3' }], error: null, count: null, status: 200 },
  },
};

suite('in-process PostgREST engine matches PostgREST 13', () => {
  let got: Record<string, unknown>;
  const want = expectedResults();

  it('runs every case', async () => {
    got = await engineResults(DSN!);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  }, 120_000);

  for (const name of Object.keys(want)) {
    it(name, () => {
      const expected = INTENDED_DEVIATIONS[name] ?? want[name];
      // Stringified so that key order — which callers can observe — counts.
      expect(JSON.stringify(got[name])).toBe(JSON.stringify(expected));
    });
  }
});
