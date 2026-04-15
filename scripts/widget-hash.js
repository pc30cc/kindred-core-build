#!/usr/bin/env node
/**
 * Widget Asset Hasher
 * 
 * Copies public/widget/runtime.js and runtime.css into dist/widget/
 * with content-hash filenames (e.g. runtime.a1b2c3d4.js).
 * Emits dist/widget/widget-manifest.json mapping logical names to hashed filenames.
 * 
 * Run after `vite build`:
 *   node scripts/widget-hash.js
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_DIR = join(ROOT, 'public', 'widget');
const OUT_DIR = join(ROOT, 'dist', 'widget');

const FILES = ['runtime.js', 'runtime.css'];

function contentHash(buf) {
  return createHash('md5').update(buf).digest('hex').slice(0, 8);
}

// Clean old hashed runtime files
function cleanOldHashed() {
  if (!existsSync(OUT_DIR)) return;
  for (const f of readdirSync(OUT_DIR)) {
    if (/^runtime\.[a-f0-9]{8}\.(js|css)$/.test(f)) {
      unlinkSync(join(OUT_DIR, f));
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
cleanOldHashed();

const manifest = {};

for (const file of FILES) {
  const src = join(SRC_DIR, file);
  if (!existsSync(src)) {
    console.warn(`[widget-hash] Skipping missing file: ${file}`);
    continue;
  }
  const buf = readFileSync(src);
  const hash = contentHash(buf);
  const ext = file.split('.').pop();
  const base = file.replace(`.${ext}`, '');
  const hashedName = `${base}.${hash}.${ext}`;
  
  writeFileSync(join(OUT_DIR, hashedName), buf);
  manifest[file] = hashedName;
  console.log(`[widget-hash] ${file} → ${hashedName}`);
}

// Also copy loader.js (unhashed, stable entry point)
const loaderSrc = join(SRC_DIR, 'loader.js');
if (existsSync(loaderSrc)) {
  copyFileSync(loaderSrc, join(OUT_DIR, 'loader.js'));
  // Generate a version string from loader content hash for embed code
  const loaderBuf = readFileSync(loaderSrc);
  manifest['loader.js'] = 'loader.js';
  manifest['loaderVersion'] = contentHash(loaderBuf);
  console.log(`[widget-hash] loader.js copied (version: ${manifest['loaderVersion']})`);
}

const manifestPath = join(OUT_DIR, 'widget-manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[widget-hash] Manifest written to ${manifestPath}`);
console.log(JSON.stringify(manifest, null, 2));
