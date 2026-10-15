#!/usr/bin/env node
/**
 * Signs the commerce plugins' update manifests on the release host, in one
 * command, with the one release key the installed plugins trust
 * (scripts/plugin-release-signature.mjs). The key never enters the
 * repository; only the `.sig` files it makes are committed.
 *
 *   node scripts/sign-plugin-releases.mjs --key /path/to/release-key.pem [--edition respok|iran|all] [--dry-run]
 *
 * For every manifest of the chosen edition(s) it:
 *   1. refuses a key whose public half is not the plugins' UPDATE_PUBLIC_KEY
 *      (a manifest signed with another key would be refused by every store);
 *   2. skips a manifest whose committed `.sig` already verifies;
 *   3. signs the manifest's EXACT bytes (Ed25519) and writes `<manifest>.sig`
 *      (base64, as `openssl pkeyutl -sign -rawin … | base64 -w0` would);
 *   4. verifies the new signature, and checks the archive each manifest names
 *      is the one on disk (sha256 and size), so a stale manifest is never signed.
 *
 * Then commit the `.sig` files and deploy: a signed version is frozen, and
 * installed plugins of that edition take it on their next update check.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublicKey, sha256File, verifyManifest } from './plugin-release-signature.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOWNLOADS = join(ROOT, 'public', 'downloads');

/** The update manifests of each edition (as the builders write them). */
export const RELEASE_MANIFESTS = {
  respok: ['respok-woocommerce.json', 'respok-whmcs.json', join('opencart', 'respok-manifest.json')],
  iran: [['web', 'yar-woocommerce.json'].join(''), ['web', 'yar-whmcs.json'].join(''), join('opencart', 'manifest.json')],
};

/** Archives a manifest names, with the sha256 and size it promises: [{file, sha256, size}]. */
export function manifestPackages(manifestFile, downloadsDir = DOWNLOADS) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const entries = Array.isArray(manifest.packages) ? manifest.packages : [manifest];
  return entries
    .filter((p) => p && (p.package || p.path || p.download_url || p.url))
    .map((p) => {
      const ref = String(p.package || p.path || p.download_url || p.url);
      const rel = ref.replace(/^https?:\/\/[^/]+/, '').replace(/^\/?downloads\//, '');
      return { file: join(downloadsDir, rel), sha256: p.sha256, size: p.size ?? p.size_bytes ?? p.bytes };
    });
}

/** The raw 32-byte Ed25519 public key of a private key, base64. */
export function publicKeyOf(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki).subarray(-32).toString('base64');
}

/**
 * Signs what needs signing. Returns one line per manifest:
 * `signed` | `already signed` | `missing` | `would sign` (dry run).
 * Throws before writing anything when the key or an archive is wrong.
 */
export function signReleases({ privateKeyPem, trustedPublicKey, manifests, downloadsDir = DOWNLOADS, dryRun = false }) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the release key must be Ed25519, not ${key.asymmetricKeyType}`);
  if (publicKeyOf(key) !== trustedPublicKey) {
    throw new Error('this key is not the release key the plugins trust (its public half differs from UPDATE_PUBLIC_KEY); nothing was signed');
  }
  const plan = [];
  for (const rel of manifests) {
    const file = join(downloadsDir, rel);
    if (!existsSync(file)) { plan.push({ rel, action: 'missing' }); continue; }
    const body = readFileSync(file);
    const sigFile = `${file}.sig`;
    if (existsSync(sigFile) && verifyManifest(body, readFileSync(sigFile, 'utf8'), trustedPublicKey)) {
      plan.push({ rel, action: 'already signed' });
      continue;
    }
    for (const pkg of manifestPackages(file, downloadsDir)) {
      if (!existsSync(pkg.file)) throw new Error(`${rel} names ${pkg.file}, which is not on disk: rebuild before signing`);
      if (pkg.sha256 && sha256File(pkg.file) !== pkg.sha256) throw new Error(`${rel}: ${pkg.file} does not match the manifest's sha256: rebuild before signing`);
      if (pkg.size && statSync(pkg.file).size !== Number(pkg.size)) throw new Error(`${rel}: ${pkg.file} does not match the manifest's size: rebuild before signing`);
    }
    plan.push({ rel, action: dryRun ? 'would sign' : 'signed', file, body });
  }
  if (!dryRun) {
    for (const item of plan.filter((p) => p.action === 'signed')) {
      const signature = sign(null, item.body, key).toString('base64');
      if (!verifyManifest(item.body, signature, trustedPublicKey)) throw new Error(`${item.rel}: the new signature does not verify`);
      writeFileSync(`${item.file}.sig`, signature);
    }
  }
  return plan.map(({ rel, action }) => `${action}: ${rel}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const keyPath = opt('--key');
  const edition = opt('--edition') ?? 'respok';
  if (!keyPath || !['respok', 'iran', 'all'].includes(edition)) {
    console.error('usage: node scripts/sign-plugin-releases.mjs --key <release-key.pem> [--edition respok|iran|all] [--dry-run]');
    process.exit(2);
  }
  const trustedPublicKey = readPublicKey(join(ROOT, 'plugins', ['web', 'yar-woocommerce'].join(''), 'src', 'Support', 'Updater.php'));
  const manifests = edition === 'all' ? [...RELEASE_MANIFESTS.respok, ...RELEASE_MANIFESTS.iran] : RELEASE_MANIFESTS[edition];
  try {
    const lines = signReleases({ privateKeyPem: readFileSync(keyPath), trustedPublicKey, manifests, dryRun: args.includes('--dry-run') });
    for (const line of lines) console.log(`[sign-plugins] ${line}`);
    console.log('[sign-plugins] commit the .sig files under public/downloads and deploy.');
  } catch (e) {
    console.error(`[sign-plugins] ${e.message}`);
    process.exit(1);
  }
}
