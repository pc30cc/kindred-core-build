#!/usr/bin/env node
/**
 * Generates public/widget/smart-engine.js from the TypeScript source at
 * src/lib/widget/smartEngine.ts so the visitor-facing widget and the admin
 * Live Preview evaluate rules with the exact same code.
 *
 * Run:  node scripts/build-smart-engine.mjs
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(ROOT, 'src/lib/widget/smartEngine.ts')],
  outfile: resolve(ROOT, 'public/widget/smart-engine.js'),
  bundle: true,
  format: 'iife',
  globalName: '__gs_smart_engine_module',
  target: ['es2017'],
  legalComments: 'none',
  banner: {
    js: '/* GENERATED FILE - do not edit. Source: src/lib/widget/smartEngine.ts\n'
      + '   Regenerate with: node scripts/build-smart-engine.mjs */',
  },
  footer: {
    js: 'window.__gs_smart_engine = __gs_smart_engine_module.SmartEngine || __gs_smart_engine_module.default;',
  },
});

console.log('[smart-engine] wrote public/widget/smart-engine.js');