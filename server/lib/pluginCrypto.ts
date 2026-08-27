/**
 * Authenticated encryption for plugin credentials (AES-256-GCM).
 *
 * Repository audit found no pre-existing authenticated-encryption helper, so
 * this is the canonical one. It is used by Core Backend and the Channels
 * Worker only — the Channels Gateway and the frontend never receive
 * PLUGIN_SECRETS_MASTER_KEY.
 *
 * FAIL CLOSED: with no/invalid master key every secret-dependent operation
 * throws `PluginCryptoUnavailableError`. There is no plaintext fallback.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const PLUGIN_SECRET_ALGORITHM = 'aes-256-gcm';
export const PLUGIN_SECRET_KEY_VERSION = 1;

export class PluginCryptoUnavailableError extends Error {
  code = 'plugin_encryption_not_configured';
  constructor(message = 'Plugin secret encryption is not configured') {
    super(message);
    this.name = 'PluginCryptoUnavailableError';
  }
}

export type SecretEnvelope = {
  algorithm: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  fingerprint: string;
};

/**
 * Accepts a 32-byte key as base64, hex, or a passphrase of >= 32 chars
 * (hashed to 32 bytes). Returns null when unusable — callers must fail closed.
 */
export function resolveMasterKey(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');

  try {
    const b64 = Buffer.from(value, 'base64');
    if (b64.length === 32) return b64;
  } catch {
    /* fall through */
  }

  if (value.length >= 32) return createHash('sha256').update(value).digest();
  return null;
}

export function isPluginCryptoConfigured(raw: string | undefined | null): boolean {
  return resolveMasterKey(raw) !== null;
}

/** Non-reversible fingerprint for diagnostics (never the credential itself). */
export function secretFingerprint(plaintext: string): string {
  return createHash('sha256').update(`plugin-secret:${plaintext}`).digest('hex').slice(0, 16);
}

export function encryptPluginSecret(plaintext: string, rawKey: string | undefined | null): SecretEnvelope {
  const key = resolveMasterKey(rawKey);
  if (!key) throw new PluginCryptoUnavailableError();

  const nonce = randomBytes(12);
  const cipher = createCipheriv(PLUGIN_SECRET_ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: PLUGIN_SECRET_ALGORITHM,
    key_version: PLUGIN_SECRET_KEY_VERSION,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    auth_tag: authTag.toString('base64'),
    fingerprint: secretFingerprint(plaintext),
  };
}

export function decryptPluginSecret(
  envelope: Pick<SecretEnvelope, 'algorithm' | 'nonce' | 'ciphertext' | 'auth_tag'>,
  rawKey: string | undefined | null,
): string {
  const key = resolveMasterKey(rawKey);
  if (!key) throw new PluginCryptoUnavailableError();
  if (envelope.algorithm !== PLUGIN_SECRET_ALGORITHM) {
    throw new PluginCryptoUnavailableError(`Unsupported envelope algorithm: ${envelope.algorithm}`);
  }

  const decipher = createDecipheriv(
    PLUGIN_SECRET_ALGORITHM,
    key,
    Buffer.from(envelope.nonce, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
