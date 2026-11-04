// @vitest-environment node
/**
 * Dockerfile.worker's HEALTHCHECK reports a worker whose event loop stopped.
 *
 * It was `pgrep -f "worker/index.ts"`, run by Docker as
 * `/bin/sh -c 'pgrep -f "worker/index.ts" > /dev/null || exit 1'`: that
 * shell's own command line contains the pattern, so the check passed with no
 * worker running and never noticed a stuck one. worker/index.ts now writes
 * the time to /tmp/worker-health every 15 s and the check reads its age.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dockerfile = readFileSync('Dockerfile.worker', 'utf8');
const entry = readFileSync('worker/index.ts', 'utf8');

function healthcheckScript(): string {
  const m = dockerfile.match(/HEALTHCHECK[^\n]*\\\n\s*CMD node -e "([^"]+)"/);
  if (!m) throw new Error('HEALTHCHECK node -e command not found in Dockerfile.worker');
  return m[1];
}

describe('Dockerfile.worker healthcheck', () => {
  it('no longer greps the process table', () => {
    expect(dockerfile).not.toMatch(/^\s*CMD pgrep/m);
  });

  it('reads the file the worker entry writes, within the interval it writes it', () => {
    expect(healthcheckScript()).toContain("'/tmp/worker-health'");
    expect(entry).toMatch(/process\.env\.WORKER_HEALTH_FILE \|\| '\/tmp\/worker-health'/);
    const every = Number(entry.match(/WORKER_HEALTH_EVERY_MS = ([\d_]+)/)?.[1].replace(/_/g, ''));
    const limit = Number(healthcheckScript().match(/<(\d+)/)?.[1]);
    expect(every * 3).toBeLessThan(limit + 1);
  });

  it('passes on a fresh file and fails on a stale or missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-health-'));
    const file = join(dir, 'worker-health');
    const script = healthcheckScript().replace("'/tmp/worker-health'", JSON.stringify(file));
    const run = () => spawnSync(process.execPath, ['-e', script]).status;
    expect(run()).not.toBe(0);
    writeFileSync(file, String(Date.now()));
    expect(run()).toBe(0);
    writeFileSync(file, String(Date.now() - 120_000));
    expect(run()).not.toBe(0);
  });
});
