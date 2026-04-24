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
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// NOTE: Do NOT use `import.meta.dirname` — it was only added in Node 20.11.
// Some `node:20-alpine` images shipped with older 20.x patch versions
// where `import.meta.dirname` is `undefined`. With `undefined`,
// `resolve(undefined, '..')` silently returns `/`, which makes this
// script "succeed" while writing the manifest to the WRONG path
// (e.g. `/dist/widget/...` instead of `/app/dist/widget/...`). The
// Dockerfile assertion then fails with "widget-manifest.json missing
// from build output" even though the script printed no errors.
//
// `fileURLToPath(import.meta.url)` works on every Node ≥ 12 and is the
// canonical ESM equivalent of CommonJS `__dirname`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const SRC_DIR = join(ROOT, 'public', 'widget');
const OUT_DIR = join(ROOT, 'dist', 'widget');

// Fail loudly if the source dir is missing — otherwise the script would
// happily write an empty manifest and the bad image would only blow up
// at runtime when the loader tries to fetch a non-existent runtime hash.
if (!existsSync(SRC_DIR)) {
  console.error(`[widget-hash] FATAL: source directory not found: ${SRC_DIR}`);
  console.error(`[widget-hash] CWD=${process.cwd()}  __dirname=${__dirname}  ROOT=${ROOT}`);
  process.exit(1);
}

// Files that get content-hashed filenames
const HASHED_FILES = ['runtime.js', 'runtime.css', 'runtime-chat.js', 'runtime-kb.js', 'runtime-call.js', 'runtime-rt-centrifugo.js', 'runtime-rt-supabase.js', 'runtime-rt-resolver.js'];

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

// Build must fail loudly if the visitor call runtime was omitted from the
// widget output. The join flow now depends on an explicit manifest-backed URL,
// so silently succeeding here would regress back to runtime URL guessing.
if (!manifest['runtime-call.js']) {
  console.error('[widget-hash] FATAL: runtime-call.js missing from widget manifest');
  process.exit(1);
}
if (!existsSync(join(OUT_DIR, manifest['runtime-call.js']))) {
  console.error(`[widget-hash] FATAL: runtime-call.js missing from build output: ${join(OUT_DIR, manifest['runtime-call.js'])}`);
  process.exit(1);
}

// Final sanity check — refuse to "succeed" if the manifest didn't land
// where the Dockerfile expects it. This catches any future path/CWD
// regression at build time instead of at runtime in production.
if (!existsSync(manifestPath)) {
  console.error(`[widget-hash] FATAL: manifest write reported success but file is missing: ${manifestPath}`);
  process.exit(1);
}
