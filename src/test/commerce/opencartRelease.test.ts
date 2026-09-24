/**
 * The OpenCart release that ships in public/downloads/opencart is the one
 * connected stores install by themselves, so it must be complete and signed:
 * manifest.json.sig verifies against the key built into the extension, the
 * archives match the signed checksums, and the version agrees everywhere.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENCART_LATEST_CONNECTOR_VERSION } from '../../../server/services/commerce/connectors/opencart.js';

const root = join(__dirname, '..', '..', '..');
const dir = join(root, 'public', 'downloads', 'opencart');
const protocol = readFileSync(join(root, 'plugins', 'webyar-opencart', 'core', 'Protocol.php'), 'utf8');
const version = protocol.match(/CONNECTOR_VERSION = '([^']+)'/)?.[1];
const publicKey = protocol.match(/UPDATE_PUBLIC_KEY = '([^']+)'/)?.[1] ?? '';
const body = readFileSync(join(dir, 'manifest.json'));
const manifest = JSON.parse(body.toString('utf8')) as { version: string; slug: string; packages: Array<{ opencart: string; path: string; sha256: string }> };

describe('signed OpenCart release', () => {
  it('has one version everywhere', () => {
    expect(manifest.slug).toBe('webyar-opencart');
    expect(manifest.version).toBe(version);
    expect(OPENCART_LATEST_CONNECTOR_VERSION).toBe(version);
  });

  it('manifest.json.sig verifies against the extension\'s public key', () => {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
    const signature = Buffer.from(readFileSync(join(dir, 'manifest.json.sig'), 'utf8').trim(), 'base64');
    expect(signature).toHaveLength(64);
    expect(verify(null, body, key, signature)).toBe(true);
  });

  it('ships archives that match the signed checksums', () => {
    expect(manifest.packages.map((p) => p.opencart).sort()).toEqual(['3.0.5.x', '4.1.x']);
    for (const p of manifest.packages) {
      expect(p.path).toMatch(/^\/downloads\/opencart\/[a-z0-9./_-]+\.zip$/i);
      const bytes = readFileSync(join(root, 'public', p.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.sha256);
    }
  });
});
