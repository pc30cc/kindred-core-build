/**
 * Settings and schedule arithmetic for the Super Admin database backups
 * (server/services/backup/databaseBackup.ts). Pure functions only, so the
 * validation and the "when is the next run" rule are unit-tested without a
 * database.
 *
 * The settings live in app_runtime_config under `database_backup_settings`.
 * The FTP password is stored only as an encrypted envelope
 * (PLUGIN_SECRETS_MASTER_KEY) and is never sent back to the browser.
 */
import net from 'node:net';
import { z } from 'zod';
import { encryptPluginSecret, resolveMasterKey, type SecretEnvelope } from '../../lib/pluginCrypto.js';

export const BACKUP_SETTINGS_KEY = 'database_backup_settings';

export type BackupSchedule = 'daily' | 'weekly' | 'monthly';
export type BackupDestination = 'local' | 'storage' | 'ftp';

export interface FtpSettings {
  host: string;
  port: number;
  username: string;
  /** Directory on the FTP server; relative paths start at the login directory. */
  path: string;
  /** Explicit FTPS (AUTH TLS). */
  secure: boolean;
  /** Verify the FTPS certificate. */
  verifyTls: boolean;
  password: SecretEnvelope | null;
}

export interface DatabaseBackupSettings {
  enabled: boolean;
  schedule: BackupSchedule;
  /** Hour of day (UTC) the scheduled backup runs. */
  hourUtc: number;
  destination: BackupDestination;
  /** A vendor from the storage pool (server/services/storage/pool.ts), when destination is 'storage'. */
  storageProvider: string | null;
  retentionDays: number;
  ftp: FtpSettings;
  /** When the schedule was last switched on or changed; the first scheduled run counts from here. */
  scheduleAnchor: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The settings as the admin UI sees them: the FTP password is reduced to "is one stored". */
export type DatabaseBackupSettingsView = Omit<DatabaseBackupSettings, 'ftp'> & {
  ftp: Omit<FtpSettings, 'password'> & { hasPassword: boolean };
};

export const DEFAULT_FTP_PATH = '/webyar-backups';

export function defaultBackupSettings(): DatabaseBackupSettings {
  return {
    enabled: false,
    schedule: 'daily',
    hourUtc: 2,
    destination: 'local',
    storageProvider: null,
    retentionDays: 30,
    ftp: { host: '', port: 21, username: '', path: DEFAULT_FTP_PATH, secure: true, verifyTls: true, password: null },
    scheduleAnchor: null,
    updatedAt: null,
    updatedBy: null,
  };
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  const v = value as Partial<SecretEnvelope> | null;
  return !!v && typeof v === 'object' && typeof v.ciphertext === 'string' && typeof v.nonce === 'string'
    && typeof v.auth_tag === 'string' && typeof v.algorithm === 'string';
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads whatever is stored (the row is editable in the raw runtime-config
 * screen too) into a complete, in-range settings object.
 */
export function normalizeBackupSettings(value: unknown): DatabaseBackupSettings {
  const d = defaultBackupSettings();
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const f = (v.ftp && typeof v.ftp === 'object' ? v.ftp : {}) as Record<string, unknown>;
  const schedule = ['daily', 'weekly', 'monthly'].includes(v.schedule as string) ? (v.schedule as BackupSchedule) : d.schedule;
  const destination = ['local', 'storage', 'ftp'].includes(v.destination as string)
    ? (v.destination as BackupDestination)
    : d.destination;
  return {
    enabled: v.enabled === true,
    schedule,
    hourUtc: intIn(v.hourUtc, 0, 23, d.hourUtc),
    destination,
    storageProvider: typeof v.storageProvider === 'string' && v.storageProvider ? v.storageProvider : null,
    retentionDays: intIn(v.retentionDays, 1, 3650, d.retentionDays),
    ftp: {
      host: str(f.host),
      port: intIn(f.port, 1, 65535, 21),
      username: str(f.username),
      path: str(f.path, DEFAULT_FTP_PATH) || DEFAULT_FTP_PATH,
      secure: f.secure !== false,
      verifyTls: f.verifyTls !== false,
      password: isEnvelope(f.password) ? f.password : null,
    },
    scheduleAnchor: typeof v.scheduleAnchor === 'string' ? v.scheduleAnchor : null,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
  };
}

export function backupSettingsView(s: DatabaseBackupSettings): DatabaseBackupSettingsView {
  const { password, ...ftp } = s.ftp;
  return { ...s, ftp: { ...ftp, hasPassword: !!password } };
}

/** What PUT /api/admin/database/backups/settings accepts. */
export const backupSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  schedule: z.enum(['daily', 'weekly', 'monthly']),
  hourUtc: z.number().int().min(0).max(23),
  destination: z.enum(['local', 'storage', 'ftp']),
  storageProvider: z.string().trim().max(64).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650),
  ftp: z
    .object({
      host: z.string().trim().max(300).default(''),
      port: z.number().int().min(1).max(65535).default(21),
      username: z.string().max(255).default(''),
      /** New password; blank or absent keeps the stored one. */
      password: z.string().max(1024).optional(),
      clearPassword: z.boolean().optional(),
      path: z.string().trim().max(1024).default(DEFAULT_FTP_PATH),
      secure: z.boolean().default(true),
      verifyTls: z.boolean().default(true),
    })
    .optional(),
});

export type BackupSettingsUpdate = z.infer<typeof backupSettingsUpdateSchema>;

