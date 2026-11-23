#!/usr/bin/env node
/**
 * Generates public/widget/smart-engine.js from the TypeScript source at
 * src/lib/widget/smartEngine.ts so the visitor-facing widget and the admin
 * Live Preview evaluate rules with the exact same code.
 *
 * Smart Engagement's visitor side, src/lib/widget/smartClient.js (ES5, as
 * the loader it came from), is appended after the engine as it is: it
 * arrives with the engine, in the same request, and only on a site whose
 * workspace has active rules (public/widget/loader.js, startSmart).
 *
 * Run:  node scripts/build-smart-engine.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = readFileSync(resolve(ROOT, 'src/lib/widget/smartClient.js'), 'utf8').trimEnd();

await build({
  entryPoints: [resolve(ROOT, 'src/lib/widget/smartEngine.ts')],
  outfile: resolve(ROOT, 'public/widget/smart-engine.js'),
  bundle: true,
  format: 'iife',
  globalName: '__gs_smart_engine_module',
  target: ['es2017'],
  legalComments: 'none',
  banner: {
    js: '/* GENERATED FILE - do not edit. Sources: src/lib/widget/smartEngine.ts (the engine),\n'
      + '   src/lib/widget/smartClient.js (the visitor side, appended as it is).\n'
      + '   Regenerate with: node scripts/build-smart-engine.mjs */',
  },
  footer: {
    js: 'window.__gs_smart_engine = __gs_smart_engine_module.SmartEngine || __gs_smart_engine_module.default;\n'
      + CLIENT,
  },
});

console.log('[smart-engine] wrote public/widget/smart-engine.js');