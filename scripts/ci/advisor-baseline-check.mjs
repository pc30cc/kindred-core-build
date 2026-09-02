#!/usr/bin/env node
/**
 * Workspace Invitations v5.1 — Section H advisor baseline gate.
 *
 * Usage:
 *   psql "$DSN" -At -f scripts/ci/advisor-fingerprints.sql > /tmp/advisor.txt
 *   node scripts/ci/advisor-baseline-check.mjs /tmp/advisor.txt
 *
 * Contract:
 *   - FAIL on every fingerprint that is NOT in security/advisor-baseline.json
 *   - PASS when fingerprints disappear (remediation is always allowed)
 *   - the total does NOT have to stay exactly 76
 */
import { readFileSync } from 'node:fs';

const observedPath = process.argv[2];
if (!observedPath) {
  console.error('usage: advisor-baseline-check.mjs <psql-fingerprint-output>');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(new URL('../../security/advisor-baseline.json', import.meta.url), 'utf8'));
const known = new Set(baseline.findings.map((f) => f.fingerprint));

const observed = readFileSync(observedPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && line.includes(':'));

if (observed.length === 0) {
  console.error('advisor-baseline-check: no fingerprints were produced — the query did not run.');
  process.exit(2);
}

const added = observed.filter((f) => !known.has(f));
const removed = [...known].filter((f) => !observed.includes(f) && !f.startsWith('auth_'));

console.log(`advisor fingerprints observed: ${observed.length} (baseline: ${known.size})`);
if (removed.length) {
  console.log(`resolved since baseline (allowed):\n  ${removed.join('\n  ')}`);
}
if (added.length) {
  console.error(`NEW advisor findings not present in the baseline:\n  ${added.join('\n  ')}`);
  console.error('Fix the finding, or add it to security/advisor-baseline.json WITH a justification and owner.');
  process.exit(1);
}
console.log('advisor baseline OK — no new findings.');
