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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { resolveBuildBrand } from './build/brand.mjs';
import { isWidgetSource, transformWidgetAsset } from './build/widgetBrand.mjs';
import { rewriteWidgetFontUrls } from './build/widgetFonts.mjs';
import { precompressFiles } from './build/precompress.mjs';

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

// The build brand (scripts/build/brand.mjs): every widget JS/CSS file is
// minified without comments, and the RESPOK build leaves out the Iran
// region's local kit (scripts/build/widgetBrand.mjs). Hashes, the manifest
// and loaderVersion are all of the shipped bytes.
const BRAND = resolveBuildBrand(process.env);
const shipped = new Map();
function shippedBytes(file) {
  if (!shipped.has(file)) {
    const raw = readFileSync(join(SRC_DIR, file));
    let out = isWidgetSource(file) ? transformWidgetAsset(file, raw, BRAND) : raw;
    // A stylesheet's url(fonts/<name>.woff2) becomes the font's hashed name
    // BEFORE the stylesheet itself is hashed, so a font change is a new
    // stylesheet URL too.
    if (file.endsWith('.css')) out = rewriteWidgetFontUrls(out, hashedFont);
    shipped.set(file, typeof out === 'string' ? Buffer.from(out, 'utf8') : out);
  }
  return shipped.get(file);
}

// Widget fonts (public/widget/fonts/*.woff2): content-hashed into
// dist/widget/fonts/<name>.<hash>.woff2 when a stylesheet names them, served
// immutable with CORS like every hashed widget asset (nginx.conf.template).
// Manifest key `fonts/<name>.woff2`. A named font that does not exist fails
// the build.
const hashedFonts = new Map();
function hashedFont(name) {
  if (!hashedFonts.has(name)) {
    const src = join(SRC_DIR, 'fonts', name);
    if (!existsSync(src)) {
      console.error(`[widget-hash] FATAL: a stylesheet names fonts/${name}, which does not exist`);
      process.exit(1);
    }
    const buf = readFileSync(src);
    const rel = `fonts/${name.slice(0, -'.woff2'.length)}.${contentHash(buf)}.woff2`;
    mkdirSync(join(OUT_DIR, 'fonts'), { recursive: true });
    writeFileSync(join(OUT_DIR, rel), buf);
    hashedFonts.set(name, rel);
    console.log(`[widget-hash] fonts/${name} → ${rel} (${(buf.length / 1024).toFixed(1)} KB)`);
  }
  return hashedFonts.get(name);
}
console.log(`[widget-hash] build brand: ${BRAND}`);

// Fail loudly if the source dir is missing — otherwise the script would
// happily write an empty manifest and the bad image would only blow up
// at runtime when the loader tries to fetch a non-existent runtime hash.
if (!existsSync(SRC_DIR)) {
  console.error(`[widget-hash] FATAL: source directory not found: ${SRC_DIR}`);
  console.error(`[widget-hash] CWD=${process.cwd()}  __dirname=${__dirname}  ROOT=${ROOT}`);
  process.exit(1);
}

// Files that get content-hashed filenames
// `runtime-ext.js`: the renderer features, loaded only by a template that
// declares some; `runtime-late.js`: the late features, loaded after the
// first paint with the renderer's extras (docs/operations/WIDGET_TEMPLATE_RULES.md §2);
// `runtime-emoji.js`: the emoji search's keywords, loaded on its first use.
const CORE_HASHED_FILES = ['runtime.js', 'smart-engine.js', 'runtime.css', 'runtime-chat.js', 'runtime-kb.js', 'runtime-ext.js', 'runtime-late.js', 'runtime-emoji.js', 'runtime-call.js', 'runtime-rt-centrifugo.js', 'runtime-rt-supabase.js', 'runtime-rt-resolver.js'];

// Presentation layer (template system) — DISCOVERED, never hard-coded.
// Any `presentation-<id>.js` / `presentation-<id>.css` dropped into
// public/widget/ is picked up automatically, so adding a second template
// requires no build-script edit. The naming convention is the whitelist:
// only lowercase ids (a-z, 0-9, dashes) are accepted.
const PRESENTATION_RE = /^presentation-[a-z0-9-]+\.(js|css)$/;

function discoverPresentationFiles() {
  return readdirSync(SRC_DIR)
    .filter((f) => PRESENTATION_RE.test(f))
    .sort();
}

