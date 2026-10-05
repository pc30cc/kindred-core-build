/**
 * Runs the parity cases against one client and returns comparable results.
 * Shared by the test (engine vs. recorded PostgREST answers) and record.ts
 * (which records them from a real PostgREST).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CASES } from './cases';

export const PARITY_DIR = join(process.cwd(), 'src', 'test', 'integration', 'postgrestParity');
export const FIXTURE_SQL = readFileSync(join(PARITY_DIR, 'fixture.sql'), 'utf8');
export const SEED_SQL = readFileSync(join(PARITY_DIR, 'seed.sql'), 'utf8');

export interface Comparable {
  data: unknown;
  error: unknown;
  count: unknown;
  status: unknown;
}

/** Everything a caller can observe, minus statusText (an HTTP nicety). */
export function comparable(r: unknown): Comparable {
  const x = (r ?? {}) as Record<string, unknown>;
  // Round-trip through JSON: key order is part of what is compared.
  return JSON.parse(JSON.stringify({ data: x.data ?? null, error: x.error ?? null, count: x.count ?? null, status: x.status ?? null }));
}

export async function runCases(
  sb: SupabaseClient<any, any, any>,
  reset: () => Promise<void>,
): Promise<Record<string, { result: Comparable; after?: Comparable }>> {
  const out: Record<string, { result: Comparable; after?: Comparable }> = {};
  for (const c of CASES) {
    await reset();
    const result = comparable(await c.run(sb));
    const after = c.after ? comparable(await c.after(sb)) : undefined;
    out[c.name] = after ? { result, after } : { result };
  }
  return out;
}
