/**
 * The migration CLI's documented categories must be the registered ones.
 *
 * `--category=all` is driven by `allLegacyMigrationProviders()`, so the tool
 * has always been able to migrate every category. Its usage comment, written
 * by hand, listed four of the five — `workspace_branding` was missing, which
 * reads as "this tool cannot fix those rows". Those are exactly the rows that
 * still carry a frozen absolute URL naming whichever CDN was configured the
 * day the file was uploaded.
 *
 * A hand-maintained list beside a generated one drifts. This is the guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { allLegacyMigrationProviders } from '../../../server/services/storage/legacyMigration/categories.js';

const CLI = readFileSync('scripts/storage/migrateLegacyStorage.ts', 'utf8');

/** The registered categories, from the same function the CLI itself uses. */
function registeredCategories(): string[] {
  // Constructing a provider builds a Supabase client, which insists on a
  // URL and a key. Nothing here issues a query, so placeholders are enough.
  const providers = allLegacyMigrationProviders({
    supabaseUrl: 'https://placeholder.supabase.co',
    supabaseServiceRoleKey: 'placeholder-service-role-key',
  } as never);
  return providers.map((p) => p.category).sort();
}

/** The `--category=` line(s) of the usage comment. */
function documentedCategories(): string[] {
  const start = CLI.indexOf(' *   --category=<name>');
  expect(start, 'the CLI must document --category').toBeGreaterThan(-1);
  const block = CLI.slice(start, CLI.indexOf(' *   --dry-run', start));
  return block
    .split(/[\s,]+/)
    .map((w) => w.replace(/[^a-z_]/g, ''))
    .filter((w) => /^[a-z]+(_[a-z]+)+$/.test(w))
    .sort();
}

describe('the CLI documents every category it can actually run', () => {
  it('lists all of them', () => {
    const registered = registeredCategories();
    expect(registered.length).toBeGreaterThanOrEqual(5);
    const missing = registered.filter((c) => !documentedCategories().includes(c));
    expect(missing, 'categories the tool runs but does not document').toEqual([]);
  });

  it('documents none it cannot run', () => {
    const registered = registeredCategories();
    const phantom = documentedCategories().filter((c) => !registered.includes(c));
    expect(phantom, 'categories documented but not registered').toEqual([]);
  });

  it('still covers workspace branding, where the frozen-URL rows live', () => {
    // The specific gap this guard was written for.
    expect(registeredCategories()).toContain('workspace_branding');
    expect(documentedCategories()).toContain('workspace_branding');
  });

  it('prints the real list when given an unknown category', () => {
    // The runtime error message is derived, so it was right all along — and
    // it is what an operator actually reaches for.
    expect(CLI).toContain('providers.map((p) => p.category).join(\', \')');
  });
});
