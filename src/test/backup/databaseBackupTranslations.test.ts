/**
 * Super Admin → Database → Backup: every string of the real backup screen
 * (admin.database.backups) exists, non-empty, in en / fa / tr with the same
 * keys, and every error code the server can return has a message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

const base = flatten(en.admin.database.backups as unknown as Tree);

describe('admin.database.backups translations', () => {
  for (const [name, locale] of [['fa', fa], ['tr', tr]] as const) {
    it(`${name} has exactly the English keys, none empty`, () => {
      const keys = flatten(locale.admin.database.backups as unknown as Tree);
      expect([...keys.keys()].sort()).toEqual([...base.keys()].sort());
      expect([...keys].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    });
  }

  it('every error code raised by the backup service has a message', () => {
    const sources = [
      'server/services/backup/databaseBackup.ts',
      'server/services/backup/databaseBackupSettings.ts',
      'server/services/backup/ftpClient.ts',
    ].map((f) => readFileSync(f, 'utf8')).join('\n');
    const codes = new Set<string>();
    for (const m of sources.matchAll(/(?:DatabaseBackupError|BackupSettingsError|FtpError)\('([a-z0-9_]+)'/g)) codes.add(m[1]);
    for (const m of sources.matchAll(/toolFailure\('([a-z_]+)'/g)) {
      codes.add(`${m[1]}_failed`);
      codes.add(`${m[1]}_timeout`);
    }
    expect(codes.size).toBeGreaterThan(20);
    const missing = [...codes].filter((c) => !base.has(`errors.${c}`));
    expect(missing).toEqual([]);
  });
});
