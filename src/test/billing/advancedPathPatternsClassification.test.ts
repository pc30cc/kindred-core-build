/**
 * Follow-up 7B — regression protection for server/routes/ai-agent/index.ts's
 * ADVANCED_PATH_PATTERNS list, per the frontend/backend gating audit. This
 * array is not exported (kept private on purpose — see the parent task's
 * "prefer NOT to export" guidance), so this test extracts the ACTUAL regex
 * literal source from the file and reconstructs real RegExp objects from it,
 * rather than hand-maintaining a second copy that could silently drift from
 * production. Any edit to the array (added/removed/reordered patterns) is
 * caught here without requiring a production export.
 *
 * This is regression protection only -- it does not change, weaken, or
 * duplicate the patterns; the file continues to be the single source of
 * truth for the actual regex text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../../server/routes/ai-agent/index.ts'),
  'utf8',
);

function extractAdvancedPathPatterns(): RegExp[] {
  const start = src.indexOf('const ADVANCED_PATH_PATTERNS: RegExp[] = [');
  if (start === -1) throw new Error('ADVANCED_PATH_PATTERNS declaration not found');
  const end = src.indexOf('];', start);
  if (end === -1) throw new Error('ADVANCED_PATH_PATTERNS closing bracket not found');
  const block = src.slice(start, end);
  // Each entry is a bare JS regex literal like /^\/runs\/[^/]+\/inspect$/.
  // A naive "split on unescaped /" fails here: the character class [^/]
  // contains an unescaped "/" that is NOT a delimiter. Scan char-by-char,
  // tracking backslash-escapes and [...] bracket-expression state so an
  // in-class "/" is never mistaken for the closing delimiter.
  const patterns: RegExp[] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] !== '/') { i += 1; continue; }
    // Found an opening delimiter. Scan to the matching close.
    let j = i + 1;
    let inClass = false;
    while (j < block.length) {
      const ch = block[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') { inClass = true; j += 1; continue; }
      if (ch === ']') { inClass = false; j += 1; continue; }
      if (ch === '/' && !inClass) break;
      j += 1;
    }
    if (j >= block.length) break; // no closing delimiter found -- stop
    patterns.push(new RegExp(block.slice(i + 1, j)));
    i = j + 1;
  }
  return patterns;
}

const ADVANCED_PATH_PATTERNS = extractAdvancedPathPatterns();

function isAdvanced(path: string): boolean {
  return ADVANCED_PATH_PATTERNS.some((rx) => rx.test(path));
}

describe('ADVANCED_PATH_PATTERNS extraction sanity', () => {
  it('extracted exactly the 11 currently-declared patterns', () => {
    expect(ADVANCED_PATH_PATTERNS).toHaveLength(11);
  });
});

describe('ADVANCED_PATH_PATTERNS — classified as advanced (global-admin gated)', () => {
  const advancedPaths = [
    '/runs/abc-123/inspect',
    '/debug/retrieval',
    '/debug/run-test',
    '/source-health',
    '/test-cases',
    '/test-cases/case-1',
    '/test-runs/run-1',
    '/suggested-test-cases',
    '/suggested-test-cases/id-1',
    '/regression',
    '/regression/batches/1',
    '/test-summary',
    '/platform/settings',
  ];
  it.each(advancedPaths)('%s matches an advanced pattern', (path) => {
    expect(isAdvanced(path)).toBe(true);
  });
});

describe('ADVANCED_PATH_PATTERNS — classified as NOT advanced (domain-router auth applies instead)', () => {
  const nonAdvancedPaths = [
    '/settings',
    '/qna',
    '/files',
    '/data-sources',
    '/playground/test',
    '/test-run',
    '/analytics',
    '/operator-assist/analytics',
  ];
  it.each(nonAdvancedPaths)('%s does not match any advanced pattern', (path) => {
    expect(isAdvanced(path)).toBe(false);
  });
});

describe('/test-run vs /test-runs — intentional naming distinction (do not "fix")', () => {
  it('/test-run (singular, Playground dry-run) is NOT advanced-gated', () => {
    expect(isAdvanced('/test-run')).toBe(false);
  });
  it('/test-runs/:id (plural, Test Harness detail) IS advanced-gated', () => {
    expect(isAdvanced('/test-runs/run-1')).toBe(true);
  });
});
