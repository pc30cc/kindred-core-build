// @vitest-environment node
/**
 * The image's entry is server/start.ts. With BACKEND_PROCESSES unset its
 * only work is `import('./index.js')`, so the backend starts exactly as when
 * the CMD ran index.ts; every import in it is a literal, so the image module
 * check (src/test/ci/dockerfileModuleClosure.test.ts) follows index.ts from
 * it and its exemptions are still reached.
 */
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const start = readFileSync('server/start.ts', 'utf8');
const code = start.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('server/start.ts', () => {
  it('Dockerfile.server runs it', () => {
    expect(readFileSync('Dockerfile.server', 'utf8')).toMatch(/^CMD \["npx", "tsx", "start\.ts"\]$/m);
  });

  it('without BACKEND_PROCESSES (and no cluster role) it only loads index.ts', () => {
    const fast = code.match(/if \(!process\.env\.BACKEND_PROCESSES\?\.trim\(\) && !process\.env\.BACKEND_CLUSTER_ROLE\) \{([\s\S]*?)\} else \{/);
    expect(fast).not.toBeNull();
    expect(fast![1].trim()).toBe("await import('./index.js');");
    // Nothing runs before that branch.
    expect(code.trim().startsWith('if (!process.env.BACKEND_PROCESSES')).toBe(true);
  });

  it('every import is a literal', () => {
    const imports = [...code.matchAll(/import\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^'[^'`$]+'$/);
    expect(code).not.toMatch(/^\s*import\s/m);
  });

  it("reaches index.ts and the cluster modules through esbuild's import graph", () => {
    const { metafile } = buildSync({
      entryPoints: ['server/start.ts'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    const direct = metafile.inputs['server/start.ts'].imports.map((i) => i.path);
    expect(direct).toEqual(
      expect.arrayContaining(['server/index.ts', 'server/cluster/worker.ts', 'server/cluster/plan.ts', 'server/cluster/primary.ts']),
    );
  });
});
