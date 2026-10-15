#!/usr/bin/env node
/**
 * Fails a RESPOK build whose browser files still carry the Iran region's
 * brand (scripts/build/brand.mjs). Run last in `npm run build`; a no-op for
 * the Iran build and for `both`.
 *
 * Checks every file under dist/ (gzip copies included, unpacked): its path
 * and its bytes, as UTF-8 and as \uXXXX escapes, for the brand's Latin name
 * in any case or spacing, its Persian name (with ZWNJ, a space or neither)
 * and its domains; and, by content hash, for every Iran-only image the repo
 * holds (public/brand/<iran>/ and the kit's src assets), whatever its name.
 *
 *   node scripts/build/brandAudit.mjs [distDir] [--force]
 *     exit 1 on a finding outside KNOWN_EXCEPTIONS (BRAND_AUDIT_STRICT=0: report only)
 *     --force: audit even when the build brand is not respok
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { gunzipSync } from 'zlib';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { IRAN_BRAND_PATTERNS, resolveBuildBrand } from './brand.mjs';

export { IRAN_BRAND_PATTERNS };

/**
 * Files the audit knows about and lets through, each with its reason. Only a
 * binary built outside this web build belongs here; remove an entry as soon
 * as its source is clean.
 */
export const KNOWN_EXCEPTIONS = new Map([
  [
    'downloads/RESPOK-Android.apk',
    'built from android/ (native Kotlin app, its own CI and signing): its namespace and theme still carry the Iran name; '
      + 'needs a rename there and a new signed release',
  ],
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Hashes of the Iran-only images in the repo: a renamed copy is still found. */
export function iranAssetHashes(root = ROOT) {
  const hashes = new Map();
  const dirs = [join(root, 'public', 'brand', ['web', 'yar'].join(''))];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      hashes.set(createHash('sha256').update(readFileSync(file)).digest('hex'), relative(root, file));
    }
  }
  const assets = join(root, 'src', 'assets');
  if (existsSync(assets)) {
    for (const file of walk(assets)) {
      if (IRAN_BRAND_PATTERNS.some((re) => re.test(relative(assets, file)))) {
        hashes.set(createHash('sha256').update(readFileSync(file)).digest('hex'), relative(root, file));
      }
    }
  }
  return hashes;
}

/** Every finding in `distDir`: `path: reason`. */
export function auditDist(distDir, root = ROOT) {
  const findings = [];
  const known = iranAssetHashes(root);
  for (const file of walk(distDir)) {
    const rel = relative(distDir, file);
    if (IRAN_BRAND_PATTERNS.some((re) => re.test(rel))) findings.push(`${rel}: file name`);
    let bytes = readFileSync(file);
    if (file.endsWith('.gz')) {
      try { bytes = gunzipSync(bytes); } catch { /* not gzip: checked as is */ }
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (known.has(hash)) findings.push(`${rel}: same bytes as ${known.get(hash)}`);
    const text = bytes.toString('utf8');
    for (const re of IRAN_BRAND_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        const at = Math.max(0, m.index - 40);
        findings.push(`${rel}: ${JSON.stringify(text.slice(at, m.index + m[0].length + 40))}`);
        break;
      }
    }
  }
  return findings;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const brand = resolveBuildBrand(process.env);
  const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const distDir = resolve(distArg || join(ROOT, 'dist'));
  if (brand !== 'respok' && !process.argv.includes('--force')) {
    console.log(`[brand-audit] build brand "${brand}": nothing to check`);
    process.exit(0);
  }
  const all = auditDist(distDir);
  const excepted = all.filter((f) => KNOWN_EXCEPTIONS.has(f.slice(0, f.indexOf(':'))));
  const findings = all.filter((f) => !excepted.includes(f));
  for (const f of excepted) {
    const file = f.slice(0, f.indexOf(':'));
    console.warn(`[brand-audit] known exception ${file}: ${KNOWN_EXCEPTIONS.get(file)}`);
  }
  // Fails the build; BRAND_AUDIT_STRICT=0 only reports (a local look at a dist).
  const strict = process.env.BRAND_AUDIT_STRICT !== '0';
  if (findings.length) {
    console.error(`[brand-audit] ${strict ? 'FAIL' : 'WARN'}: ${findings.length} finding(s) in ${distDir} carry the Iran brand:`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(strict ? 1 : 0);
  }
  console.log(`[brand-audit] ${distDir}: no Iran brand in any file`);
}