export class BackupSettingsError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'BackupSettingsError';
  }
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Accepts `host`, or a pasted `ftp://host[:port]/...`; returns the bare host or throws. */
export function normalizeFtpHost(raw: string): string {
  let host = raw.trim().replace(/^ftps?:\/\//i, '');
  if (host.includes('@')) throw new BackupSettingsError('invalid_ftp_host');
  host = host.replace(/\/.*$/, '');
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d+)?$/.exec(host);
  if (bracketed) host = bracketed[1];
  else if (!net.isIP(host)) host = host.replace(/:\d+$/, '');
  if (!host) return '';
  if (net.isIP(host) || HOSTNAME.test(host)) return host;
  throw new BackupSettingsError('invalid_ftp_host');
}

/** Collapses repeated slashes and rejects line breaks and `..` segments. */
export function normalizeFtpPath(raw: string): string {
  const trimmed = raw.trim();
  if (/[\r\n\0]/.test(trimmed)) throw new BackupSettingsError('invalid_ftp_path');
  const absolute = trimmed.startsWith('/');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new BackupSettingsError('invalid_ftp_path');
  const joined = parts.join('/');
  if (!joined) return absolute ? '/' : DEFAULT_FTP_PATH;
  return absolute ? `/${joined}` : joined;
}

export function isFtpConfigured(ftp: FtpSettings): boolean {
  return !!ftp.host && !!ftp.username && !!ftp.password;
}

/**
 * Applies an admin's update to the stored settings. Throws
 * BackupSettingsError with a stable code the UI translates.
 */
export function applyBackupSettingsUpdate(
  current: DatabaseBackupSettings,
  input: BackupSettingsUpdate,
  opts: { masterKey: string | undefined | null; actorId: string; now?: Date },
): DatabaseBackupSettings {
  const now = (opts.now ?? new Date()).toISOString();
  const ftpIn = input.ftp;
  const ftp: FtpSettings = { ...current.ftp };
  if (ftpIn) {
    ftp.host = normalizeFtpHost(ftpIn.host ?? '');
    ftp.port = ftpIn.port ?? 21;
    ftp.username = (ftpIn.username ?? '').trim();
    if (/[\r\n\0]/.test(ftp.username)) throw new BackupSettingsError('invalid_ftp_username');
    ftp.path = normalizeFtpPath(ftpIn.path ?? DEFAULT_FTP_PATH);
    ftp.secure = ftpIn.secure ?? true;
    ftp.verifyTls = ftpIn.verifyTls ?? true;
    if (ftpIn.password) {
      if (/[\r\n\0]/.test(ftpIn.password)) throw new BackupSettingsError('invalid_ftp_password');
      if (!resolveMasterKey(opts.masterKey)) throw new BackupSettingsError('encryption_key_missing');
      ftp.password = encryptPluginSecret(ftpIn.password, opts.masterKey);
    } else if (ftpIn.clearPassword) {
      ftp.password = null;
    }
  }

  const storageProvider = input.storageProvider?.trim() || null;
  if (input.destination === 'storage' && !storageProvider) throw new BackupSettingsError('storage_provider_required');
  if (input.destination === 'ftp' && !isFtpConfigured(ftp)) throw new BackupSettingsError('ftp_settings_incomplete');
  if (input.destination !== 'local' && !resolveMasterKey(opts.masterKey)) {
    throw new BackupSettingsError('encryption_key_missing');
  }

  const scheduleChanged =
    input.enabled !== current.enabled || input.schedule !== current.schedule || input.hourUtc !== current.hourUtc;

  return {
    enabled: input.enabled,
    schedule: input.schedule,
    hourUtc: input.hourUtc,
    destination: input.destination,
    storageProvider: input.destination === 'storage' ? storageProvider : current.storageProvider,
    retentionDays: input.retentionDays,
    ftp,
    scheduleAnchor: input.enabled ? (scheduleChanged || !current.scheduleAnchor ? now : current.scheduleAnchor) : null,
    updatedAt: now,
    updatedBy: opts.actorId,
  };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function slotAt(day: Date, hourUtc: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc, 0, 0, 0));
}

/** First run at `hourUtc` that is not before `t`. */
function firstSlotFrom(t: Date, hourUtc: number): Date {
  const same = slotAt(t, hourUtc);
  return same.getTime() >= t.getTime() ? same : slotAt(new Date(t.getTime() + DAY), hourUtc);
}

/** `t` plus one calendar month, keeping the day of month where it exists (Jan 31 → Feb 28/29). */
export function addOneMonth(t: Date): Date {
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(t.getUTCDate(), lastDay), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()));
}

/**
 * When the next scheduled backup is due.
 *
 * - With a previous scheduled attempt (successful or not), the next one is
 *   the first `hourUtc` slot at least one interval later, less 12 hours, so
 *   moving the hour takes effect on the following slot instead of skipping
 *   a whole interval, and a run is never repeated within the same slot.
 * - With none yet, it is the first slot after the schedule was switched on.
 */
export function computeNextBackupRun(
  settings: Pick<DatabaseBackupSettings, 'enabled' | 'schedule' | 'hourUtc' | 'scheduleAnchor'>,
  lastScheduledAt: Date | null,
): Date | null {
  if (!settings.enabled) return null;
  const anchor = settings.scheduleAnchor ? new Date(settings.scheduleAnchor) : null;
  const anchorOk = anchor && Number.isFinite(anchor.getTime()) ? anchor : null;
  // A schedule changed after the last run starts counting again from the change.
  const last = lastScheduledAt && (!anchorOk || lastScheduledAt.getTime() >= anchorOk.getTime()) ? lastScheduledAt : null;
  if (!last) return anchorOk ? firstSlotFrom(anchorOk, settings.hourUtc) : null;
  const next =
    settings.schedule === 'monthly'
      ? addOneMonth(last)
      : new Date(last.getTime() + (settings.schedule === 'weekly' ? 7 : 1) * DAY);
  return firstSlotFrom(new Date(next.getTime() - 12 * HOUR), settings.hourUtc);
}
