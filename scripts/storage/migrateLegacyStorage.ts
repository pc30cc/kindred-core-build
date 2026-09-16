#!/usr/bin/env tsx
/**
 * Operator CLI for the legacy storage key migration tool
 * (server/services/storage/legacyMigration/*.ts).
 *
 * Usage:
 *   tsx scripts/storage/migrateLegacyStorage.ts --category=email_attachments --dry-run
 *   tsx scripts/storage/migrateLegacyStorage.ts --category=email_attachments --batch-size=50 --loop
 *   tsx scripts/storage/migrateLegacyStorage.ts --category=all --loop
 *
 * Flags:
 *   --category=<name>   One of: email_attachments, account_avatars,
 *                        privacy_exports, call_recordings, workspace_branding,
 *                        all (default: all)
 *                        The authoritative list is allLegacyMigrationProviders()
 *                        in server/services/storage/legacyMigration/categories.ts
 *                        — `--category=<unknown>` prints it. A test keeps this
 *                        comment in step with it, because a category missing
 *                        from here reads as one the tool cannot migrate.
 *   --dry-run            Report only, zero writes. Recommended first run.
 *   --batch-size=<n>     Rows per batch (default 25).
 *   --loop               Keep calling migrateLegacyBatch() until a category
 *                        returns zero results, instead of processing just
 *                        one batch. Safe to Ctrl-C at any point and re-run
 *                        later — see engine.ts's resumability guarantee.
 *   --no-delete-old      Skip the best-effort old-object delete step (keep
 *                        both old and new objects after migration).
 */
import { loadConfig } from '../../server/config.js';
import { migrateLegacyBatch, type LegacyMigrationProvider, type LegacyMigrationRowResult } from '../../server/services/storage/legacyMigration/engine.js';
import { allLegacyMigrationProviders } from '../../server/services/storage/legacyMigration/categories.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function summarize(results: LegacyMigrationRowResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

async function runCategory(provider: LegacyMigrationProvider, opts: { dryRun: boolean; batchSize: number; deleteOld: boolean; loop: boolean }): Promise<void> {
  const config = loadConfig();
  let totalResults = 0;
  for (;;) {
    const batch = await migrateLegacyBatch(config, provider, {
      dryRun: opts.dryRun,
      batchSize: opts.batchSize,
      deleteOld: opts.deleteOld,
    });
    if (batch.results.length === 0) {
      if (totalResults === 0) console.log(`[${provider.category}] nothing to migrate`);
      break;
    }
    totalResults += batch.results.length;
    console.log(`[${provider.category}] batch of ${batch.results.length}:`, summarize(batch.results));
    for (const r of batch.results) {
      if (r.status !== 'migrated' && r.status !== 'dry_run') {
        console.warn(`[${provider.category}] ${r.id}: ${r.status}${r.error ? ` (${r.error})` : ''} — ${r.oldKey} -> ${r.newKey}`);
      }
      if (r.status === 'migrated' && r.oldDeleted === false) {
        console.warn(`[${provider.category}] ${r.id}: migrated but old object delete failed — ${r.oldKey} still present, needs manual cleanup`);
      }
    }
    if (opts.dryRun || !opts.loop) break;
  }
  console.log(`[${provider.category}] done — ${totalResults} row(s) processed`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const category = typeof args.category === 'string' ? args.category : 'all';
  const opts = {
    dryRun: args['dry-run'] === true,
    batchSize: typeof args['batch-size'] === 'string' ? parseInt(args['batch-size'], 10) : 25,
    deleteOld: args['no-delete-old'] !== true,
    loop: args.loop === true,
  };

  const config = loadConfig();
  const providers = allLegacyMigrationProviders(config);
  const targets = category === 'all' ? providers : providers.filter((p) => p.category === category);
  if (targets.length === 0) {
    console.error(`Unknown category "${category}". Valid: ${providers.map((p) => p.category).join(', ')}, all`);
    process.exit(1);
  }

  console.log(`Legacy storage migration — category=${category} dryRun=${opts.dryRun} batchSize=${opts.batchSize} loop=${opts.loop} deleteOld=${opts.deleteOld}`);
  for (const provider of targets) {
    await runCategory(provider, opts);
  }
}

main().catch((err) => {
  console.error('Legacy storage migration failed:', err);
  process.exit(1);
});