const PRESENTATION_FILES = discoverPresentationFiles();
if (!PRESENTATION_FILES.includes('presentation-registry.js')) {
  console.error('[widget-hash] FATAL: presentation-registry.js missing from public/widget/');
  process.exit(1);
}
// Every template must ship BOTH a renderer and a stylesheet. A renderer's
// extras (`presentation-<id>-x.js`, markup it draws after the first paint)
// have no stylesheet of their own (their rules are in the template's), but
// need their renderer.
for (const f of PRESENTATION_FILES) {
  if (f === 'presentation-registry.js' || !f.endsWith('.js')) continue;
  if (f.endsWith('-x.js')) {
    const renderer = f.replace(/-x\.js$/, '.js');
    if (!PRESENTATION_FILES.includes(renderer)) {
      console.error(`[widget-hash] FATAL: template extras ${f} have no renderer ${renderer}`);
      process.exit(1);
    }
    continue;
  }
  const css = f.replace(/\.js$/, '.css');
  if (!PRESENTATION_FILES.includes(css)) {
    console.error(`[widget-hash] FATAL: template renderer ${f} has no matching stylesheet ${css}`);
    process.exit(1);
  }
}
console.log(`[widget-hash] discovered presentation assets: ${PRESENTATION_FILES.join(', ')}`);

const HASHED_FILES = [...CORE_HASHED_FILES, ...PRESENTATION_FILES];


// Files copied as-is (stable entry points)
const STABLE_FILES = ['loader.js'];

// Vendor assets — third-party libraries we self-host. They get
// content-hashed filenames AND are copied into dist/widget/vendor/<hash>.js
// so nginx can serve them with `immutable, max-age=1y` cache headers like
// every other hashed runtime asset. Manifest keys are PREFIXED with
// `vendor/` so the backend can resolve them deterministically without
// colliding with runtime asset keys.
//
// STRICT: do NOT add CDN fallback logic anywhere in the build or the
// widget runtime. If a vendor file is missing here, the build must fail.
const VENDOR_FILES = [
  'vendor/livekit-client.umd.min.js',
];

function contentHash(buf) {
  return createHash('md5').update(buf).digest('hex').slice(0, 8);
}

