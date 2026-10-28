/**
 * The outside uptime monitor (.github/workflows/uptime.yml).
 *
 * Every other production alert runs on the server itself, so this workflow is
 * the only one that notices the host or its network going down. Pinned here:
 * its schedule, the endpoints it asks and what each must answer, and that it
 * runs with read-only contents and no secrets.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const yml = readFileSync('.github/workflows/uptime.yml', 'utf8');

/** The lines of a `key: |` block scalar, its indentation removed. */
function blockScalar(key: string): string[] {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trimStart() === `${key}: |`);
  if (start < 0) return [];
  const keyIndent = lines[start].length - lines[start].trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= keyIndent) break;
    body.push(line.trim());
  }
  return body.filter(Boolean);
}

describe('uptime workflow', () => {
  it('runs every 10 minutes and by hand, and on nothing else', () => {
    expect(yml).toMatch(/^on:\n {2}schedule:\n {4}- cron: '\*\/10 \* \* \* \*'\n {2}workflow_dispatch:\n\n/m);
    expect(yml.match(/cron:/g) ?? []).toHaveLength(1);
    expect(yml).not.toMatch(/^ {2}(push|pull_request|pull_request_target|workflow_run):/m);
  });

  it('asks every public endpoint of both brands for the answer it must give', () => {
    expect(blockScalar('CHECKS').map((l) => l.split(/\s+/))).toEqual([
      ['https://api.webyar.ai/api/health', '200', '-'],
      ['https://api.respok.app/api/health', '200', '-'],
      ['https://app.webyar.ai/', '200', '-'],
      ['https://app.respok.app/', '200', '-'],
      ['https://channels.webyar.ai/ready', '200', '-'],
      ['https://livekit.webyar.ai/', '200', 'OK'],
      ['https://livekit.respok.app/', '200', 'OK'],
      ['https://webyar.ai/', '200,3xx', '-'],
      ['https://respok.app/', '200,3xx', '-'],
    ]);
  });

  it('counts an endpoint down only after 3 tries of 10 s, 20 s apart', () => {
    expect(yml).toContain('for try in 1 2 3; do');
    expect(yml).toContain('[ "$try" = 1 ] || sleep 20');
    expect(yml).toContain('--max-time 10');
    // The answer is judged by the script, so curl must neither retry nor
    // follow a redirect on its own.
    expect(yml).not.toMatch(/curl[^\n]*(--retry|-L\b|--location)/);
  });

  it('fails the run when one is down, and writes the table to the job summary', () => {
    expect(yml).toContain('"$down" -gt 0');
    expect(yml).toContain('exit 1');
    expect(yml).toContain('>>"$GITHUB_STEP_SUMMARY"');
    // The red run is the alert (GitHub e-mails it), so nothing may turn a
    // failure green or skip the probe.
    expect(yml).not.toContain('continue-on-error');
    expect(yml).not.toMatch(/^\s+if:/m);
  });

  it('reads contents only, uses no secret and never piles up', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(yml.match(/permissions:/g) ?? []).toHaveLength(1);
    expect(yml).not.toContain('secrets.');
    expect(yml).toMatch(/^concurrency:\n {2}group: uptime\n {2}cancel-in-progress: false\n/m);
    expect(yml).toContain('runs-on: ubuntu-24.04');
    const timeout = Number(/timeout-minutes: (\d+)/.exec(yml)?.[1]);
    // An endpoint takes up to 70 s to be called down (3 tries of 10 s, 20 s
    // apart): a 1-minute limit would cancel the run before it fails.
    expect(timeout).toBeGreaterThanOrEqual(2);
    expect(timeout).toBeLessThanOrEqual(5);
  });
});
