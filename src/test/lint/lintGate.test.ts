/**
 * Phase 6-S5-R7.5 §6 — lint-gate self-tests.
 *
 * These prove the gate cannot be bypassed by redistributing problems between
 * files while global counts stay flat, and that the CI runner never rewrites
 * the baseline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { summarize, compareBaseline, relPath } from '../../../scripts/lint-baseline-core.mjs';

const CWD = '/repo';
const err = (ruleId: string | null) => ({ ruleId, severity: 2, message: 'x', line: 1, column: 1 });

const snapshot = (files: Record<string, Array<string | null>>) =>
  summarize(
    Object.entries(files).map(([filePath, rules]) => ({
      filePath: `${CWD}/${filePath}`,
      messages: rules.map((r) => err(r)),
    })),
    CWD,
  );

const ANY = '@typescript-eslint/no-explicit-any';

describe('lint baseline — snapshot shape', () => {
  it('normalizes paths relative to the repository root', () => {
    expect(relPath(`${CWD}/server/example.ts`, CWD)).toBe('server/example.ts');
  });

  it('records per-file and per-rule counts alongside totals', () => {
    const snap = snapshot({ 'server/a.ts': [ANY, ANY], 'src/b.ts': ['prefer-const'] });
    expect(snap.totals).toEqual({ errors: 3, warnings: 0, problems: 3 });
    expect(snap.rules).toEqual({ [ANY]: 2, 'prefer-const': 1 });
    expect(snap.files).toEqual({ 'server/a.ts': { [ANY]: 2 }, 'src/b.ts': { 'prefer-const': 1 } });
  });

  it('records clean files so they can be protected from becoming dirty', () => {
    const snap = snapshot({ 'src/clean.ts': [] });
    expect(snap.files['src/clean.ts']).toEqual({});
  });
});

describe('lint baseline — non-regression gate', () => {
  it('passes when nothing changed', () => {
    const base = snapshot({ 'a.ts': [ANY], 'b.ts': [] });
    expect(compareBaseline(base, snapshot({ 'a.ts': [ANY], 'b.ts': [] }))).toEqual([]);
  });

  it('fails when an error is RELOCATED between files (global counts unchanged)', () => {
    const base = snapshot({ 'a.ts': [ANY, ANY], 'b.ts': [ANY] });
    const after = snapshot({ 'a.ts': [ANY], 'b.ts': [ANY, ANY] });
    expect(after.totals).toEqual(base.totals);
    expect(after.rules).toEqual(base.rules);
    const regressions = compareBaseline(base, after);
    expect(regressions.length).toBeGreaterThan(0);
    expect(regressions.join('\n')).toContain('b.ts');
  });

  it('fails when a parse error moves from one file to another', () => {
    const base = snapshot({ 'a.ts': [null], 'b.ts': [] });
    const after = snapshot({ 'a.ts': [], 'b.ts': [null] });
    expect(after.rules).toEqual(base.rules);
    expect(compareBaseline(base, after).join('\n')).toContain('b.ts');
  });

  it('fails when a brand-new file carries a lint error', () => {
    const base = snapshot({ 'a.ts': [ANY] });
    const after = snapshot({ 'a.ts': [ANY], 'new.ts': [ANY] });
    expect(compareBaseline(base, after).join('\n')).toContain('new file with lint problems: new.ts');
  });

  it('fails when a previously clean file becomes dirty', () => {
    const base = snapshot({ 'clean.ts': [] });
    const after = snapshot({ 'clean.ts': ['prefer-const'] });
    expect(compareBaseline(base, after).join('\n')).toContain('previously clean file is now dirty: clean.ts');
  });

  it('fails when a new rule appears in an existing file', () => {
    const base = snapshot({ 'a.ts': [ANY] });
    const after = snapshot({ 'a.ts': [ANY, 'prefer-const'] });
    expect(compareBaseline(base, after).join('\n')).toContain('new rule in a.ts: prefer-const');
  });

  it('fails when total warnings increase even if errors do not', () => {
    const base = summarize([{ filePath: `${CWD}/a.ts`, messages: [] }], CWD);
    const after = summarize(
      [{ filePath: `${CWD}/a.ts`, messages: [{ ruleId: 'react-hooks/exhaustive-deps', severity: 1 }] }],
      CWD,
    );
    expect(compareBaseline(base, after).join('\n')).toContain('total warnings');
  });

  it('passes when a problem is simply removed', () => {
    const base = snapshot({ 'a.ts': [ANY, ANY] });
    expect(compareBaseline(base, snapshot({ 'a.ts': [ANY] }))).toEqual([]);
  });

  it('does not let an improvement in one file pay for a regression in another', () => {
    const base = snapshot({ 'a.ts': [ANY, ANY, ANY], 'b.ts': [] });
    const after = snapshot({ 'a.ts': [ANY], 'b.ts': [ANY] });
    expect(after.totals.problems).toBeLessThan(base.totals.problems);
    expect(compareBaseline(base, after).length).toBeGreaterThan(0);
  });
});

describe('lint gate — CI wiring', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('keeps the full debt report available', () => {
    expect(pkg.scripts.lint).toBe('eslint .');
  });

  it('exposes the changed-file and baseline gates', () => {
    expect(pkg.scripts['lint:changed']).toBeTruthy();
    expect(pkg.scripts['lint:baseline']).toBeTruthy();
    expect(pkg.scripts['lint:baseline:update']).toBeTruthy();
  });

  it('never regenerates the baseline in CI', () => {
    expect(workflow).not.toContain('lint:baseline:update');
    expect(workflow).toContain('lint:baseline');
    expect(workflow).toContain('lint:changed');
  });

  it('ships a per-file baseline', () => {
    const baseline = JSON.parse(readFileSync('.lint-baseline.json', 'utf8'));
    expect(baseline.files).toBeTruthy();
    expect(Object.keys(baseline.files).length).toBeGreaterThan(0);
  });
});