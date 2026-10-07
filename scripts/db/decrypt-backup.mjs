#!/usr/bin/env node
/**
 * Decrypts a database backup that Super Admin → Database → Backup sent to a
 * storage vendor or FTP (`<backup-id>.dump.enc`) back into the plain
 * pg_dump archive, offline, with the deployment's PLUGIN_SECRETS_MASTER_KEY.
 *
 *   PLUGIN_SECRETS_MASTER_KEY=... node scripts/db/decrypt-backup.mjs in.dump.enc [out.dump]
 *
 * The key is read from the environment only, never from an argument. The
 * output is written to a temporary file and renamed into place only after
 * the GCM tag verified, so a wrong key or a damaged file never leaves a
 * partial archive behind. Format: server/services/backup/backupCrypto.ts.
 *
 * Restore the result with pg_restore, e.g.
 *   pg_restore --list out.dump | head
 *   pg_restore --no-owner --dbname=<target> out.dump
 */
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('WYDBK001', 'ascii');
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + NONCE_LEN;

/** Same rules as server/lib/pluginCrypto.ts resolveMasterKey. */
function resolveMasterKey(raw) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const b64 = Buffer.from(value, 'base64');
  if (b64.length === 32) return b64;
  if (value.length >= 32) return createHash('sha256').update(value).digest();
  return null;
}

function fail(message) {
  console.error(`decrypt-backup: ${message}`);
  process.exit(1);
}

const [input, outputArg] = process.argv.slice(2);
if (!input) fail('usage: PLUGIN_SECRETS_MASTER_KEY=... node scripts/db/decrypt-backup.mjs <in.dump.enc> [out.dump]');
const output = outputArg || input.replace(/\.enc$/, '') + (input.endsWith('.enc') ? '' : '.dump');
if (output === input) fail('output would overwrite the input');

const master = resolveMasterKey(process.env.PLUGIN_SECRETS_MASTER_KEY);
if (!master) fail('PLUGIN_SECRETS_MASTER_KEY is missing or unusable');

const handle = await fs.open(input, 'r');
const { size } = await handle.stat();
if (size < HEADER_LEN + TAG_LEN) fail('not an encrypted WebYar backup (too short)');
const header = Buffer.alloc(HEADER_LEN);
const tag = Buffer.alloc(TAG_LEN);
await handle.read(header, 0, HEADER_LEN, 0);
await handle.read(tag, 0, TAG_LEN, size - TAG_LEN);
await handle.close();
if (!header.subarray(0, MAGIC.length).equals(MAGIC)) fail('not an encrypted WebYar backup (bad header)');

const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
const nonce = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
const key = Buffer.from(hkdfSync('sha256', master, salt, 'webyar-database-backup-v1', 32));
const decipher = createDecipheriv('aes-256-gcm', key, nonce);
decipher.setAuthTag(tag);

const tmp = `${output}.partial`;
try {
  if (size > HEADER_LEN + TAG_LEN) {
    await pipeline(
      createReadStream(input, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      createWriteStream(tmp, { mode: 0o600 }),
    );
  } else {
    decipher.final();
    await fs.writeFile(tmp, Buffer.alloc(0), { mode: 0o600 });
  }
} catch {
  await fs.rm(tmp, { force: true });
  fail('decryption failed: wrong PLUGIN_SECRETS_MASTER_KEY, or the file is damaged');
}
await fs.rename(tmp, output);
console.log(`decrypt-backup: wrote ${output}`);
