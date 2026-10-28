/**
 * One Node for the whole project: the production host's (host.respok.app,
 * nodesource 24.22.1 on 2026-10-28).
 *
 * Every image's `FROM node:` carries the same major.minor (alpine, the widget
 * bridge's on bookworm-slim; Dockerfile.frontend says why the minor is
 * pinned), .nvmrc and the "engines" of the two package.json files the images
 * install from carry its major, and every CI job that runs the project's code
 * takes its Node from .nvmrc. So a bump moves them all together, and no job
 * keeps testing on whatever Node its runner happens to ship.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const DOCKERFILES = readdirSync('.').filter((f) => /^Dockerfile(\.|$)/.test(f)).sort();
const WORKFLOWS = readdirSync('.github/workflows').filter((f) => f.endsWith('.yml')).sort();
const nvmrc = readFileSync('.nvmrc', 'utf8').trim();

/** Each `FROM node:<tag>` of a Dockerfile, its tag. */
function nodeTags(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/^FROM\s+node:(\S+)/gm)].map((m) => m[1]);
}

/** The jobs of a workflow, by id: each one's lines, comments left out. */
function jobs(file: string): Map<string, string> {
  const lines = readFileSync(`.github/workflows/${file}`, 'utf8').split('\n');
  const out = new Map<string, string>();
  let inJobs = false;
  let id = '';
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:');
      id = '';
      continue;
    }
    const head = inJobs && /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) {
      id = head[1];
      out.set(id, '');
    } else if (id && !/^\s*#/.test(line)) {
      out.set(id, `${out.get(id)}${line}\n`);
    }
  }
  return out;
}

describe('the Node version', () => {
  it('.nvmrc names a major only', () => {
    expect(nvmrc).toMatch(/^\d+$/);
  });

  it('every image runs the same major.minor, the .nvmrc major', () => {
    const tags = DOCKERFILES.flatMap((f) => nodeTags(f).map((tag) => ({ f, tag })));
    expect(tags.map(({ f }) => f)).toEqual(expect.arrayContaining([
      'Dockerfile', 'Dockerfile.frontend', 'Dockerfile.server', 'Dockerfile.worker',
      'Dockerfile.ai', 'Dockerfile.channels', 'Dockerfile.widget-bridge',
    ]));
    const versions = new Set(tags.map(({ tag }) => tag.split('-')[0]));
    expect(versions.size, JSON.stringify(tags)).toBe(1);
    const [version] = versions;
    expect(version).toMatch(new RegExp(`^${nvmrc}\\.\\d+$`));
    for (const { f, tag } of tags) {
      expect(tag, f).toBe(f === 'Dockerfile.widget-bridge' ? `${version}-bookworm-slim` : `${version}-alpine`);
    }
  });

  it('the root and the backend declare it in "engines"', () => {
    for (const file of ['package.json', 'server/package.json']) {
      expect(JSON.parse(readFileSync(file, 'utf8')).engines?.node, file).toBe(`>=${nvmrc}`);
    }
  });

  it('every setup-node in CI reads .nvmrc', () => {
    for (const file of WORKFLOWS) {
      const yml = readFileSync(`.github/workflows/${file}`, 'utf8');
      expect(yml, file).not.toMatch(/node-version:/);
      const uses = yml.match(/uses: actions\/setup-node@/g) ?? [];
      expect(yml.match(/node-version-file: \.nvmrc\n/g) ?? [], file).toHaveLength(uses.length);
    }
  });

  it('every CI job that runs the project with node, npm or bun sets that Node up first', () => {
    const runsNode = /(^|\s)(node|npm|npx|bun|bunx)\s/m;
    const unset: string[] = [];
    for (const file of WORKFLOWS) {
      for (const [id, body] of jobs(file)) {
        const run = body.search(runsNode);
        if (run < 0) continue;
        const setup = body.indexOf('uses: actions/setup-node@');
        if (setup < 0 || setup > run) unset.push(`${file} ${id}`);
      }
    }
    expect(unset).toEqual([]);
  });
});
