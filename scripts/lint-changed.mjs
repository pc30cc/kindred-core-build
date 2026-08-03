#!/usr/bin/env node
/**
 * Phase 6-S5-R7.5 §5 — strict changed-file lint gate.
 *
 * Policy: every file touched by the current change must be COMPLETELY
 * ESLint-error-clean. Pre-existing baseline debt in a touched file does not
 * exempt it — if you edit a legacy file you clean it.
 *
 * Base revision resolution:
 *   pull_request  → merge base with $GITHUB_BASE_REF (fetched by CI)
 *   push          → merge base with the before-SHA, else HEAD~1
 *   local         → merge base with origin/main, else HEAD~1
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isLintable, parseNameStatus, baseResolution } from './lint-changed-core.mjs';

function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

function mergeBase(ref) {
  if (!ref) return '';
  return git(['merge-base', 'HEAD', ref], true);
}

function resolveBase() {
  const explicit = process.argv.find((a) => a.startsWith('--base='));
  if (explicit) return explicit.slice('--base='.length);

  if (process.env.GITHUB_BASE_REF) {
    const candidates = [`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF];
    for (const c of candidates) {
      const b = mergeBase(c);
      if (b) return b;
    }
  }
  const before = process.env.GITHUB_EVENT_BEFORE;
  if (before && !/^0+$/.test(before) && git(['cat-file', '-e', `${before}^{commit}`], true) !== undefined) {
    const b = mergeBase(before);
    if (b) return b;
  }
  return mergeBase('origin/main') || git(['rev-parse', 'HEAD~1'], true);
}

const base = resolveBase();
const resolution = baseResolution(base, process.env);
if (resolution.action === 'fail') {
  console.error(`[lint:changed] FAILED — ${resolution.message}`);
  process.exit(2);
}
if (resolution.action === 'skip') {
  console.log(`[lint:changed] ${resolution.message}`);
  process.exit(0);
}

// -M detects renames; the status letter tells us which side to keep.
const raw = git(['diff', '--name-status', '-M', '--diff-filter=ACMRT', base, 'HEAD'], true);
const changed = new Set();
for (const file of parseNameStatus(raw)) {
  if (existsSync(file)) changed.add(file);
}

// Also include not-yet-committed work so the gate is usable locally.
for (const line of git(['diff', '--name-only', 'HEAD'], true).split('\n')) {
  if (line && isLintable(line) && existsSync(line)) changed.add(line);
}

const files = [...changed].sort();
if (files.length === 0) {
  console.log(`[lint:changed] no lintable files changed against ${base.slice(0, 12)}.`);
  process.exit(0);
}

console.log(`[lint:changed] base ${base.slice(0, 12)} — ${files.length} changed file(s):`);
for (const f of files) console.log(`  • ${f}`);

let out = '';
try {
  out = execFileSync('npx', ['eslint', '-f', 'json', '--no-error-on-unmatched-pattern', ...files], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
} catch (err) {
  out = err.stdout?.toString() ?? '';
  if (!out.trim()) {
    console.error('[lint:changed] eslint produced no JSON output:', err.stderr?.toString() ?? err.message);
    process.exit(2);
  }
}

const results = JSON.parse(out);
let errors = 0;
let warnings = 0;
const offenders = [];
for (const r of results) {
  const fileErrors = (r.messages ?? []).filter((m) => m.severity === 2);
  warnings += (r.messages ?? []).length - fileErrors.length;
  if (fileErrors.length) {
    errors += fileErrors.length;
    offenders.push(
      `${r.filePath.replace(`${process.cwd()}/`, '')}\n` +
        fileErrors
          .slice(0, 20)
          .map((m) => `    ${m.line}:${m.column}  ${m.ruleId ?? '(parse-error)'}  ${m.message}`)
          .join('\n'),
    );
  }
}

if (errors > 0) {
  console.error(`\n[lint:changed] FAILED — ${errors} error(s) in files touched by this change:`);
  for (const o of offenders) console.error(`  • ${o}`);
  console.error('\nChanged files must be lint-clean. Do not add blanket eslint-disable comments.');
  process.exit(1);
}

console.log(`[lint:changed] OK — 0 errors, ${warnings} warning(s) across ${files.length} changed file(s).`);