/**
 * Live Monitoring migration — operationalizes the final-verification
 * checklist item "no executable reference to the 5 dropped table names
 * remains outside migration history". Scans every .ts/.tsx source file for
 * the raw table names as `.from('<table>')` (or template-literal-adjacent)
 * calls; comment mentions explaining what replaced them are fine and are
 * not flagged, since this only matches the Supabase-client call shape.
 *
 * Run this again right before the forward-only DROP migration lands as the
 * last check that nothing was missed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['server', 'src', 'worker'];
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', 'supabase', 'database']);
const RAW_TABLES = [
  'realtime_metric_events',
  'perf_request_samples',
  'perf_process_samples',
  'perf_request_hourly',
  'realtime_metric_hourly',
];

// Matches `.from('table_name'` / `.from("table_name"` — the Supabase-client
// call shape. Deliberately narrow: comment prose mentioning the table name
// (e.g. "replaces `realtime_metric_events`") never matches this pattern.
function findRawTableCalls(content: string): string[] {
  const hits: string[] = [];
  for (const table of RAW_TABLES) {
    const re = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]`);
    if (re.test(content)) hits.push(table);
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe('Live Monitoring — no executable .from() call on the dropped raw telemetry tables', () => {
  it('finds zero `.from(\'<raw_table>\')` call sites outside src/integrations/supabase/types.ts', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) walk(join(REPO_ROOT, dir), files);

    const offenders: Array<{ file: string; tables: string[] }> = [];
    for (const file of files) {
      // The generated Supabase types file legitimately types every table
      // that ever existed (including dropped ones) until it's regenerated
      // as part of the DROP migration's own cleanup — not a runtime call site.
      if (file.endsWith('src/integrations/supabase/types.ts')) continue;
      const content = readFileSync(file, 'utf8');
      const hits = findRawTableCalls(content);
      if (hits.length > 0) offenders.push({ file: relative(REPO_ROOT, file), tables: hits });
    }

    expect(offenders).toEqual([]);
  });
});
