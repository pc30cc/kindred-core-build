/**
 * scripts/sign-plugin-releases.mjs: signs only with the key the plugins
 * trust, never a stale manifest, and leaves a valid signature alone. The
 * committed RESPOK manifests name archives that match them (so they can be
 * signed as they are).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RELEASE_MANIFESTS, publicKeyOf, signReleases } from '../../../scripts/sign-plugin-releases.mjs';
import { verifyManifest } from '../../../scripts/plugin-release-signature.mjs';

const ROOT = resolve(__dirname, '../../..');
const pem = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sign-plugins-'));
  writeFileSync(join(dir, 'demo.zip'), 'zip-bytes');
  const sha = '0cf3a1c2c4c0c1ca1f3c1d4d1e1c8d3f2f6c8e9b4c4a0a1f0e1d2c3b4a5f6e7d';
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ version: '1.0.0', package: '/downloads/demo.zip', size: 9, sha256: sha }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixManifestSha() {
  // The demo manifest names the archive's real sha256.
  const sha = createHash('sha256').update(readFileSync(join(dir, 'demo.zip'))).digest('hex');
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ version: '1.0.0', package: '/downloads/demo.zip', size: 9, sha256: sha }));
}

describe('sign-plugin-releases', () => {
  it('signs the exact manifest bytes with the trusted key, then leaves the valid signature alone', () => {
    fixManifestSha();
    const key = pem();
    const trusted = publicKeyOf(key);
    expect(signReleases({ privateKeyPem: key, trustedPublicKey: trusted, manifests: ['demo.json'], downloadsDir: dir })).toEqual(['signed: demo.json']);
    const sig = readFileSync(join(dir, 'demo.json.sig'), 'utf8');
    expect(verifyManifest(readFileSync(join(dir, 'demo.json')), sig, trusted)).toBe(true);
    expect(signReleases({ privateKeyPem: key, trustedPublicKey: trusted, manifests: ['demo.json'], downloadsDir: dir })).toEqual(['already signed: demo.json']);
  });

  it('refuses a key the plugins do not trust, and writes nothing', () => {
    fixManifestSha();
    expect(() => signReleases({ privateKeyPem: pem(), trustedPublicKey: publicKeyOf(pem()), manifests: ['demo.json'], downloadsDir: dir }))
      .toThrow(/not the release key/);
    expect(() => readFileSync(join(dir, 'demo.json.sig'))).toThrow();
  });

  it('refuses a manifest whose archive changed since it was built', () => {
    const key = pem();
    expect(() => signReleases({ privateKeyPem: key, trustedPublicKey: publicKeyOf(key), manifests: ['demo.json'], downloadsDir: dir }))
      .toThrow(/does not match the manifest's sha256/);
  });

  it('the dry run signs nothing', () => {
    fixManifestSha();
    const key = pem();
    expect(signReleases({ privateKeyPem: key, trustedPublicKey: publicKeyOf(key), manifests: ['demo.json'], downloadsDir: dir, dryRun: true })).toEqual(['would sign: demo.json']);
    expect(() => readFileSync(join(dir, 'demo.json.sig'))).toThrow();
  });

  it('the committed RESPOK manifests match their archives, so they can be signed as they are', () => {
    // A dry run only reads: the repository's own files are checked in place.
    const key = pem();
    const lines = signReleases({
      privateKeyPem: key, trustedPublicKey: publicKeyOf(key), manifests: RELEASE_MANIFESTS.respok,
      downloadsDir: join(ROOT, 'public', 'downloads'), dryRun: true,
    });
    expect(lines).toEqual(RELEASE_MANIFESTS.respok.map((m: string) => `would sign: ${m}`));
  });
});
