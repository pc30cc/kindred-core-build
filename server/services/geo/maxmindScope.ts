/**
 * The cache-bus scope of one MaxMind database file (lib/cacheBus.ts,
 * `geo:<key>`): the updater publishes it after it swapped a new file in
 * (maxmindUpdater.ts), and every backend process drops that file's reader
 * (maxmindLocal.ts). The key is a hash of the path, so any path fits a scope
 * (no spaces, at most 320 characters). Pure: no I/O.
 */
import { createHash } from 'node:crypto';

export function maxmindPathKey(dbPath: string): string {
  return createHash('sha256').update(dbPath).digest('hex').slice(0, 32);
}

export function maxmindReaderScope(dbPath: string): string {
  return `geo:${maxmindPathKey(dbPath)}`;
}
