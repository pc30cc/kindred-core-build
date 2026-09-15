#!/usr/bin/env tsx
/**
 * Operator CLI for the storage consistency audit
 * (server/services/storage/consistencyAudit.ts).
 *
 * Usage:
 *   tsx scripts/storage/auditWorkspaceStorage.ts --workspace=<id>
 *   tsx scripts/storage/auditWorkspaceStorage.ts --all [--limit=100]
 *
 * Read-only — reports drift, does not fix it. A dangling pointer or an
 * orphaned object found here should be resolved through the normal
 * deletion/upload paths, not by hand-editing storage or the database.
 */
import { loadConfig } from '../../server/config.js';
import { getServiceClient } from '../../server/supabase.js';
import { auditWorkspaceStorage, type WorkspaceStorageAuditReport } from '../../server/services/storage/consistencyAudit.js';

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

function printReport(report: WorkspaceStorageAuditReport): void {
  const scopeErrors = Object.entries(report.scopes).filter(([, info]) => info.listingError);
  if (scopeErrors.length > 0) {
    for (const [name, info] of scopeErrors) {
      console.error(`[${report.workspaceId}] scope '${name}' LISTING FAILED: ${info.listingError} — categories on this scope are excluded below, not misreported`);
    }
  }
  const clean =
    report.orphanedObjects.length === 0 &&
    report.danglingPointers.length === 0 &&
    report.wrongPrefixRows.length === 0;
  const scopeSummary = Object.entries(report.scopes)
    .map(([name, info]) => `${name}=${info.configured ? info.objectCount : 'unconfigured'}${info.dedupOf ? `(dedup of ${info.dedupOf})` : ''}`)
    .join(' ');
  console.log(
    `[${report.workspaceId}] scopes[${scopeSummary}] objects=${report.storageObjectCount} pointers=${report.dbPointerCount} ` +
      `orphaned=${report.orphanedObjects.length} dangling=${report.danglingPointers.length} ` +
      `wrongPrefix=${report.wrongPrefixRows.length} legacy=${JSON.stringify(report.legacyShapeCounts)}` +
      (report.unreliableCategories.length ? ` unreliable=${report.unreliableCategories.join(',')}` : '') +
      (clean ? ' — clean' : ''),
  );
  if (report.wrongPrefixRows.length > 0) {
    console.warn(`[${report.workspaceId}] WRONG-PREFIX ROWS (ownership-scope bug, needs investigation):`);
    for (const r of report.wrongPrefixRows) console.warn(`  ${r.table}#${r.id} (${r.category}): ${r.key}`);
  }
  if (report.danglingPointers.length > 0) {
    console.warn(`[${report.workspaceId}] dangling pointers (DB row, no object):`);
    for (const r of report.danglingPointers) console.warn(`  ${r.table}#${r.id} (${r.category}, scope ${r.scope}): ${r.key}`);
  }
  if (report.orphanedObjects.length > 0) {
    console.warn(`[${report.workspaceId}] orphaned objects (object, no DB row):`);
    for (const o of report.orphanedObjects) console.warn(`  [${o.scope}] ${o.key}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  let workspaceIds: string[];
  if (typeof args.workspace === 'string') {
    workspaceIds = [args.workspace];
  } else if (args.all === true) {
    const limit = typeof args.limit === 'string' ? parseInt(args.limit, 10) : 100;
    const sb = getServiceClient(config);
    const { data, error } = await sb.from('workspaces').select('id').eq('status', 'active').limit(limit);
    if (error) {
      console.error('Failed to list workspaces:', error.message);
      process.exit(1);
    }
    workspaceIds = (data ?? []).map((w: { id: string }) => w.id);
  } else {
    console.error('Usage: --workspace=<id> or --all [--limit=100]');
    process.exit(1);
  }

  let anyDrift = false;
  for (const workspaceId of workspaceIds) {
    const report = await auditWorkspaceStorage(config, workspaceId);
    printReport(report);
    if (report.listingError || report.orphanedObjects.length || report.danglingPointers.length || report.wrongPrefixRows.length) {
      anyDrift = true;
    }
  }
  console.log(`Audited ${workspaceIds.length} workspace(s).`);
  process.exit(anyDrift ? 1 : 0);
}

main().catch((err) => {
  console.error('Storage consistency audit failed:', err);
  process.exit(1);
});
