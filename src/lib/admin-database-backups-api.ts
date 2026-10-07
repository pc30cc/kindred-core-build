/**
 * Super Admin → Database → Backup: real database backups (pg_dump) made by
 * the backend. Server side: server/services/backup/databaseBackup.ts,
 * routes under /api/admin/database/backups (platform admin only).
 */
import { API_BASE } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

export type BackupSchedule = 'daily' | 'weekly' | 'monthly';
export type BackupDestination = 'local' | 'storage' | 'ftp';

export interface BackupFtpSettingsView {
  host: string;
  port: number;
  username: string;
  path: string;
  secure: boolean;
  verifyTls: boolean;
  hasPassword: boolean;
}

export interface BackupSettingsView {
  enabled: boolean;
  schedule: BackupSchedule;
  hourUtc: number;
  destination: BackupDestination;
  storageProvider: string | null;
  retentionDays: number;
  ftp: BackupFtpSettingsView;
  scheduleAnchor: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface BackupRunView {
  id: string;
  backupId: string;
  status: 'running' | 'succeeded' | 'failed';
  trigger: 'manual' | 'schedule';
  destinationType: BackupDestination | null;
  destination: string | null;
  storageProvider: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  encrypted: boolean;
  verified: boolean;
  tocEntries: number | null;
  error: string | null;
  prunedAt: string | null;
  downloadable: boolean;
}

export interface DatabaseBackupStatus {
  settings: BackupSettingsView;
  nextRunAt: string | null;
  runningId: string | null;
  tools: { pgDump: string | null; pgRestore: string | null };
  connection: { credential: 'backup_url' | 'database_url'; role: string | null; database: string } | null;
  local: { dir: string; persistent: boolean | null; freeBytes: number | null; writable: boolean };
  encryptionReady: boolean;
  storageProviders: { name: string; primary: boolean; enabled: boolean }[];
  runs: BackupRunView[];
}

export interface BackupFtpInput {
  host: string;
  port: number;
  username: string;
  /** Blank keeps the stored password. */
  password?: string;
  clearPassword?: boolean;
  path: string;
  secure: boolean;
  verifyTls: boolean;
}

export interface BackupSettingsInput {
  enabled: boolean;
  schedule: BackupSchedule;
  hourUtc: number;
  destination: BackupDestination;
  storageProvider: string | null;
  retentionDays: number;
  ftp: BackupFtpInput;
}

/** A failed call, with the server's stable error code (translated by the page). */
export class BackupApiError extends Error {
  constructor(public code: string, public detail?: string, public status?: number) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BackupApiError';
  }
}

async function failure(res: Response): Promise<BackupApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  const code = body.error || (res.status === 404 ? 'backend_not_deployed' : `http_${res.status}`);
  return new BackupApiError(code, body.detail, res.status);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_BASE}/api/admin/database${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

export function fetchDatabaseBackups(): Promise<DatabaseBackupStatus> {
  return call<DatabaseBackupStatus>('/backups');
}

export function saveDatabaseBackupSettings(input: BackupSettingsInput) {
  return call<{ ok: true; settings: BackupSettingsView }>('/backups/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function runDatabaseBackup(input: { destination: BackupDestination; storageProvider?: string | null }) {
  return call<{ ok: true; run: BackupRunView }>('/backups/run', { method: 'POST', body: JSON.stringify(input) });
}

export function testDatabaseBackupDestination(input: {
  destination: BackupDestination;
  storageProvider?: string | null;
  ftp?: BackupFtpInput;
}) {
  return call<{ ok: true; persistent?: boolean | null; freeBytes?: number | null }>('/backups/test', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteDatabaseBackup(id: string, force = false) {
  return call<{ ok: true }>(`/backups/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, { method: 'DELETE' });
}

/** Downloads the plain pg_dump archive (`<backup-id>.dump`), decrypted by the server. */
export async function downloadDatabaseBackupFile(id: string, fileName: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/admin/database/backups/${encodeURIComponent(id)}/download`, {
    method: 'GET',
  });
  if (!res.ok) throw await failure(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
