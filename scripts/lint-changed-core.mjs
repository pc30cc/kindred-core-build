/**
 * Phase 6-S5-R7.5.1 §3 — changed-file lint gate core.
 *
 * Pure functions so the fail-closed behaviour is unit-testable without a git
 * repository. `scripts/lint-changed.mjs` is the only runner.
 */

const LINTABLE = /\.(ts|tsx|js|mjs|cjs)$/;

export function isLintable(file) {
  return LINTABLE.test(file);
}

/**
 * Parses `git diff --name-status -M` output into the set of paths to lint.
 * For renames/copies only the NEW path is linted.
 */
export function parseNameStatus(raw) {
  const files = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const file = status.startsWith('R') || status.startsWith('C') ? parts[2] : parts[1];
    if (file && isLintable(file)) files.push(file);
  }
  return files;
}

/**
 * Fail-closed policy. In CI an unresolvable base revision means the gate would
 * silently lint NOTHING, so it must be a hard failure instead of a pass.
 * Locally (no CI env) it stays advisory so a shallow clone is still usable.
 *
 * @returns {{ action: 'run' | 'fail' | 'skip', message?: string }}
 */
export function baseResolution(base, env = {}) {
  if (base) return { action: 'run' };
  if (env.CI) {
    return {
      action: 'fail',
      message:
        'no base revision could be resolved in CI. The changed-file gate would lint nothing, ' +
        'so it fails closed. Ensure actions/checkout uses fetch-depth: 0.',
    };
  }
  return { action: 'skip', message: 'no base revision available locally — nothing to compare.' };
}
