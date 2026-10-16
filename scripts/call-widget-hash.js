#!/usr/bin/env node
/**
 * Ships the call widget (dist/call-widget/): every JS/CSS file minified and
 * content-addressed (`<name>.<sha256/12>.<ext>`, served immutable by
 * nginx.conf.template), and those names written INTO the loader l.js.
 *
 * l.js is the one file a customer's snippet names, so it keeps its fixed path
 * and is served `no-cache` (a bodiless 304 while unchanged). Because the
 * names it carries are the files of this very build, in this very image, a
 * loader can never point at another deploy's bytes — the frontend (app 24)
 * and the API (app 25) deploy separately, and nothing here depends on the
 * API. The fixed names stay too, as the same bytes: old loaders, the
 * operator preview (SettingsPage) and the loader's own fallback use them.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveBuildBrand } from './build/brand.mjs';
import { isWidgetSource, transformWidgetAsset } from './build/widgetBrand.mjs';
import { precompressFiles } from './build/precompress.mjs';

// CALL_WIDGET_BUILD_ROOT: another tree with the same layout (public/, dist/),
// for the script's own test (src/test/widget/callWidgetBuild.test.ts).
const root = process.env.CALL_WIDGET_BUILD_ROOT
  ? resolve(process.env.CALL_WIDGET_BUILD_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'public', 'call-widget');
const output = join(root, 'dist', 'call-widget');
const widgetManifestPath = join(root, 'dist', 'widget', 'widget-manifest.json');
const presentationPattern = /^presentation-[a-z0-9-]+\.(js|css)$/;
const presentations = readdirSync(source).filter((name) => presentationPattern.test(name)).sort();
/**
 * From the chat widget's manifest (scripts/widget-hash.js, same image): the
 * shared @font-face stylesheet (the bootstrap's `font_style_url`) and the
 * LiveKit SDK. The chat widget hashes the very same SDK file, so the call
 * widget uses that copy: one download and one cache entry for both widgets.
 */
const FONTS_KEY = 'presentation-default-fonts.css';
const LIVEKIT_KEY = 'vendor/livekit-client.umd.min.js';

if (!presentations.includes('presentation-registry.js')) {
  throw new Error('Call Widget presentation registry is missing');
}
for (const script of presentations.filter((name) => name !== 'presentation-registry.js' && name.endsWith('.js'))) {
  if (!presentations.includes(script.replace(/\.js$/, '.css'))) {
    throw new Error(`Call Widget presentation has no stylesheet: ${script}`);
  }
}

// Minified without comments; the RESPOK build also leaves out the Iran
// region's local kit (scripts/build/widgetBrand.mjs, scripts/build/brand.mjs).
const brand = resolveBuildBrand(process.env);
const shippedBytes = (name, options) => {
  const raw = readFileSync(join(source, name));
  return isWidgetSource(name) ? Buffer.from(transformWidgetAsset(name, raw, brand, options), 'utf8') : raw;
};
const hashedName = (name, bytes) => {
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)}.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}${name.slice(dot)}`;
};

mkdirSync(output, { recursive: true });
const files = {};
const hashedPaths = [];
for (const name of ['runtime.js', 'runtime.css', ...presentations]) {
  const bytes = shippedBytes(name);
  files[name] = hashedName(name, bytes);
  writeFileSync(join(output, files[name]), bytes);
  writeFileSync(join(output, name), bytes); // the fixed name, same bytes
  hashedPaths.push(join(output, files[name]));
}
// The shared font stylesheet and the media SDK, content-addressed by the
// chat widget's build in this same image (null: the loader falls back to the
// bootstrap's font_style_url and the fixed /call-widget/vendor/ SDK).
let fonts = null;
let livekit = null;
if (existsSync(widgetManifestPath)) {
  const widgetManifest = JSON.parse(readFileSync(widgetManifestPath, 'utf8'));
  const fontsName = widgetManifest[FONTS_KEY];
  if (typeof fontsName === 'string' && /^[a-z0-9.-]+$/i.test(fontsName)) fonts = `/widget/${fontsName}`;
  const livekitName = widgetManifest[LIVEKIT_KEY];
  if (typeof livekitName === 'string' && /^vendor\/[a-z0-9.-]+\.js$/i.test(livekitName) && livekitName !== LIVEKIT_KEY) {
    livekit = `/widget/${livekitName}`;
  }
}

const build = { files, livekit, fonts };
const loader = shippedBytes('l.js', { define: { __CALL_WIDGET_BUILD__: JSON.stringify(JSON.stringify(build)) } });
if (loader.includes('__CALL_WIDGET_BUILD__')) throw new Error('call widget: l.js does not carry the build names');
for (const hashed of Object.values(files)) {
  if (!loader.includes(hashed)) throw new Error(`call widget: l.js lacks ${hashed}`);
}
writeFileSync(join(output, 'l.js'), loader);
await precompressFiles(hashedPaths);

// `vite build` already copied public/call-widget/ into dist/call-widget/ as
// it is; those top-level JS/CSS copies are served too, so they get the
// shipped bytes as well (l.js and the fixed names were written above).
for (const name of readdirSync(source)) {
  if (name === 'l.js' || files[name]) continue;
  if (isWidgetSource(name) && existsSync(join(output, name))) writeFileSync(join(output, name), shippedBytes(name));
}
writeFileSync(join(output, 'call-widget-manifest.json'), JSON.stringify(build, null, 2));
console.log(`[call-widget-hash] ${Object.keys(files).length} assets; fonts ${fonts ?? 'from the bootstrap'}; LiveKit ${livekit ?? 'by its fixed name'}; build brand ${brand}`);
