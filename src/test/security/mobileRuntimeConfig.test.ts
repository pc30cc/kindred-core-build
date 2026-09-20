/**
 * The native bundle must ship a NON-EMPTY, deterministic API base.
 *
 * On the web an empty `apiBaseUrl` is correct (same-origin + nginx proxy),
 * but inside the iOS shell the origin is `capacitor://localhost`, so an
 * empty base makes every API call fail. `npx cap sync ios` overwrites
 * `ios/App/App/public/` from `dist/`, so the value has to be generated into
 * `dist/runtime-config.js` on each sync rather than hand-edited.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repo = process.cwd();
const script = join(repo, 'scripts/ios/write-runtime-config.mjs');
const dirs: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ios-runtime-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'dist'));
  mkdirSync(join(dir, 'config'));
  mkdirSync(join(dir, 'scripts/ios'), { recursive: true });
  mkdirSync(join(dir, 'public'));
  cpSync(join(repo, 'public/runtime-config.js'), join(dir, 'public/runtime-config.js'));
  cpSync(script, join(dir, 'scripts/ios/write-runtime-config.mjs'));
  cpSync(join(repo, 'config/mobile-runtime.json'), join(dir, 'config/mobile-runtime.json'));
  writeFileSync(join(dir, 'dist/runtime-config.js'), 'window.__APP_RUNTIME_CONFIG__ = { apiBaseUrl: "" };');
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  return execFileSync('node', ['scripts/ios/write-runtime-config.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ios runtime-config generation', () => {
  it('replaces the empty web API base with the committed mobile API base', () => {
    const dir = sandbox();
    run(dir);
    const out = readFileSync(join(dir, 'dist/runtime-config.js'), 'utf8');
    // The web key keeps its same-origin value; the native key is explicit.
    expect(out).toMatch(/mobileApiBaseUrl:\s*"https:\/\//);
    expect(out).not.toMatch(/mobileApiBaseUrl:\s*""/);
  });

  it('honours the MOBILE_API_BASE_URL override and strips trailing slashes', () => {
    const dir = sandbox();
    run(dir, { MOBILE_API_BASE_URL: 'https://api.example.com//' });
    const out = readFileSync(join(dir, 'dist/runtime-config.js'), 'utf8');
    expect(out).toContain('mobileApiBaseUrl: "https://api.example.com"');
    expect(out).not.toContain('example.com/"');
  });

  it('fails the build rather than shipping an empty or non-https base', () => {
    const dir = sandbox();
    expect(() => run(dir, { MOBILE_API_BASE_URL: ' ' })).toThrow();
    expect(() => run(dir, { MOBILE_API_BASE_URL: 'http://api.example.com' })).toThrow();
  });

  it('is idempotent — re-running after a sync yields the same file', () => {
    const dir = sandbox();
    run(dir);
    const first = readFileSync(join(dir, 'dist/runtime-config.js'), 'utf8');
    run(dir);
    expect(readFileSync(join(dir, 'dist/runtime-config.js'), 'utf8')).toBe(first);
  });
});
