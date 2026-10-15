#!/usr/bin/env node
/**
 * Builds the installable OpenCart packages of the Web Yar extension from
 * plugins/webyar-opencart/:
 *
 *   public/downloads/opencart/4.1/webyar.ocmod.zip      OpenCart 4.1.x
 *   public/downloads/opencart/3.0/webyar-oc3.ocmod.zip  OpenCart 3.0.5.x
 *   public/downloads/opencart/manifest.json             versions + sha256
 *
 * The 4.1 archive MUST be named `webyar.ocmod.zip`: OpenCart 4's installer
 * takes the extension code — and with it the PHP namespace
 * Opencart\…\Extension\Webyar — from the file name.
 *
 * One version-agnostic core (plugins/webyar-opencart/core) is copied into
 * both; only the thin wrappers differ. Language files for both versions are
 * generated from plugins/webyar-opencart/i18n/*.json, the single source of
 * the en / fa / tr strings.
 *
 * Deterministic: sorted entries, fixed timestamps, no extra attributes — the
 * same source always yields the same bytes, so the manifest checksum only
 * changes when the extension does.
 *
 * Releases are signed: public/downloads/opencart/manifest.json.sig is an
 * Ed25519 signature (base64) of manifest.json, made on the release host with
 * a key that never enters the repository. Connected stores install a new
 * version by themselves only when that signature verifies against the public
 * key built into the extension (core/Protocol.php UPDATE_PUBLIC_KEY). Once a
 * version is signed, its packages are frozen: a rebuild keeps the committed,
 * signed archives (and says so if the source differs — bump the version and
 * sign again). A new, unsigned version builds normally; stores simply do not
 * pick it up until it is signed.
 *
 * Two editions from the same source (scripts/build/pluginEdition.mjs), as
 * the client build's brand asks (scripts/build/brand.mjs):
 *   iran   → opencart/4.1/webyar.ocmod.zip, opencart/3.0/webyar-oc3.ocmod.zip,
 *            opencart/manifest.json                      (as always)
 *   respok → opencart/4.1/respok.ocmod.zip, opencart/3.0/respok-oc3.ocmod.zip,
 *            opencart/respok-manifest.json (extension code respok, namespace
 *            Opencart\…\Extension\Respok, X-Platform-* headers, RESPOK texts)
 *   both   → both.
 * OpenCart rules both keep: 4.1 takes the extension code (folder
 * extension/<code>/, namespace …\Extension\<Code>, route
 * extension/<code>/module/<code>) from the uploaded file's name, so the 4.1
 * archive is exactly <code>.ocmod.zip; 3.0 installs the upload/ tree, routes
 * extension/module/<code>.
 *
 * Env: WEBYAR_BRAND_NAME overrides the brand shown in the OpenCart admin
 * (Iran edition only).
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildBrand } from './build/brand.mjs';
import { EDITION_CODE, pluginEditionsFor, respokText, transformTreeToRespok } from './build/pluginEdition.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'plugins', 'webyar-opencart');
const OUT_DIR = join(root, 'public', 'downloads', 'opencart');

const protocolSource = readFileSync(join(src, 'core', 'Protocol.php'), 'utf8');
const version = protocolSource.match(/CONNECTOR_VERSION = '([^']+)'/)?.[1];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('CONNECTOR_VERSION not found in core/Protocol.php');
const updatePublicKey = protocolSource.match(/UPDATE_PUBLIC_KEY = '([^']+)'/)?.[1];
if (!updatePublicKey) throw new Error('UPDATE_PUBLIC_KEY not found in core/Protocol.php');

// The Iran edition's names; the respok edition rewrites the staged result.
const IRAN_BRAND = {
  en: process.env.WEBYAR_BRAND_NAME || 'Web Yar',
  fa: process.env.WEBYAR_BRAND_NAME || 'وب‌یار',
  tr: process.env.WEBYAR_BRAND_NAME || 'Web Yar',
};
const DEFAULT_BRAND = { en: 'Web Yar', fa: 'وب‌یار', tr: 'Web Yar' };
let BRAND = IRAN_BRAND;
// Directory names OpenCart language packs commonly use for each locale.
const LANGUAGE_DIRS = { en: ['en-gb'], fa: ['fa-ir', 'fa'], tr: ['tr-tr', 'tr'] };
// Every file carries one date, fixed per VERSION (reproducible builds) but
// different for every version: PHP's opcache and OpenCart's Twig cache
// decide "changed?" by file date, and a merchant's unzip / FTP keeps it, so
// two versions with the same date would keep running the old compiled code.
// 1.1.1 → 2026-01-01 + 10101 minutes; grows with the version.
const FIXED_TIME = (() => {
  const [major, minor, patch] = version.split('.').map(Number);
  if (minor > 99 || patch > 99) throw new Error('version parts above 99 need a new FIXED_TIME scheme');
  return new Date(Date.UTC(2026, 0, 1) + (major * 10000 + minor * 100 + patch) * 60_000);
})();

function phpString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function localizedStrings(locale, supported) {
  const strings = JSON.parse(readFileSync(join(src, 'i18n', `${locale}.json`), 'utf8'));
  return Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, value.replaceAll('{brand}', BRAND[locale]).replaceAll('{supported}', supported)]));
}

function languageFile(locale, supported) {
  const lines = ['<?php', '// Generated by scripts/build-opencart-plugin-zip.mjs from plugins/webyar-opencart/i18n — edit there.'];
  for (const [key, text] of Object.entries(localizedStrings(locale, supported))) {
    lines.push(`$_[${phpString(key)}] = ${phpString(text)};`);
  }
  return `${lines.join('\n')}\n`;
}

function copyCore(target, platformFile, supported) {
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(join(src, 'core'))) {
    if (file.endsWith('.php')) cpSync(join(src, 'core', file), join(target, file));
  }
  cpSync(platformFile, join(target, platformFile.split('/').pop()));
  writeFileSync(join(target, 'index.html'), '');
  // The extension's own pages (settings, connection result) read these.
  mkdirSync(join(target, 'i18n'), { recursive: true });
  for (const locale of Object.keys(LANGUAGE_DIRS)) {
    writeFileSync(join(target, 'i18n', `${locale}.json`), `${JSON.stringify(localizedStrings(locale, supported), null, 2)}\n`);
  }
  writeFileSync(join(target, 'i18n', 'index.html'), '');
}

function copyAdminView(file) {
  mkdirSync(dirname(file), { recursive: true });
  cpSync(join(src, 'views', 'admin.twig'), file);
}

function writeLanguages(base, relPath, supported) {
  for (const [locale, dirs] of Object.entries(LANGUAGE_DIRS)) {
    for (const dir of dirs) {
      const file = join(base, dir, relPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, languageFile(locale, supported));
    }
  }
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function zipDir(dir, outFile) {
  const files = listFiles(dir).map((f) => relative(dir, f));
  for (const f of files) utimesSync(join(dir, f), FIXED_TIME, FIXED_TIME);
  mkdirSync(dirname(outFile), { recursive: true });
  rmSync(outFile, { force: true });
  execFileSync('zip', ['-X', '-q', '-D', outFile, ...files], { cwd: dir });
  return createHash('sha256').update(readFileSync(outFile)).digest('hex');
}

function buildOc4(work, outFile, edition) {
  const dir = join(work, 'oc4');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'install.json'), `${JSON.stringify({
    name: `${BRAND.en} — AI chat and store assistant`,
    description: `Connects this OpenCart 4.1 store to ${BRAND.en}: shows the chat widget and lets the assistant answer from live products and the signed-in customer's own orders.`,
    version,
    author: BRAND.en,
    link: '',
  }, null, 2)}\n`);
  cpSync(join(src, 'oc4', 'admin'), join(dir, 'admin'), { recursive: true });
  cpSync(join(src, 'oc4', 'catalog'), join(dir, 'catalog'), { recursive: true });
  copyAdminView(join(dir, 'admin', 'view', 'template', 'module', 'webyar.twig'));
  copyCore(join(dir, 'system', 'library', 'webyar'), join(src, 'oc4', 'Oc4Platform.php'), '4.1.x');
  writeLanguages(join(dir, 'admin', 'language'), join('module', 'webyar.php'), '4.1.x');
  writeLanguages(join(dir, 'catalog', 'language'), join('module', 'webyar.php'), '4.1.x');
  if (edition === 'respok') transformTreeToRespok(dir);
  return zipDir(dir, outFile);
}

function buildOc3(work, outFile, edition) {
  const dir = join(work, 'oc3');
  const upload = join(dir, 'upload');
  mkdirSync(upload, { recursive: true });
  cpSync(join(src, 'oc3', 'admin'), join(upload, 'admin'), { recursive: true });
  cpSync(join(src, 'oc3', 'catalog'), join(upload, 'catalog'), { recursive: true });
  copyAdminView(join(upload, 'admin', 'view', 'template', 'extension', 'module', 'webyar.twig'));
  copyCore(join(upload, 'system', 'library', 'webyar'), join(src, 'oc3', 'Oc3Platform.php'), '3.0.5.x');
  writeLanguages(join(upload, 'admin', 'language'), join('extension', 'module', 'webyar.php'), '3.0.5.x');
  writeLanguages(join(upload, 'catalog', 'language'), join('extension', 'module', 'webyar.php'), '3.0.5.x');
  if (edition === 'respok') transformTreeToRespok(dir);
  return zipDir(dir, outFile);
}

/** Package files of an edition: the 4.1 archive MUST be <extension code>.ocmod.zip. */
export function openCartTargets(edition) {
  const code = EDITION_CODE[edition];
  return {
    oc4: join('4.1', `${code}.ocmod.zip`),
    oc3: join('3.0', `${code}-oc3.ocmod.zip`),
    // The update feed each edition's Updater reads (core/Updater.php MANIFEST_PATH).
    manifest: edition === 'iran' ? 'manifest.json' : `${code}-manifest.json`,
  };
}

