#!/usr/bin/env node
/**
 * Phase 6-S5-R7.5 §4 — per-file / per-rule lint baseline + non-regression gate.
 *
 * The repository currently has thousands of pre-existing ESLint problems, so a
 * bare `eslint .` in CI is red on every commit and therefore enforces nothing.
 * This gate records the CURRENT counts in `.lint-baseline.json` — per file AND
 * per rule AND in total — and fails when a commit makes ANY of them worse. A
 * reduction in one file therefore cannot pay for an increase in another, so a
 * problem cannot be relocated between files. Improvements are always accepted,
 * and `--update` re-records the (lower) numbers.
 *
 * `--update` MUST NOT be run in CI; the workflow only runs the enforcing form.
 *
 *   node scripts/lint-baseline.mjs           # enforce (CI)
 *   node scripts/lint-baseline.mjs --update  # re-record after fixing lint
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { summarize, compareBaseline, improvement } from './lint-baseline-core.mjs';

const BASELINE = '.lint-baseline.json';
const update = process.argv.includes('--update');

if (update && process.env.CI) {
  console.error('[lint-baseline] refusing to regenerate the baseline inside CI. Update it locally in a commit.');
  process.exit(2);
}

let raw = '';
try {
  raw = execFileSync('npx', ['eslint', '.', '-f', 'json'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
} catch (err) {
  // ESLint exits non-zero when problems exist — that is the normal path here.
  raw = err.stdout?.toString() ?? '';
  if (!raw.trim()) {
    console.error('[lint-baseline] eslint produced no JSON output:', err.stderr?.toString() ?? err.message);
    process.exit(2);
  }
}

const results = JSON.parse(raw);
const current = summarize(results, process.cwd());
const { errors, warnings } = current.totals;

if (update || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `[lint-baseline] recorded ${current.totals.problems} problems (${errors} errors, ${warnings} warnings) ` +
      `across ${Object.keys(current.files).length} files.`,
  );
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
if (!base.files) {
  console.error('[lint-baseline] baseline predates per-file enforcement. Run `npm run lint:baseline:update` locally.');
  process.exit(2);
}
const regressions = compareBaseline(base, current);

if (regressions.length) {
  console.error('[lint-baseline] LINT REGRESSION — new problems introduced:');
  for (const r of regressions) console.error(`  • ${r}`);
  console.error('\nFix the new findings. Do not run --update to silence them.');
  process.exit(1);
}

const improved = improvement(base, current);
console.log(
  `[lint-baseline] OK — ${current.totals.problems} problems (baseline ${base.totals.problems}` +
    `${improved > 0 ? `, ${improved} fewer 🎉 run npm run lint:baseline:update to lock it in` : ''}).`,
);
