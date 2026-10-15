#!/usr/bin/env node
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveBuildBrand } from './build/brand.mjs';
import { isWidgetSource, transformWidgetAsset } from './build/widgetBrand.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'public', 'call-widget');
const output = join(root, 'dist', 'call-widget');
const presentationPattern = /^presentation-[a-z0-9-]+\.(js|css)$/;
const presentations = readdirSync(source).filter((name) => presentationPattern.test(name)).sort();

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
const shippedBytes = (name) => {
  const raw = readFileSync(join(source, name));
  return isWidgetSource(name) ? Buffer.from(transformWidgetAsset(name, raw, brand), 'utf8') : raw;
};

mkdirSync(output, { recursive: true });
const manifest = {};
for (const name of ['runtime.js', 'runtime.css', ...presentations]) {
  const bytes = shippedBytes(name);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dot = name.lastIndexOf('.');
  const hashed = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
  writeFileSync(join(output, hashed), bytes);
  manifest[name] = hashed;
}
for (const stable of ['l.js']) {
  if (existsSync(join(source, stable))) writeFileSync(join(output, stable), shippedBytes(stable));
}
// `vite build` already copied public/call-widget/ into dist/call-widget/ as
// it is; those top-level JS/CSS copies are served too, so they get the
// shipped bytes as well.
for (const name of readdirSync(source)) {
  if (isWidgetSource(name) && existsSync(join(output, name))) writeFileSync(join(output, name), shippedBytes(name));
}
writeFileSync(join(output, 'call-widget-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`[call-widget-hash] ${Object.keys(manifest).length} assets; ${presentations.length} presentation files; build brand ${brand}`);
