/**
 * Super Admin → Database → Backup page (DatabaseBackupsSection) against a
 * mocked API: it shows the real history and warnings, starts a backup with the
 * chosen destination, saves settings without echoing a stored password, and
 * deletes only after confirmation — in Persian, with no untranslated key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';
import type { DatabaseBackupStatus } from '@/lib/admin-database-backups-api';

const api = vi.hoisted(() => ({
  fetchDatabaseBackups: vi.fn(),
  runDatabaseBackup: vi.fn(),
  saveDatabaseBackupSettings: vi.fn(),
  testDatabaseBackupDestination: vi.fn(),
  deleteDatabaseBackup: vi.fn(),
  downloadDatabaseBackupFile: vi.fn(),
}));

vi.mock('@/lib/admin-database-backups-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-database-backups-api')>();
  return { ...actual, ...api };
});

const { DatabaseBackupsSection } = await import('@/components/admin/database/DatabaseBackupsSection');

function status(over: Partial<DatabaseBackupStatus> = {}): DatabaseBackupStatus {
  return {
    settings: {
      enabled: true, schedule: 'daily', hourUtc: 2, destination: 'local', storageProvider: null, retentionDays: 30,
      ftp: { host: 'ftp.example.com', port: 21, username: 'bk', path: '/webyar-backups', secure: true, verifyTls: true, hasPassword: true },
      scheduleAnchor: '2026-10-01T00:00:00.000Z', updatedAt: null, updatedBy: null,
    },
    nextRunAt: '2026-10-08T02:00:00.000Z',
    runningId: null,
    tools: { pgDump: 'pg_dump (PostgreSQL) 17.11', pgRestore: 'pg_restore (PostgreSQL) 17.11' },
    connection: { credential: 'backup_url', role: null, database: 'webyar' },
    local: { dir: '/app/data/backups/database', persistent: true, freeBytes: 50 * 1024 ** 3, writable: true },
    encryptionReady: true,
    storageProviders: [{ name: 'bunny_storage', primary: true, enabled: true }],
    runs: [
      {
        id: 'r1', backupId: 'webyar-db-20261007-020000Z-aaaa', status: 'succeeded', trigger: 'schedule', destinationType: 'ftp',
        destination: 'ftps://ftp.example.com:21/webyar-backups/x.dump.enc', storageProvider: null, startedAt: '2026-10-07T02:00:00.000Z',
        finishedAt: '2026-10-07T02:00:03.000Z', durationMs: 3000, bytes: 3_481_000, encrypted: true, verified: true, tocEntries: 4233,
        error: null, prunedAt: null, downloadable: true,
      },
      {
        id: 'r2', backupId: 'webyar-db-20261006-020000Z-bbbb', status: 'failed', trigger: 'manual', destinationType: 'local',
        destination: null, storageProvider: null, startedAt: '2026-10-06T02:00:00.000Z', finishedAt: '2026-10-06T02:00:01.000Z',
        durationMs: 100, bytes: null, encrypted: false, verified: false, tocEntries: null,
        error: 'pg_dump_failed: pg_dump: error: password authentication failed', prunedAt: null, downloadable: false,
      },
    ],
    ...over,
  };
}

function renderFa() {
  return render(
    <I18nProvider initialLocale="fa" initialTranslations={fa}>
      <DatabaseBackupsSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchDatabaseBackups.mockResolvedValue(status());
});

describe('DatabaseBackupsSection', () => {
  it('shows the real history in Persian, with errors translated and no raw keys', async () => {
    const { container } = renderFa();
    expect(await screen.findByText('webyar-db-20261007-020000Z-aaaa')).toBeTruthy();
    expect(screen.getByText('webyar-db-20261006-020000Z-bbbb')).toBeTruthy();
    expect(screen.getByText(fa.admin.database.backups.encrypted)).toBeTruthy();
    expect(screen.getByText(fa.admin.database.backups.verified)).toBeTruthy();
    expect(screen.getByText(new RegExp(fa.admin.database.backups.errors.pg_dump_failed))).toBeTruthy();
    expect(container.textContent).not.toMatch(/admin\.database\./);
  });

  it('warns when the backup folder is not persistent and pg_dump is missing', async () => {
    api.fetchDatabaseBackups.mockResolvedValue(status({
      local: { dir: '/app/data/backups/database', persistent: false, freeBytes: null, writable: true },
      tools: { pgDump: null, pgRestore: null },
    }));
    renderFa();
    expect(await screen.findByText(fa.admin.database.backups.toolsMissing)).toBeTruthy();
    expect(screen.getByText(fa.admin.database.backups.localNotPersistent.replace('{{dir}}', '/app/data/backups/database'))).toBeTruthy();
  });

  it('starts a backup on the chosen destination and refreshes the history', async () => {
    api.runDatabaseBackup.mockResolvedValue({ ok: true, run: { id: 'r3' } });
    renderFa();
    const start = await screen.findByRole('button', { name: new RegExp(fa.admin.database.startBackup) });
    fireEvent.click(start);
    await waitFor(() => expect(api.runDatabaseBackup).toHaveBeenCalledWith({ destination: 'local', storageProvider: null }));
    await waitFor(() => expect(api.fetchDatabaseBackups).toHaveBeenCalledTimes(2));
  });

  it('saves settings without sending back a stored FTP password', async () => {
    api.saveDatabaseBackupSettings.mockImplementation(async (input) => ({ ok: true, settings: { ...status().settings, ...input, ftp: { ...status().settings.ftp } } }));
    renderFa();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(fa.admin.database.saveSettings) }));
    await waitFor(() => expect(api.saveDatabaseBackupSettings).toHaveBeenCalled());
    const input = api.saveDatabaseBackupSettings.mock.calls[0][0];
    expect(input).toMatchObject({ enabled: true, schedule: 'daily', hourUtc: 2, destination: 'local', retentionDays: 30 });
    expect(input.ftp.password).toBeUndefined();
  });

  it('deletes only after confirmation', async () => {
    api.deleteDatabaseBackup.mockResolvedValue({ ok: true });
    renderFa();
    await screen.findByText('webyar-db-20261007-020000Z-aaaa');
    fireEvent.click(screen.getAllByRole('button', { name: fa.admin.database.backups.delete })[0]);
    expect(api.deleteDatabaseBackup).not.toHaveBeenCalled();
    expect(await screen.findByText(fa.admin.database.backups.deleteTitle)).toBeTruthy();
    const confirm = screen.getAllByRole('button', { name: new RegExp(fa.admin.database.backups.delete) }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteDatabaseBackup).toHaveBeenCalledWith('r1', false));
  });
});
