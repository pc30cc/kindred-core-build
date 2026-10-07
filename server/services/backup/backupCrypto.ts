/**
 * Encryption for database backups that leave this server (a storage provider
 * or FTP). AES-256-GCM, streamed from disk, with a per-file key derived by
 * HKDF-SHA256 from PLUGIN_SECRETS_MASTER_KEY and a random salt.
 *
 * That key is already the one secret a deployment must keep (the encrypted
 * plugin and channel credentials in the database depend on it), so a backup
 * can be read wherever that key is kept, and by nobody who only holds the
 * file. Fails closed: with no usable key, nothing is uploaded.
 *
 * File layout:
 *   "WYDBK001" (8) | salt (16) | nonce (12) | ciphertext | GCM tag (16)
 *
 * scripts/db/decrypt-backup.mjs decrypts a file offline with the same key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolveMasterKey } from '../../lib/pluginCrypto.js';

export const BACKUP_MAGIC = Buffer.from('WYDBK001', 'ascii');
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
export const BACKUP_HEADER_LEN = BACKUP_MAGIC.length + SALT_LEN + NONCE_LEN;
const HKDF_INFO = 'webyar-database-backup-v1';

export class BackupCryptoError extends Error {
  constructor(public code: 'backup_encryption_key_missing' | 'backup_not_encrypted' | 'backup_decrypt_failed') {
    super(code);
    this.name = 'BackupCryptoError';
  }
}

function masterKey(rawKey: string | undefined | null): Buffer {
  const key = resolveMasterKey(rawKey);
  if (!key) throw new BackupCryptoError('backup_encryption_key_missing');
  return key;
}

function fileKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, HKDF_INFO, 32));
}

/** True when the configured master key can encrypt backups. */
export function isBackupEncryptionReady(rawKey: string | undefined | null): boolean {
  return resolveMasterKey(rawKey) !== null;
}

/** Encrypts `src` into `dst` (created 0600). The plaintext never leaves disk unencrypted. */
export async function encryptBackupFile(src: string, dst: string, rawKey: string | undefined | null): Promise<void> {
  const master = masterKey(rawKey);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', fileKey(master, salt), nonce);
  await fs.writeFile(dst, Buffer.concat([BACKUP_MAGIC, salt, nonce]), { mode: 0o600 });
  await pipeline(createReadStream(src), cipher, createWriteStream(dst, { flags: 'a' }));
  await fs.appendFile(dst, cipher.getAuthTag());
}

/** Decrypts a whole encrypted backup held in memory; throws on any tampering. */
export function decryptBackupBuffer(data: Buffer, rawKey: string | undefined | null): Buffer {
  if (data.length < BACKUP_HEADER_LEN + TAG_LEN || !data.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new BackupCryptoError('backup_not_encrypted');
  }
  const master = masterKey(rawKey);
  const salt = data.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT_LEN);
  const nonce = data.subarray(BACKUP_MAGIC.length + SALT_LEN, BACKUP_HEADER_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const body = data.subarray(BACKUP_HEADER_LEN, data.length - TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', fileKey(master, salt), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupCryptoError('backup_decrypt_failed');
  }
}
