#!/usr/bin/env node
/**
 * Widget Asset Hasher
 *
 * Copies widget assets into dist/widget/ with content-hash filenames.
 * Emits dist/widget/widget-manifest.json.
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

// Files that get content-hashed filenames
const HASHED_FILES = ['runtime.js', 'runtime.css', 'runtime-chat.js', 'runtime-kb.js', 'runtime-rt-centrifugo.js', 'runtime-rt-supabase.js', 'runtime-rt-resolver.js'];

// Files copied as-is (stable entry points)
const STABLE_FILES = ['loader.js'];

function contentHash(buf) {
  return createHash('md5').update(buf).digest('hex').slice(0, 8);
}

function cleanOldHashed() {
  if (!existsSync(OUT_DIR)) return;
  for (const f of readdirSync(OUT_DIR)) {
    if (/^runtime[a-z0-9-]*\.[a-f0-9]{8}\.(js|css)$/.test(f)) {
      unlinkSync(join(OUT_DIR, f));
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
cleanOldHashed();

const manifest = {};

// Hash runtime files
for (const file of HASHED_FILES) {
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

// Copy stable files
for (const file of STABLE_FILES) {
  const src = join(SRC_DIR, file);
  if (!existsSync(src)) continue;
  copyFileSync(src, join(OUT_DIR, file));
  const buf = readFileSync(src);
  manifest[file] = file;
  console.log(`[widget-hash] ${file} copied`);
}

// Loader version from its content hash
const loaderSrc = join(SRC_DIR, 'loader.js');
if (existsSync(loaderSrc)) {
  manifest['loaderVersion'] = contentHash(readFileSync(loaderSrc));
}

const manifestPath = join(OUT_DIR, 'widget-manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[widget-hash] Manifest written to ${manifestPath}`);
console.log(JSON.stringify(manifest, null, 2));
