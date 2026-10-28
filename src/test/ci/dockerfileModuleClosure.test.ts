// @vitest-environment node
/**
 * Every module a backend image runs is in that image.
 *
 * Dockerfile.widget-bridge copies its worker and a hand-picked list of
 * server/ and shared/ files; the other backend images copy a few directories
 * each, and Dockerfile.server also moves server/ to /app and bridges the
 * repository's sibling layout with symlinks. A relative import of a file the
 * Dockerfile leaves out passes typecheck, lint and every unit test, then
 * crashes the container with ERR_MODULE_NOT_FOUND: at start for a static
 * import, at first use for a dynamic one. worker/widget-bridge/adapters.ts
 * imported server/services/widgetBridge/providerIds.ts that way before
 * Dockerfile.widget-bridge copied it.
 *
 * For each root Dockerfile that copies a chosen set of files and runs a .ts
 * entry (its CMD), this follows the entry's imports as tsx loads them
 * (esbuild's metafile: static imports, re-exports and literal dynamic
 * imports; type-only imports are erased, so they are not followed) through
 * the image's file system, laid out by its COPY lines in order and the
 * `ln -s` links of its RUN lines, and checks that each lands on the file it
 * lands on in the repository. A Dockerfile that copies the whole build
 * context (`COPY . .`) cannot leave a module out and is not checked.
 * Packages (node_modules), wildcard COPY sources and .dockerignore are out of
 * scope here.
 */
import { describe, it, expect } from 'vitest';
import { buildSync } from 'esbuild';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const ROOT = process.cwd();

/**
 * Imports an image does not carry on purpose, by Dockerfile, as
 * `<importer> -> <specifier>`. Neither the import nor what only it reaches is
 * followed.
 */
const NOT_IN_IMAGE: Record<string, string[]> = {
  // The in-process workers are dev/local only (AI_KB_INTELLIGENCE_WORKER_INPROC,
  // AI_AGENT_REGRESSION_WORKER_INPROC); production runs them from Dockerfile.worker.
  'Dockerfile.server': [
    'server/index.ts -> ../worker/intelligence/index.js',
    'server/index.ts -> ../worker/regression-runner/index.js',
  ],
};

interface Copy { sources: string[]; dest: string; intoDir: boolean }
interface Image {
  copies: Copy[];
  /** `ln -s` links as [link, target]. */
  links: [string, string][];
  /** The .ts file the CMD runs, as an image path. */
  entry: string | null;
  wholeContext: boolean;
}

function parseDockerfile(text: string): Image {
  const image: Image = { copies: [], links: [], entry: null, wholeContext: false };
  let workdir = '/';
  const lines = text
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n');
  for (const line of lines) {
    const [instruction = '', ...args] = line.trim().split(/\s+/);
    const body = line.trim().slice(instruction.length).trim();
    switch (instruction.toUpperCase()) {
      case 'WORKDIR':
        workdir = posix.resolve(workdir, args[0]);
        break;
      case 'COPY':
      case 'ADD': {
        if (args.some((a) => a.startsWith('--from'))) break;
        const paths = args.filter((a) => !a.startsWith('--'));
        const dest = paths.pop()!;
        const sources = paths.map((p) => posix.normalize(p).replace(/\/$/, ''));
        if (sources.includes('.')) image.wholeContext = true;
        image.copies.push({
          sources,
          dest: posix.resolve(workdir, dest),
          intoDir: sources.length > 1 || dest.endsWith('/') || dest === '.',
        });
        break;
      }
      case 'RUN':
        for (const [, target, link] of body.matchAll(/\bln\s+-[a-z]*s[a-z]*\s+(\S+)\s+(\S+)/g)) {
          image.links.push([posix.resolve(workdir, link), posix.resolve(workdir, target)]);
        }
        break;
      case 'CMD': {
        const argv: string[] = body.startsWith('[') ? JSON.parse(body) : args;
        const script = argv.find((a) => /\.[cm]?ts$/.test(a));
        image.entry = script ? posix.resolve(workdir, script) : null;
        break;
      }
    }
  }
  return image;
}

const stat = (file: string) => statSync(join(ROOT, file), { throwIfNoEntry: false });

