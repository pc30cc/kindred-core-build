// @vitest-environment node
/**
 * The cluster primary never loads the app: importing index.ts would open a
 * database pool, start the import-time timers and patch Express, making the
 * primary one more app process (docs/operations/BACKEND_PROCESSES.md). Its
 * import graph is the cluster modules, the pure stores the hub holds, node
 * built-ins and express-rate-limit, and nothing else.
 */
import { builtinModules } from 'node:module';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ALLOWED_FILES = [
  /^server\/cluster\/[^/]+\.ts$/,
  /^server\/db\/mode\.ts$/,
  /^server\/services\/privacy\/reauth\.ts$/,
  /^server\/services\/privacy\/jobRateLimit\.ts$/,
  /^server\/middleware\/loginAttempts\.ts$/,
  /^server\/services\/desktopApp\/live\.ts$/,
  /^server\/services\/calls\/callRequestLimiter\.ts$/,
  /^server\/services\/calls\/calleeRingLimit\.ts$/,
  /^server\/services\/widget\/operatorActivityIndex\.ts$/,
];
const FORBIDDEN_FILES = [
  'server/index.ts',
  'server/config.ts',
  'server/supabase.ts',
  'server/db/pool.ts',
  'server/db/index.ts',
  'server/lib/asyncErrors.ts',
  'server/lib/cacheBus.ts',
];
const ALLOWED_PACKAGES = ['express-rate-limit'];

describe('the cluster primary', () => {
  const { metafile } = buildSync({
    entryPoints: ['server/cluster/primary.ts'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const files = Object.keys(metafile.inputs);
  const externals = new Set(
    Object.values(metafile.inputs).flatMap((input) => input.imports.filter((i) => i.external).map((i) => i.path)),
  );

  it('imports only the cluster modules and the pure stores', () => {
    expect(files.filter((f) => !ALLOWED_FILES.some((re) => re.test(f)))).toEqual([]);
    for (const f of FORBIDDEN_FILES) expect(files).not.toContain(f);
    expect(files).toContain('server/cluster/hub.ts');
  });

  it('loads no package but express-rate-limit: no pg, no express', () => {
    const packages = [...externals].filter((p) => !p.startsWith('node:') && !builtinModules.includes(p));
    expect(packages.filter((p) => !ALLOWED_PACKAGES.includes(p))).toEqual([]);
  });
});
