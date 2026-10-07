// @vitest-environment node
/**
 * Encryption of database backups that leave the server
 * (server/services/backup/backupCrypto.ts), and the offline decryptor
 * scripts/db/decrypt-backup.mjs reading the same format.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_HEADER_LEN,
  BackupCryptoError,
  decryptBackupBuffer,
  encryptBackupFile,
  isBackupEncryptionReady,
} from '../../../server/services/backup/backupCrypto';

const KEY = 'k'.repeat(40); // a passphrase of >= 32 chars, as resolveMasterKey accepts
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wy-backup-crypto-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as BackupCryptoError).code;
  }
  return 'no error';
}

describe('backup encryption', () => {
  it('round-trips a file and leaves no plaintext in the output', async () => {
    const plain = Buffer.concat([Buffer.from('PGDMP-plaintext-marker'), randomBytes(200_000)]);
    const src = path.join(dir, 'a.dump');
    const dst = path.join(dir, 'a.dump.enc');
    writeFileSync(src, plain);
    await encryptBackupFile(src, dst, KEY);
    const enc = readFileSync(dst);
    expect(enc.length).toBe(plain.length + BACKUP_HEADER_LEN + 16);
    expect(enc.subarray(0, 8).toString('ascii')).toBe('WYDBK001');
    expect(enc.includes(Buffer.from('PGDMP-plaintext-marker'))).toBe(false);
    expect(statSync(dst).mode & 0o077).toBe(0);
    expect(decryptBackupBuffer(enc, KEY).equals(plain)).toBe(true);
  });

  it('two encryptions of the same file differ (fresh salt and nonce)', async () => {
    const src = path.join(dir, 'b.dump');
    writeFileSync(src, 'same content');
    await encryptBackupFile(src, path.join(dir, 'b1.enc'), KEY);
    await encryptBackupFile(src, path.join(dir, 'b2.enc'), KEY);
    expect(readFileSync(path.join(dir, 'b1.enc')).equals(readFileSync(path.join(dir, 'b2.enc')))).toBe(false);
  });

  it('rejects tampering, a wrong key and a file that is not a backup', async () => {
    const src = path.join(dir, 'c.dump');
    writeFileSync(src, randomBytes(4096));
    await encryptBackupFile(src, path.join(dir, 'c.enc'), KEY);
    const enc = readFileSync(path.join(dir, 'c.enc'));
    const flipped = Buffer.from(enc);
    flipped[BACKUP_HEADER_LEN + 10] ^= 0x01;
    expect(codeOf(() => decryptBackupBuffer(flipped, KEY))).toBe('backup_decrypt_failed');
    expect(codeOf(() => decryptBackupBuffer(enc, 'x'.repeat(40)))).toBe('backup_decrypt_failed');
    expect(codeOf(() => decryptBackupBuffer(Buffer.from('PGDMP not encrypted at all, long enough to pass the length check'), KEY))).toBe('backup_not_encrypted');
  });

  it('fails closed without a usable key', async () => {
    expect(isBackupEncryptionReady('')).toBe(false);
    expect(isBackupEncryptionReady('short')).toBe(false);
    expect(isBackupEncryptionReady(KEY)).toBe(true);
    writeFileSync(path.join(dir, 'd.dump'), 'x');
    await expect(encryptBackupFile(path.join(dir, 'd.dump'), path.join(dir, 'd.enc'), undefined)).rejects.toMatchObject({
      code: 'backup_encryption_key_missing',
    });
  });

  it('scripts/db/decrypt-backup.mjs restores the archive; a wrong key leaves nothing behind', async () => {
    const plain = randomBytes(150_000);
    const src = path.join(dir, 'e.dump');
    const enc = path.join(dir, 'e.dump.enc');
    writeFileSync(src, plain);
    await encryptBackupFile(src, enc, KEY);
    const out = path.join(dir, 'e.restored.dump');
    const script = path.resolve('scripts/db/decrypt-backup.mjs');
    execFileSync(process.execPath, [script, enc, out], { env: { ...process.env, PLUGIN_SECRETS_MASTER_KEY: KEY }, stdio: 'pipe' });
    expect(readFileSync(out).equals(plain)).toBe(true);

    const bad = path.join(dir, 'e.bad.dump');
    expect(() =>
      execFileSync(process.execPath, [script, enc, bad], { env: { ...process.env, PLUGIN_SECRETS_MASTER_KEY: 'w'.repeat(40) }, stdio: 'pipe' }),
    ).toThrow();
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(`${bad}.partial`)).toBe(false);
  });
});