/** `path` with the image's symlinks followed. */
function realPath(image: Image, path: string): string {
  for (let hops = 0; hops < 8; hops++) {
    const link = image.links.find(([from]) => path === from || path.startsWith(`${from}/`));
    if (!link) break;
    path = link[1] + path.slice(link[0].length);
  }
  return path;
}

/** The repository file the image holds at `path` (a real path): the last COPY that put one there. */
function sourceAt(image: Image, path: string): string | null {
  for (const { sources, dest, intoDir } of [...image.copies].reverse()) {
    for (const src of sources) {
      if (/[*?[]/.test(src)) continue;
      const dir = stat(src)?.isDirectory() ?? false;
      const base = realPath(image, dir || !intoDir ? dest : posix.join(dest, posix.basename(src)));
      if (dir) {
        const rest = base === '/' ? path.slice(1) : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
        if (rest !== null && stat(posix.join(src, rest))?.isFile()) return posix.join(src, rest);
      } else if (path === base && stat(src)?.isFile()) {
        return src;
      }
    }
  }
  return null;
}

/**
 * Where `spec`, imported by the module at image path `at`, points in the
 * image, given that it points from `written` (the specifier joined to the
 * importer's folder) to `resolved` in the repository: as written, with an
 * extension or /index.ts added, or with .js read as .ts.
 */
function imageTarget(at: string, spec: string, written: string, resolved: string): string {
  const path = posix.resolve(posix.dirname(at), spec);
  if (resolved.startsWith(written)) return path + resolved.slice(written.length);
  const stem = (p: string) => p.slice(0, p.length - posix.extname(p).length);
  return stem(resolved) === stem(written) ? stem(path) + posix.extname(resolved) : path;
}

/** The imports of `name`'s entry that the image does not carry, and the exemptions used. */
function missingModules(name: string, image: Image): { missing: string[]; exempted: string[] } {
  const exemptions = NOT_IN_IMAGE[name] ?? [];
  const missing: string[] = [];
  const exempted = new Set<string>();
  if (!image.entry) return { missing: ['its CMD runs no .ts entry'], exempted: [] };
  const start = realPath(image, image.entry);
  const entry = sourceAt(image, start);
  if (!entry) return { missing: [`its entry ${image.entry} is not in the image`], exempted: [] };
  const { metafile } = buildSync({
    entryPoints: [entry],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const seen = new Set([start]);
  const queue: [at: string, file: string][] = [[start, entry]];
  while (queue.length) {
    const [at, file] = queue.shift()!;
    for (const imp of metafile.inputs[file].imports) {
      if (imp.external) continue;
      const spec = imp.original ?? imp.path;
      const edge = `${file} -> ${spec}`;
      if (exemptions.includes(edge)) {
        exempted.add(edge);
        continue;
      }
      if (!spec.startsWith('.')) {
        missing.push(`${edge}: not a relative import, which the image cannot resolve`);
        continue;
      }
      const target = realPath(image, imageTarget(at, spec, posix.join(posix.dirname(file), spec), imp.path));
      const found = sourceAt(image, target);
      if (found !== imp.path) {
        missing.push(`${edge}: ${imp.path} is not at ${target}${found ? ` (${found} is)` : ''}`);
        continue;
      }
      if (!seen.has(target)) {
        seen.add(target);
        queue.push([target, found]);
      }
    }
  }
  return { missing, exempted: [...exempted] };
}

const images = Object.fromEntries(
  readdirSync(ROOT)
    .filter((f) => /^Dockerfile(\.[\w-]+)?$/.test(f))
    .sort()
    .map((f) => [f, parseDockerfile(readFileSync(join(ROOT, f), 'utf8'))] as const),
);
const checked = Object.keys(images).filter((f) => !images[f].wholeContext);

describe('backend images carry every module their entry loads', () => {
  it('each root Dockerfile copies the whole build context or runs a .ts entry', () => {
    expect(checked).toContain('Dockerfile.server');
    expect(checked.filter((f) => !images[f].entry)).toEqual([]);
  });

  it.each(checked)('%s', (name) => {
    const { missing, exempted } = missingModules(name, images[name]);
    expect(missing).toEqual([]);
    // An exemption whose import is gone goes too.
    expect((NOT_IN_IMAGE[name] ?? []).filter((e) => !exempted.includes(e))).toEqual([]);
  }, 30_000);
});
