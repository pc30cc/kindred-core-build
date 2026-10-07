/**
 * Super Admin database backups — settings validation and the schedule rule
 * (server/services/backup/databaseBackupSettings.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  addOneMonth,
  applyBackupSettingsUpdate,
  backupSettingsView,
  BackupSettingsError,
  computeNextBackupRun,
  defaultBackupSettings,
  normalizeBackupSettings,
  normalizeFtpHost,
  normalizeFtpPath,
  type BackupSettingsUpdate,
} from '../../../server/services/backup/databaseBackupSettings';
import { decryptPluginSecret } from '../../../server/lib/pluginCrypto';

const KEY = 'a'.repeat(64);

function update(p: Partial<BackupSettingsUpdate> = {}): BackupSettingsUpdate {
  return { enabled: false, schedule: 'daily', hourUtc: 2, destination: 'local', retentionDays: 30, ...p };
}

describe('normalizeBackupSettings', () => {
  it('fills defaults for a missing or broken row', () => {
    expect(normalizeBackupSettings(null)).toEqual(defaultBackupSettings());
    const s = normalizeBackupSettings({ enabled: 'yes', schedule: 'hourly', hourUtc: 99, destination: 'cloud', retentionDays: -1, ftp: { port: 'x' } });
    expect(s.enabled).toBe(false);
    expect(s.schedule).toBe('daily');
    expect(s.hourUtc).toBe(2);
    expect(s.destination).toBe('local');
    expect(s.retentionDays).toBe(30);
    expect(s.ftp.port).toBe(21);
  });

  it('never exposes the FTP password in the view', () => {
    const s = defaultBackupSettings();
    s.ftp.password = { algorithm: 'aes-256-gcm', key_version: 1, nonce: 'n', ciphertext: 'c', auth_tag: 't', fingerprint: 'f' };
    const view = backupSettingsView(s);
    expect(view.ftp.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain('ciphertext');
  });
});

describe('applyBackupSettingsUpdate', () => {
  const opts = { masterKey: KEY, actorId: 'admin-1', now: new Date('2026-10-07T10:00:00Z') };

  it('encrypts a new FTP password and keeps it when the field is left blank', () => {
    const first = applyBackupSettingsUpdate(defaultBackupSettings(), update({
      destination: 'ftp',
      ftp: { host: 'ftp.example.com', port: 21, username: 'u', password: 's3cret-pass', path: 'backups', secure: true, verifyTls: true },
    }), opts);
    expect(first.ftp.password).not.toBeNull();
    expect(JSON.stringify(first)).not.toContain('s3cret-pass');
    expect(decryptPluginSecret(first.ftp.password!, KEY)).toBe('s3cret-pass');

    const second = applyBackupSettingsUpdate(first, update({
      destination: 'ftp',
      ftp: { host: 'ftp.example.com', port: 2121, username: 'u', password: '', path: '/srv//db/', secure: false, verifyTls: true },
    }), opts);
    expect(second.ftp.password).toEqual(first.ftp.password);
    expect(second.ftp.port).toBe(2121);
    expect(second.ftp.path).toBe('/srv/db');
  });

  it('refuses an FTP destination without host, user and password', () => {
    expect(() => applyBackupSettingsUpdate(defaultBackupSettings(), update({
      destination: 'ftp',
      ftp: { host: 'ftp.example.com', port: 21, username: 'u', path: '/', secure: true, verifyTls: true },
    }), opts)).toThrow(BackupSettingsError);
  });

  it('refuses off-server destinations without an encryption key', () => {
    try {
      applyBackupSettingsUpdate(defaultBackupSettings(), update({ destination: 'storage', storageProvider: 's3' }), { ...opts, masterKey: '' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as BackupSettingsError).code).toBe('encryption_key_missing');
    }
  });

  it('requires a storage vendor for the storage destination', () => {
    expect(() => applyBackupSettingsUpdate(defaultBackupSettings(), update({ destination: 'storage' }), opts)).toThrow('storage_provider_required');
  });

  it('anchors the schedule when it is switched on or changed, and clears it when off', () => {
    const on = applyBackupSettingsUpdate(defaultBackupSettings(), update({ enabled: true }), opts);
    expect(on.scheduleAnchor).toBe('2026-10-07T10:00:00.000Z');
    const same = applyBackupSettingsUpdate(on, update({ enabled: true, retentionDays: 7 }), { ...opts, now: new Date('2026-10-08T10:00:00Z') });
    expect(same.scheduleAnchor).toBe(on.scheduleAnchor);
    const moved = applyBackupSettingsUpdate(on, update({ enabled: true, hourUtc: 5 }), { ...opts, now: new Date('2026-10-08T10:00:00Z') });
    expect(moved.scheduleAnchor).toBe('2026-10-08T10:00:00.000Z');
    expect(applyBackupSettingsUpdate(on, update({ enabled: false }), opts).scheduleAnchor).toBeNull();
  });
});

describe('FTP host and path', () => {
  it('accepts hosts, IPs and pasted URLs; rejects credentials in the host', () => {
    expect(normalizeFtpHost(' ftp.example.com ')).toBe('ftp.example.com');
    expect(normalizeFtpHost('ftps://backup.example.com:990/dir')).toBe('backup.example.com');
    expect(normalizeFtpHost('10.0.0.5')).toBe('10.0.0.5');
    expect(normalizeFtpHost('[2001:db8::1]')).toBe('2001:db8::1');
    expect(() => normalizeFtpHost('ftp://user:pw@host')).toThrow('invalid_ftp_host');
    expect(() => normalizeFtpHost('bad host')).toThrow('invalid_ftp_host');
  });

  it('normalizes folders and rejects traversal and line breaks', () => {
    expect(normalizeFtpPath('/a//b/')).toBe('/a/b');
    expect(normalizeFtpPath('a/b')).toBe('a/b');
    expect(normalizeFtpPath('')).toBe('/webyar-backups');
    expect(() => normalizeFtpPath('/a/../b')).toThrow('invalid_ftp_path');
    expect(() => normalizeFtpPath('/a\r\nDELE x')).toThrow('invalid_ftp_path');
  });
});

describe('computeNextBackupRun', () => {
  const base = { enabled: true, schedule: 'daily' as const, hourUtc: 2, scheduleAnchor: '2026-10-07T10:00:00.000Z' };

  it('is null while the schedule is off', () => {
    expect(computeNextBackupRun({ ...base, enabled: false }, null)).toBeNull();
  });

  it('first run is the first slot after the schedule was switched on', () => {
    expect(computeNextBackupRun(base, null)?.toISOString()).toBe('2026-10-08T02:00:00.000Z');
    expect(computeNextBackupRun({ ...base, hourUtc: 23 }, null)?.toISOString()).toBe('2026-10-07T23:00:00.000Z');
  });

  it('daily, weekly and monthly runs follow the previous attempt', () => {
    const last = new Date('2026-10-08T02:00:41Z');
    expect(computeNextBackupRun(base, last)?.toISOString()).toBe('2026-10-09T02:00:00.000Z');
    expect(computeNextBackupRun({ ...base, schedule: 'weekly' }, last)?.toISOString()).toBe('2026-10-15T02:00:00.000Z');
    expect(computeNextBackupRun({ ...base, schedule: 'monthly' }, last)?.toISOString()).toBe('2026-11-08T02:00:00.000Z');
  });

  it('a run is never repeated in the same slot, even if it started late', () => {
    const late = new Date('2026-10-08T04:30:00Z'); // the 02:00 slot, run late after a restart
    expect(computeNextBackupRun(base, late)?.toISOString()).toBe('2026-10-09T02:00:00.000Z');
  });

  it('a schedule changed after the last run counts from the change', () => {
    const last = new Date('2026-10-08T02:00:00Z');
    const changed = { ...base, hourUtc: 23, scheduleAnchor: '2026-10-08T10:00:00.000Z' };
    expect(computeNextBackupRun(changed, last)?.toISOString()).toBe('2026-10-08T23:00:00.000Z');
  });

  it('monthly keeps the day of month where it exists', () => {
    expect(addOneMonth(new Date('2026-01-31T02:00:00Z')).toISOString()).toBe('2026-02-28T02:00:00.000Z');
    expect(addOneMonth(new Date('2026-12-15T02:00:00Z')).toISOString()).toBe('2027-01-15T02:00:00.000Z');
  });
});
