/**
 * Release signatures for the self-updating commerce plugins (WooCommerce,
 * WHMCS; OpenCart uses the same scheme inline in its build script).
 *
 * A release is `<name>.json` (the update manifest: version, package path,
 * sha256, size) plus `<name>.json.sig`: a detached Ed25519 signature, base64,
 * over the manifest's EXACT bytes. It is made on the release host, never in
 * a build and never with a key in this repository:
 *
 *   openssl pkeyutl -sign -rawin -inkey <release-key.pem> -in <name>.json | base64 -w0 > <name>.json.sig
 *
 * Installed plugins verify it against the public key built into them (one
 * release key for all three plugins), then check the downloaded archive
 * against the signed sha256. A build never re-signs; it keeps a signed
 * release byte for byte (frozen) and only builds afresh for a new version,
 * which stores ignore until it is signed.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The base64 public key assigned to `const UPDATE_PUBLIC_KEY = '…'` in a PHP source file. */
export function readPublicKey(phpFile) {
  const key = readFileSync(phpFile, 'utf8').match(/UPDATE_PUBLIC_KEY = '([^']+)'/)?.[1];
  if (!key || Buffer.from(key, 'base64').length !== 32) throw new Error(`UPDATE_PUBLIC_KEY (32-byte Ed25519, base64) not found in ${phpFile}`);
  return key;
}

export function verifyManifest(body, signatureB64, publicKeyB64) {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
  try {
    return verify(null, body, key, Buffer.from(String(signatureB64).trim(), 'base64'));
  } catch {
    return false;
  }
}

/** The committed manifest, parsed, when `<manifest>.sig` verifies it; otherwise null. */
export function signedManifest(manifestFile, publicKeyB64) {
  const sigFile = `${manifestFile}.sig`;
  if (!existsSync(manifestFile) || !existsSync(sigFile)) return null;
  const body = readFileSync(manifestFile);
  return verifyManifest(body, readFileSync(sigFile, 'utf8'), publicKeyB64) ? JSON.parse(body.toString('utf8')) : null;
}

export function sha256File(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

/**
 * One file date per VERSION (reproducible builds, like the OpenCart
 * packager), different for every version so opcache — which decides
 * "changed?" by mtime — never keeps running an older release.
 */
export function fixedTimeFor(version) {
  const [major, minor = 0, patch = 0] = version.split('.').map(Number);
  if (minor > 99 || patch > 99) throw new Error('version parts above 99 need a new fixed-time scheme');
  return new Date(Date.UTC(2026, 0, 1) + (major * 10000 + minor * 100 + patch) * 60_000);
}
