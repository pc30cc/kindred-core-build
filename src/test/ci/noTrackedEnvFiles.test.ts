/**
 * No real environment file is tracked by git.
 *
 * `.env` used to be committed. Environment files hold credentials, and a
 * committed one reaches every clone, fork and CI log for good. Only the
 * `*.example` templates — which document every variable with empty values —
 * belong in the repository; .gitignore keeps the rest out, and this test
 * catches a forced `git add -f`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function trackedFiles(): string[] | null {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return null; // not a git checkout (e.g. an exported tarball): nothing to check
  }
}

const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/;
const TEMPLATE = /\.example$/;

describe('environment files', () => {
  it('only *.example templates are tracked', () => {
    const files = trackedFiles();
    if (!files) return;
    expect(files.filter((f) => ENV_FILE.test(f) && !TEMPLATE.test(f))).toEqual([]);
  });

  it('.gitignore keeps real env files out but lets templates in', () => {
    const lines = readFileSync('.gitignore', 'utf8').split('\n').map((l) => l.trim());
    expect(lines).toContain('.env');
    expect(lines).toContain('.env.*');
    expect(lines).toContain('!.env.example');
    expect(lines).toContain('!.env.*.example');
  });
});
