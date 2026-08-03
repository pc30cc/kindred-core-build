import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const DESTEKLY_DOMAIN_MIGRATION =
  '20260415151702_f5980fe3-0727-466d-8035-b28fac940c98.sql';
const DESTEKLY_AI_SEED_MIGRATION =
  '20260504091511_8d47febd-5e1e-47a9-8d3f-de466abf6fc0.sql';
const DESTEKLY_WORKSPACE_UUID = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';

const UUID_RE =
  /'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'/g;

/**
 * Documented classification for every fixed UUID that appears in a
 * data-changing migration statement. An unclassified hardcoded FK seed fails.
 */
const CLASSIFIED_UUIDS: Record<string, { reason: string; safety: string }> = {
  // Parent-aware conditional seed: inserted via SELECT FROM public.workspaces.
  [DESTEKLY_WORKSPACE_UUID]: {
    reason: 'parent-aware conditional seed',
    safety: 'INSERT ... SELECT FROM public.workspaces / DO-block parent guard',
  },
  // Deterministic sentinel used only inside COALESCE for unique indexes.
  '00000000-0000-0000-0000-000000000000': {
    reason: 'deterministic system identifier',
    safety: 'sentinel value, never inserted as a foreign key',
  },
  // Historical conversation de-duplication: UPDATE-only, matches by primary
  // key, so a pristine database simply updates zero rows.
  'e92a8332-2a17-429f-9b38-f60cf3449544': {
    reason: 'parent-aware conditional seed',
    safety: 'UPDATE ... WHERE id = <uuid>; zero rows when absent',
  },
  '09ee273d-b87e-4c54-ac53-02baade242d5': {
    reason: 'parent-aware conditional seed',
    safety: 'UPDATE ... WHERE id = ANY(...); zero rows when absent',
  },
  'c6bd5174-3b20-48e4-be05-39fa882c601e': {
    reason: 'parent-aware conditional seed',
    safety: 'UPDATE ... WHERE id = ANY(...); zero rows when absent',
  },
};

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

describe('destekly.tr domain seed is parent-aware', () => {
  const sql = read(DESTEKLY_DOMAIN_MIGRATION);

  it('does not use a direct VALUES insert with the fixed workspace UUID', () => {
    expect(sql).not.toMatch(
      new RegExp(`VALUES\\s*\\(\\s*'${DESTEKLY_WORKSPACE_UUID}'`, 'i'),
    );
  });

  it('selects the workspace from public.workspaces', () => {
    expect(sql).toMatch(/INSERT INTO public\.workspace_domains[\s\S]*?SELECT/i);
    expect(sql).toMatch(/FROM public\.workspaces/i);
  });

  it('uses the fixed UUID in a WHERE condition against the parent table', () => {
    expect(sql).toMatch(
      new RegExp(`WHERE\\s+w\\.id\\s*=\\s*'${DESTEKLY_WORKSPACE_UUID}'::uuid`, 'i'),
    );
  });

  it('introduces no constraint disabling', () => {
    expect(sql).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(sql).not.toMatch(/DROP\s+CONSTRAINT/i);
    expect(sql).not.toMatch(/NOT\s+VALID/i);
    expect(sql).not.toMatch(/SET\s+CONSTRAINTS/i);
    expect(sql).not.toMatch(/session_replication_role/i);
  });

  it('inserts no fake workspaces, auth users or accounts', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?workspaces/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+auth\.users/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?accounts/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?profiles/i);
  });
});

describe('destekly AI agent seed is parent-aware', () => {
  const sql = read(DESTEKLY_AI_SEED_MIGRATION);

  it('skips cleanly when the parent workspace is absent', () => {
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM public\.workspaces w WHERE w\.id = ws\)[\s\S]{0,80}RETURN;/i,
    );
  });

  it('does not fabricate the parent workspace', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?workspaces/i);
  });
});

describe('fixed-UUID inventory across supabase/migrations', () => {
  it('classifies every hardcoded UUID used in a data statement', () => {
    const inventory: Array<{ file: string; uuid: string; classification: string }> = [];
    const unclassified: Array<{ file: string; uuid: string }> = [];

    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
      const sql = read(file);
      if (!/\b(INSERT\s+INTO|UPDATE\s|DELETE\s+FROM|MERGE\s+INTO)/i.test(sql)) continue;
      for (const match of sql.match(UUID_RE) ?? []) {
        const uuid = match.slice(1, -1).toLowerCase();
        const entry = CLASSIFIED_UUIDS[uuid];
        if (entry) {
          inventory.push({ file, uuid, classification: entry.reason });
        } else {
          unclassified.push({ file, uuid });
        }
      }
    }

    // Reviewable inventory, not a silent allowlist.
    console.table(inventory);

    expect(unclassified).toEqual([]);
  });
});