function cleanOldHashed() {
  if (!existsSync(OUT_DIR)) return;
  for (const f of readdirSync(OUT_DIR)) {
    if (/^(runtime|presentation)[a-z0-9-]*\.[a-f0-9]{8}\.(js|css)(\.gz)?$/.test(f)) {
      unlinkSync(join(OUT_DIR, f));
    }
  }
  const fontDir = join(OUT_DIR, 'fonts');
  if (existsSync(fontDir)) {
    for (const f of readdirSync(fontDir)) {
      if (/\.[a-f0-9]{8}\.woff2$/.test(f)) unlinkSync(join(fontDir, f));
    }
  }
  // Also clean stale hashed vendor files so deploy converges.
  const vendorDir = join(OUT_DIR, 'vendor');
  if (existsSync(vendorDir)) {
    for (const f of readdirSync(vendorDir)) {
      if (/\.[a-f0-9]{8}\.(js|css)(\.gz)?$/.test(f)) {
        unlinkSync(join(vendorDir, f));
      }
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, 'vendor'), { recursive: true });
cleanOldHashed();

const manifest = {};
// Every content-hashed file written below, for the gzip copies at the end.
const hashedOutputs = [];

// Hash runtime files
for (const file of HASHED_FILES) {
  const src = join(SRC_DIR, file);
  if (!existsSync(src)) {
    console.warn(`[widget-hash] Skipping missing file: ${file}`);
    continue;
  }
  const buf = shippedBytes(file);
  const hash = contentHash(buf);
  const ext = file.split('.').pop();
  const base = file.replace(`.${ext}`, '');
  const hashedName = `${base}.${hash}.${ext}`;

  writeFileSync(join(OUT_DIR, hashedName), buf);
  hashedOutputs.push(join(OUT_DIR, hashedName));
  manifest[file] = hashedName;
  console.log(`[widget-hash] ${file} → ${hashedName}`);
}

for (const [name, rel] of hashedFonts) manifest[`fonts/${name}`] = rel;

// Hash vendor files. Manifest key is the logical name with `vendor/`
// prefix preserved, value is the hashed path also under `vendor/`.
for (const logical of VENDOR_FILES) {
  const src = join(SRC_DIR, logical);
  if (!existsSync(src)) {
    console.error(`[widget-hash] FATAL: required vendor file missing: ${logical}`);
    console.error('[widget-hash] Self-hosted vendor assets cannot be built without their source. ' +
      'See public/widget/vendor/ — every entry of VENDOR_FILES must exist on disk.');
    process.exit(1);
  }
  const buf = readFileSync(src);
  const hash = contentHash(buf);
  const baseName = logical.split('/').pop();
  const ext = baseName.split('.').pop();
  const stem = baseName.replace(`.${ext}`, '');
  const hashedRel = `vendor/${stem}.${hash}.${ext}`;
  writeFileSync(join(OUT_DIR, hashedRel), buf);
  hashedOutputs.push(join(OUT_DIR, hashedRel));
  manifest[logical] = hashedRel;
  console.log(`[widget-hash] ${logical} → ${hashedRel} (${(buf.length / 1024).toFixed(1)} KB)`);
}

// Copy stable files
for (const file of STABLE_FILES) {
  const src = join(SRC_DIR, file);
  if (!existsSync(src)) continue;
  writeFileSync(join(OUT_DIR, file), shippedBytes(file));
  manifest[file] = file;
  console.log(`[widget-hash] ${file} copied`);
}

// Loader version from its content hash
const loaderSrc = join(SRC_DIR, 'loader.js');
if (existsSync(loaderSrc)) {
  manifest['loaderVersion'] = contentHash(shippedBytes('loader.js'));
}

// `vite build` already copied public/widget/ into dist/widget/ as it is
// (comments, and for RESPOK the local kit, included). Every such top-level
// JS/CSS copy is served too (/widget/<name>), so it is replaced by the
// shipped bytes as well.
for (const file of readdirSync(SRC_DIR)) {
  if (!isWidgetSource(file) || !existsSync(join(OUT_DIR, file))) continue;
  writeFileSync(join(OUT_DIR, file), shippedBytes(file));
}

// Level-9 gzip copies of the hashed scripts and stylesheets for nginx's
// `gzip_static` (the hashed /widget/ location): made once here instead of
// gzipped again by nginx on every request that misses the CDN. woff2 is
// compressed already and is skipped (scripts/build/precompress.mjs).
{
  const { written, rawBytes, gzipBytes } = await precompressFiles(hashedOutputs);
  console.log(`[widget-hash] gzip_static: ${written} files, ${(rawBytes / 1024).toFixed(0)} KB → ${(gzipBytes / 1024).toFixed(0)} KB`);
}

const manifestPath = join(OUT_DIR, 'widget-manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[widget-hash] Manifest written to ${manifestPath}`);
console.log(JSON.stringify(manifest, null, 2));

// Build must fail loudly if the visitor call runtime was omitted from the
// widget output. The join flow now depends on an explicit manifest-backed URL,
// so silently succeeding here would regress back to runtime URL guessing.
for (const required of PRESENTATION_FILES) {
  if (!manifest[required] || !existsSync(join(OUT_DIR, manifest[required]))) {
    console.error(`[widget-hash] FATAL: presentation asset missing from build output: ${required}`);
    process.exit(1);
  }
}


if (!manifest['runtime-call.js']) {
  console.error('[widget-hash] FATAL: runtime-call.js missing from widget manifest');
  process.exit(1);
}
if (!existsSync(join(OUT_DIR, manifest['runtime-call.js']))) {
  console.error(`[widget-hash] FATAL: runtime-call.js missing from build output: ${join(OUT_DIR, manifest['runtime-call.js'])}`);
  process.exit(1);
}

// Self-hosted LiveKit SDK MUST be present. The visitor join path requires
// it; falling back to a CDN is forbidden by the architecture rules.
for (const logical of VENDOR_FILES) {
  const hashed = manifest[logical];
  if (!hashed) {
    console.error(`[widget-hash] FATAL: vendor asset missing from manifest: ${logical}`);
    process.exit(1);
  }
  if (!existsSync(join(OUT_DIR, hashed))) {
    console.error(`[widget-hash] FATAL: vendor asset missing from build output: ${join(OUT_DIR, hashed)}`);
    process.exit(1);
  }
}

// Final sanity check — refuse to "succeed" if the manifest didn't land
// where the Dockerfile expects it. This catches any future path/CWD
// regression at build time instead of at runtime in production.
if (!existsSync(manifestPath)) {
  console.error(`[widget-hash] FATAL: manifest write reported success but file is missing: ${manifestPath}`);
  process.exit(1);
}
