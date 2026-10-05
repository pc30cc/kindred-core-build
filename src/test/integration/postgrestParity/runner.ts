/**
 * Runs the parity cases against one client and returns comparable results.
 * Shared by the test (engine vs. recorded PostgREST answers) and record.ts
 * (which records them from a real PostgREST).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASES, type Sb } from './cases';

export const PARITY_DIR = join(process.cwd(), 'src', 'test', 'integration', 'postgrestParity');
export const FIXTURE_SQL = readFileSync(join(PARITY_DIR, 'fixture.sql'), 'utf8');
export const SEED_SQL = readFileSync(join(PARITY_DIR, 'seed.sql'), 'utf8');

/**
 * Everything the fixture's tables hold, read through the admin connection
 * after each case — so a case is compared on what the database KEPT (rolled
 * back or not, identity values consumed or not), not only on the response.
 */
export const STATE_SQL = `
  SELECT json_build_object(
    'parent',    (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.id), '[]'::json) FROM pgrst_parity.parent t),
    'child',     (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.id), '[]'::json) FROM pgrst_parity.child t),
    'profile',   (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.parent_id), '[]'::json) FROM pgrst_parity.profile t),
    'workspace', (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.id), '[]'::json) FROM pgrst_parity.workspace t),
    'member',    (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.workspace_id, t.user_name), '[]'::json) FROM pgrst_parity.member t),
    'kv',        (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.key), '[]'::json) FROM pgrst_parity.kv t),
    'rpc_log',   (SELECT coalesce(json_agg(to_jsonb(t) ORDER BY t.id), '[]'::json) FROM pgrst_parity.rpc_log t),
    'next_child_id',   (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM pgrst_parity.child_id_seq),
    'next_rpc_log_id', (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM pgrst_parity.rpc_log_id_seq)
  ) AS state`;

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

export interface CaseOutcome {
  result: Comparable;
  after?: Comparable;
  /** The fixture tables after the case (STATE_SQL). */
  state: unknown;
}

export async function runCases(
  sb: Sb,
  reset: () => Promise<void>,
  readState: () => Promise<unknown>,
): Promise<Record<string, CaseOutcome>> {
  const out: Record<string, CaseOutcome> = {};
  for (const c of CASES) {
    await reset();
    const result = comparable(await c.run(sb));
    const after = c.after ? comparable(await c.after(sb)) : undefined;
    const state = JSON.parse(JSON.stringify(await readState()));
    out[c.name] = after ? { result, after, state } : { result, state };
  }
  return out;
}
