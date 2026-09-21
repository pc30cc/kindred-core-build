/**
 * One number, one migration.
 *
 * Both chains are ordered by filename and nothing else: `psql -f` down a
 * sorted list for the self-host chain, the Supabase CLI's timestamp order for
 * the hosted one. Nothing in either mechanism objects to two files claiming
 * the same position — and git will not object either, because two branches
 * adding `200_a.sql` and `200_b.sql` are adding DIFFERENT files. The merge is
 * clean, the chain is not, and which of the two runs first is decided by the
 * rest of the name.
 *
 * That is not hypothetical here. `200_telephony_foundation.sql` and what was
 * then `200_selfhost_function_execute_acl.sql` were written on two branches
 * in the same week, each correct against the chain it was written on, and the
 * merge of the second into the first produced both with no complaint from
 * anything. The ACL migration asserts a property of every SECURITY DEFINER
 * function in the database; running it before or after the migration that
 * adds one is a different assertion. Alphabetical order picked, and nobody
 * chose. (The ACL migration is 201 now, and the two after it moved up with
 * it — this test is what made the collision visible rather than something a
 * replay found later.)
 *
 * So: the number is the position, the position is unique, and a collision
 * fails here in a second instead of in whichever direction the names happen
 * to sort.
 *
 * A letter suffix is the deliberate way to wedge one in — `016a` runs after
 * `016` and before `017`, which is the whole point of
 * `016a_selfhost_product_parity_base_tables.sql`. That is a position of its
 * own, so it is the number AND its suffix that has to be unique, not the
 * three digits.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SELF_HOST = join(process.cwd(), 'database', 'migrations');
const HOSTED = join(process.cwd(), 'supabase', 'migrations');

function sqlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Files sharing a prefix, reported as "prefix: a.sql, b.sql". */
function collisions(files: string[], prefixOf: (f: string) => string | null): string[] {
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = prefixOf(file);
    if (prefix === null) continue;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  return [...byPrefix.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([prefix, group]) => `${prefix}: ${group.join(', ')}`);
}

describe('the self-host chain (database/migrations)', () => {
  const files = sqlFiles(SELF_HOST);

  it('reads a chain at all (an empty sweep would pass everything below)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('names every migration <number>_<what it does>.sql', () => {
    const odd = files.filter((f) => !/^\d{3}[a-z]*_[a-z0-9_]+\.sql$/.test(f));
    expect(odd).toEqual([]);
  });

  it('gives each position to exactly one migration', () => {
    expect(collisions(files, (f) => /^\d{3}[a-z]*/.exec(f)?.[0] ?? null)).toEqual([]);
  });
});

describe('the hosted chain (supabase/migrations)', () => {
  const files = sqlFiles(HOSTED);

  it('reads a chain at all', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('stamps every migration with a 14-digit timestamp', () => {
    const odd = files.filter((f) => !/^\d{14}_/.test(f));
    expect(odd).toEqual([]);
  });

  it('gives each timestamp to exactly one migration', () => {
    // The CLI records the timestamp, not the filename, in
    // supabase_migrations.schema_migrations — so two files sharing one are
    // one row, and the second is remembered as already applied.
    expect(collisions(files, (f) => f.slice(0, 14))).toEqual([]);
  });
});
