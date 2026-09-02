#!/usr/bin/env node
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

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

mkdirSync(output, { recursive: true });
const manifest = {};
for (const name of ['runtime.js', 'runtime.css', ...presentations]) {
  const bytes = readFileSync(join(source, name));
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dot = name.lastIndexOf('.');
  const hashed = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
  writeFileSync(join(output, hashed), bytes);
  manifest[name] = hashed;
}
for (const stable of ['l.js']) {
  if (existsSync(join(source, stable))) copyFileSync(join(source, stable), join(output, stable));
}
writeFileSync(join(output, 'call-widget-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`[call-widget-hash] ${Object.keys(manifest).length} assets; ${presentations.length} presentation files`);
