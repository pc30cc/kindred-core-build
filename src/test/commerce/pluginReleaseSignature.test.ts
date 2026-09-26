/**
 * The WooCommerce and WHMCS releases in public/downloads are what connected
 * stores install by themselves, and they install only a manifest signed by
 * the Web Yar release key (see scripts/plugin-release-signature.mjs).
 *
 * One release key for all three plugins: the key pinned in each must be the
 * same, or the release host would need several. The committed manifests must
 * describe the committed archives, and a committed signature must verify —
 * a stale one would make every store report "signature invalid". An absent
 * signature is allowed here: that version is simply not offered yet.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const keyIn = (file: string) => readFileSync(join(root, file), 'utf8').match(/UPDATE_PUBLIC_KEY = '([^']+)'/)?.[1] ?? '';

const OPENCART_KEY = keyIn('plugins/webyar-opencart/core/Protocol.php');

const RELEASES = [
  { slug: 'webyar-woocommerce', keyFile: 'plugins/webyar-woocommerce/src/Support/Updater.php' },
  { slug: 'webyar-whmcs', keyFile: 'plugins/webyar-whmcs/modules/addons/webyar/lib/Updater.php' },
];

describe.each(RELEASES)('$slug release', ({ slug, keyFile }) => {
  const dir = join(root, 'public', 'downloads');
  const body = readFileSync(join(dir, `${slug}.json`));
  const manifest = JSON.parse(body.toString('utf8')) as { slug: string; package: string; sha256: string; size: number };
  const publicKey = keyIn(keyFile);

  it('pins the same release key as OpenCart', () => {
    expect(Buffer.from(publicKey, 'base64')).toHaveLength(32);
    expect(publicKey).toBe(OPENCART_KEY);
  });

  it('describes the archive beside it', () => {
    expect(manifest.slug).toBe(slug);
    expect(manifest.package).toBe(`/downloads/${slug}.zip`);
    const bytes = readFileSync(join(root, 'public', manifest.package));
    expect(manifest.size).toBe(bytes.length);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
  });

  it('carries no stale signature', () => {
    const sigFile = join(dir, `${slug}.json.sig`);
    if (!existsSync(sigFile)) return;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
    expect(verify(null, body, key, Buffer.from(readFileSync(sigFile, 'utf8').trim(), 'base64'))).toBe(true);
  });
});
