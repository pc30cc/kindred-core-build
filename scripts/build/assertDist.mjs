#!/usr/bin/env node
/**
 * Fails a frontend image build (Dockerfile.frontend) whose dist/ lacks the
 * downloads its brand serves (scripts/build/brand.mjs), or — in the RESPOK
 * build — still holds the Iran region's. The brand is derived exactly as the
 * build derived it (VITE_BRAND, else VITE_API_BASE_URL), so the Dockerfile
 * needs no brand variable of its own.
 *
 *   node scripts/build/assertDist.mjs [distDir]
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildBrand } from './brand.mjs';
import { EDITION_CODE, pluginEditionsFor } from './pluginEdition.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The download files one edition serves (relative to dist/). */
export function editionDownloads(edition) {
  const code = EDITION_CODE[edition];
  return [
    `downloads/${code}-woocommerce.zip`,
    `downloads/${code}-whmcs.zip`,
    `downloads/opencart/4.1/${code}.ocmod.zip`,
    `downloads/opencart/3.0/${code}-oc3.ocmod.zip`,
    `downloads/opencart/${edition === 'iran' ? 'manifest.json' : `${code}-manifest.json`}`,
    // The Android app of each brand (public/downloads, scripts/build-android*).
    `downloads/${edition === 'iran' ? ['Web', 'yar'].join('') : 'RESPOK'}-Android.apk`,
  ];
}

/** Problems with `distDir` for `brand`: missing files, and Iran files in a RESPOK build. */
export function checkDist(distDir, brand) {
  const problems = [];
  const editions = pluginEditionsFor(brand);
  for (const edition of editions) {
    for (const rel of editionDownloads(edition)) {
      if (!existsSync(join(distDir, rel))) problems.push(`missing ${rel}`);
    }
  }
  if (brand === 'respok') {
    for (const rel of editionDownloads('iran')) {
      if (existsSync(join(distDir, rel))) problems.push(`Iran file in the RESPOK build: ${rel}`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const brand = resolveBuildBrand(process.env);
  const distDir = resolve(process.argv[2] || join(ROOT, 'dist'));
  const problems = checkDist(distDir, brand);
  if (problems.length) {
    console.error(`❌ ${distDir} (build brand "${brand}"):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`✅ downloads for build brand "${brand}": ${pluginEditionsFor(brand).flatMap(editionDownloads).join(', ')}`);
}