function sha256File(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

/** The committed manifest when its signature verifies, else null. */
function signedManifest(outDir, manifestName) {
  const manifestFile = join(outDir, manifestName);
  const sigFile = join(outDir, `${manifestName}.sig`);
  if (!existsSync(manifestFile) || !existsSync(sigFile)) return null;
  const body = readFileSync(manifestFile);
  return verifyManifest(body, readFileSync(sigFile, 'utf8').trim()) ? JSON.parse(body.toString('utf8')) : null;
}

function verifyManifest(body, signatureB64) {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(updatePublicKey, 'base64')]), format: 'der', type: 'spki' });
  try {
    return verify(null, body, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Builds one edition into `outDir` (the opencart/ downloads folder); returns
 * what it wrote or kept. Exported for the tests, which build into a temp dir.
 */
export function packageOpenCart({ edition = 'iran', outDir = OUT_DIR, log = console } = {}) {
  BRAND = edition === 'iran' ? IRAN_BRAND : DEFAULT_BRAND;
  const code = EDITION_CODE[edition];
  const TARGETS = openCartTargets(edition);
  const protocol = edition === 'iran' ? protocolSource.match(/PROTOCOL_VERSION = '([^']+)'/)?.[1] : respokText(protocolSource).match(/PROTOCOL_VERSION = '([^']+)'/)?.[1];
  if (!protocol) throw new Error('PROTOCOL_VERSION not found in core/Protocol.php');
  const work = mkdtempSync(join(tmpdir(), 'webyar-opencart-'));
  try {
    const built = join(work, 'out');
    const fresh = { oc4: buildOc4(work, join(built, TARGETS.oc4), edition), oc3: buildOc3(work, join(built, TARGETS.oc3), edition) };
    const signed = signedManifest(outDir, TARGETS.manifest);
    const signedSha = (line) => signed?.packages?.find((p) => p.opencart === line)?.sha256;
    const frozen = signed?.version === version
      && sha256File(join(outDir, TARGETS.oc4)) === signedSha('4.1.x')
      && sha256File(join(outDir, TARGETS.oc3)) === signedSha('3.0.5.x')
      && !process.env.WEBYAR_OPENCART_REBUILD;

    if (frozen) {
      // The signed release is what stores verify and install: keep it byte for byte.
      if (fresh.oc4 !== signedSha('4.1.x') || fresh.oc3 !== signedSha('3.0.5.x')) {
        log.warn(`[opencart] ${code} ${version} is signed and frozen; the source now builds different packages — bump CONNECTOR_VERSION and sign the new manifest to release them.`);
      }
      log.log(`[opencart] kept signed ${code} ${version}: 4.1 ${signedSha('4.1.x').slice(0, 12)}…, 3.0 ${signedSha('3.0.5.x').slice(0, 12)}…`);
    } else {
      for (const target of [TARGETS.oc4, TARGETS.oc3]) {
        mkdirSync(dirname(join(outDir, target)), { recursive: true });
        cpSync(join(built, target), join(outDir, target));
      }
      const file4 = TARGETS.oc4.split('/').pop();
      const file3 = TARGETS.oc3.split('/').pop();
      const manifest = {
        slug: `${code}-opencart`,
        version,
        protocol,
        packages: [
          { opencart: '4.1.x', tested: ['4.1.0.0', '4.1.0.4'], php: '>=8.1', path: `/downloads/opencart/4.1/${file4}`, file: file4, sha256: fresh.oc4 },
          { opencart: '3.0.5.x', tested: ['3.0.5.1'], php: '>=8.1', path: `/downloads/opencart/3.0/${file3}`, file: file3, sha256: fresh.oc3 },
        ],
      };
      const body = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(join(outDir, TARGETS.manifest), body);
      const sigFile = join(outDir, `${TARGETS.manifest}.sig`);
      if (!existsSync(sigFile) || !verifyManifest(Buffer.from(body), readFileSync(sigFile, 'utf8').trim())) {
        log.warn(`[opencart] ${TARGETS.manifest}.sig does not match ${version}: connected stores will not auto-update to it until the manifest is signed on the release host.`);
      }
      log.log(`[opencart] built ${code} ${version}: 4.1 ${fresh.oc4.slice(0, 12)}…, 3.0 ${fresh.oc3.slice(0, 12)}…`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!existsSync(join(outDir, TARGETS.oc4))) throw new Error(`[opencart] ${TARGETS.oc4} was not produced`);
  return { code, version, oc4: join(outDir, TARGETS.oc4), oc3: join(outDir, TARGETS.oc3), manifest: join(outDir, TARGETS.manifest) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    for (const edition of pluginEditionsFor(resolveBuildBrand(process.env))) packageOpenCart({ edition });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
