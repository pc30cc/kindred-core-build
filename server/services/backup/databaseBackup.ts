/**
 * Database backups for Super Admin → Database → Backup.
 *
 * A backup is a full `pg_dump --format=custom` of the database the server
 * runs on, made by the backend itself:
 *
 *   1. pg_dump writes the archive to a private temp directory;
 *   2. pg_restore reads it back completely (TOC and every data block), so a
 *      truncated or corrupt archive is never recorded as a backup;
 *   3. it is kept on this server's disk (`local`), or encrypted
 *      (./backupCrypto.ts) and sent to a storage vendor from the storage
 *      pool (`storage`) or to the operator's FTP/FTPS server (`ftp`);
 *   4. the run is recorded in `backup_runs` (kind `logical`), which the
 *      backup-health panel already reads.
 *
 * One backup at a time across replicas: a lease in app_runtime_config
 * (`database_backup_lock`), renewed every minute while a run is alive, so a
 * crashed run frees it within minutes. The scheduler ticks every 5 minutes
 * and runs a backup when one is due (./databaseBackupSettings.ts).
 *
 * The connection: BACKUP_DATABASE_URL (a read-only role made for backups,
 * see docs/operations/DATABASE_BACKUPS.md) or else DATABASE_URL with the
 * server's DATABASE_ROLE. It reaches pg_dump through PG* environment
 * variables, never the command line, and no error recorded here may carry a
 * credential (the backup_runs trigger rejects one anyway).
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { decryptPluginSecret } from '../../lib/pluginCrypto.js';
import { readStoragePool } from '../storage/pool.js';
import {
  deleteWithConfig,
  downloadWithConfig,
  storageConfigFromRecord,
  SUPPORTED_STORAGE_PROVIDERS,
  uploadWithConfig,
  type StorageConfig,
} from '../storage/index.js';
import { decryptBackupBuffer, encryptBackupFile, isBackupEncryptionReady } from './backupCrypto.js';
import { FtpClient } from './ftpClient.js';
import {
  BACKUP_SETTINGS_KEY,
  computeNextBackupRun,
  isFtpConfigured,
  normalizeBackupSettings,
  normalizeFtpHost,
  normalizeFtpPath,
  backupSettingsView,
  type BackupDestination,
  type BackupSettingsUpdate,
  type DatabaseBackupSettings,
  type DatabaseBackupSettingsView,
  type FtpSettings,
} from './databaseBackupSettings.js';

export const BACKUP_SOURCE = 'database_backup';
const LOCK_KEY = 'database_backup_lock';
const LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 60_000;
const SCHEDULER_TICK_MS = 5 * 60_000;
const STORAGE_PREFIX = 'backups/database';
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DUMP_TIMEOUT_MS = intEnv('BACKUP_PG_DUMP_TIMEOUT_MS', 60 * 60_000);
/** Largest encrypted backup sent to (or fetched from) a storage vendor or FTP, which goes through memory. */
const MAX_REMOTE_BYTES = intEnv('BACKUP_MAX_REMOTE_MB', 2048) * 1024 * 1024;

export class DatabaseBackupError extends Error {
  constructor(public code: string, public status = 400, public detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DatabaseBackupError';
  }
}

export type BackupTrigger = 'manual' | 'schedule';

export type BackupLocation =
  | { type: 'local'; file: string }
  | { type: 'storage'; provider: string; key: string }
  | {
      type: 'ftp';
      host: string;
      port: number;
      username: string;
      dir: string;
      file: string;
      secure: boolean;
    };

export interface DatabaseBackupRow {
  id: string;
  backup_id: string;
  kind: string;
  status: 'running' | 'succeeded' | 'failed';
  started_at: string;
  finished_at: string | null;
  bytes: number | null;
  checksum: string | null;
  destination: string | null;
  encrypted: boolean;
  verification_status: string;
  verified_at: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface BackupRunView {
  id: string;
  backupId: string;
  status: DatabaseBackupRow['status'];
  trigger: BackupTrigger;
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

export function toRunView(row: DatabaseBackupRow): BackupRunView {
  const m = row.metadata ?? {};
  const location = m.location as BackupLocation | undefined;
  const prunedAt = typeof m.pruned_at === 'string' ? m.pruned_at : null;
  return {
    id: row.id,
    backupId: row.backup_id,
    status: row.status,
    trigger: m.trigger === 'schedule' ? 'schedule' : 'manual',
    destinationType: (m.destination_type as BackupDestination | undefined) ?? location?.type ?? null,
    destination: row.destination,
    storageProvider: typeof m.storage_provider === 'string' ? m.storage_provider : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : null,
    bytes: row.bytes,
    encrypted: row.encrypted,
    verified: row.verification_status === 'verified',
    tocEntries: typeof m.toc_entries === 'number' ? m.toc_entries : null,
    error: row.error,
    prunedAt,
    downloadable: row.status === 'succeeded' && !prunedAt && !!location,
  };
}

// ── Connection and tools ─────────────────────────────────────────────────

export interface DumpConnection {
  /** PG* variables for pg_dump; PGPASSWORD is the only secret. */
  env: Record<string, string>;
  /** `--role` for pg_dump, when the login role must switch to one that can read everything. */
  role: string | null;
  credential: 'backup_url' | 'database_url';
}

const LIBPQ_SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

/** Turns BACKUP_DATABASE_URL (preferred) or DATABASE_URL into libpq environment variables. */
export function resolveDumpConnection(env: NodeJS.ProcessEnv = process.env): DumpConnection | null {
  const backupUrl = env.BACKUP_DATABASE_URL?.trim();
  const raw = backupUrl || env.DATABASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  const out: Record<string, string> = {
    PGHOST: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    PGAPPNAME: 'webyar-backup',
    PGCONNECT_TIMEOUT: '20',
  };
  if (url.password) out.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode')?.toLowerCase();
  if (sslmode === 'no-verify') out.PGSSLMODE = 'require';
  else if (sslmode && LIBPQ_SSLMODES.has(sslmode)) out.PGSSLMODE = sslmode;
  else if (url.searchParams.get('ssl') === 'true') out.PGSSLMODE = 'require';

  let role: string | null;
  if (backupUrl) {
    const r = env.BACKUP_DATABASE_ROLE?.trim();
    role = r && r.toLowerCase() !== 'none' ? r : null;
  } else {
    const r = env.DATABASE_ROLE?.trim();
    role = r === undefined || r === '' ? 'service_role' : r.toLowerCase() === 'none' ? null : r;
  }
  return { env: out, role, credential: backupUrl ? 'backup_url' : 'database_url' };
}

const CREDENTIAL_WORDS = /(password|passwd|secret_access_key|aws_secret|private_key|service_role_key)\s*[:=]\s*\S*/gi;

/** Removes known secrets and anything shaped like a credential, and caps the length. */
export function sanitizeBackupError(message: string, secrets: (string | null | undefined)[] = []): string {
  let out = String(message ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  out = out
    .replace(/:\/\/[^/\s@]*@/g, '://***@')
    .replace(CREDENTIAL_WORDS, '[redacted]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > 1000 ? `${out.slice(0, 997)}...` : out;
}

function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LC_ALL: 'C',
    TZ: 'UTC',
    ...extra,
  };
}

interface ToolResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

function runTool(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; onStdout?: (chunk: Buffer) => void },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { env: opts.env, stdio: ['ignore', opts.onStdout ? 'pipe' : 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    }, opts.timeoutMs);
    if (opts.onStdout) child.stdout?.on('data', opts.onStdout);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => done({ code: null, stderr, timedOut, spawnError: err.message }));
    child.on('close', (code) => done({ code, stderr, timedOut, spawnError: null }));
  });
}

const pgDumpBin = () => process.env.PG_DUMP_PATH?.trim() || 'pg_dump';
const pgRestoreBin = () => process.env.PG_RESTORE_PATH?.trim() || 'pg_restore';

export interface BackupTools {
  pgDump: string | null;
  pgRestore: string | null;
}

let toolsCache: { at: number; value: BackupTools } | null = null;

async function toolVersion(bin: string): Promise<string | null> {
  let out = '';
  const r = await runTool(bin, ['--version'], {
    env: toolEnv(),
    timeoutMs: 10_000,
    onStdout: (c) => { out += c.toString('utf8'); },
  });
  return r.code === 0 ? out.trim().split('\n')[0] || null : null;
}

export async function detectBackupTools(): Promise<BackupTools> {
  if (toolsCache && Date.now() - toolsCache.at < 60_000) return toolsCache.value;
  const [pgDump, pgRestore] = await Promise.all([toolVersion(pgDumpBin()), toolVersion(pgRestoreBin())]);
  const value = { pgDump, pgRestore };
  toolsCache = { at: Date.now(), value };
  return value;
}

function toolFailure(what: string, r: ToolResult, secrets: (string | undefined)[]): DatabaseBackupError {
  if (r.spawnError) return new DatabaseBackupError('pg_dump_unavailable', 503, sanitizeBackupError(r.spawnError, secrets));
  if (r.timedOut) return new DatabaseBackupError(`${what}_timeout`, 500);
  const lines = r.stderr.trim().split('\n').filter(Boolean);
  return new DatabaseBackupError(`${what}_failed`, 500, sanitizeBackupError(lines.slice(-6).join(' | '), secrets));
}

// ── Local directory ──────────────────────────────────────────────────────

export function localBackupDir(): string {
  return path.resolve(process.env.BACKUP_LOCAL_DIR?.trim() || path.join(process.cwd(), 'data', 'backups', 'database'));
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** The longest mount point containing `dir`, from /proc/self/mountinfo (Linux only). */
async function mountPointOf(dir: string): Promise<string | null> {
  try {
    const text = await fs.readFile('/proc/self/mountinfo', 'utf8');
    let best: string | null = null;
    for (const line of text.split('\n')) {
      const field = line.split(' ')[4];
      if (!field) continue;
      const mp = field.replace(/\\040/g, ' ');
      const prefix = mp.endsWith('/') ? mp : `${mp}/`;
      if ((dir === mp || dir.startsWith(prefix)) && (!best || mp.length > best.length)) best = mp;
    }
    return best;
  } catch {
    return null;
  }
}

export interface LocalStatus {
  dir: string;
  /** False when the directory is inside the container's own filesystem and disappears on redeploy. */
  persistent: boolean | null;
  freeBytes: number | null;
  writable: boolean;
}

export async function localBackupStatus(): Promise<LocalStatus> {
  const dir = localBackupDir();
  let writable = false;
  let real = dir;
  try {
    await ensurePrivateDir(dir);
    real = await fs.realpath(dir);
    await fs.access(real, 2 /* W_OK */);
    writable = true;
  } catch {
    writable = false;
  }
  const mp = await mountPointOf(real);
  let freeBytes: number | null = null;
  try {
    const st = await fs.statfs(real);
    freeBytes = Number(st.bavail) * Number(st.bsize);
  } catch {
    freeBytes = null;
  }
  return { dir, persistent: mp === null ? null : mp !== '/', freeBytes, writable };
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function localPathOf(file: string): string {
  if (!SAFE_FILE.test(file)) throw new DatabaseBackupError('backup_location_invalid', 500);
  const dir = localBackupDir();
  const full = path.join(dir, file);
  if (path.dirname(full) !== dir) throw new DatabaseBackupError('backup_location_invalid', 500);
  return full;
}

// ── Settings ─────────────────────────────────────────────────────────────

export async function getBackupSettings(config: ServerConfig): Promise<DatabaseBackupSettings> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('app_runtime_config').select('value').eq('key', BACKUP_SETTINGS_KEY).maybeSingle();
  if (error) throw new DatabaseBackupError('backup_settings_read_failed', 500, error.message);
  return normalizeBackupSettings((data as { value?: unknown } | null)?.value);
}

export async function saveBackupSettings(config: ServerConfig, settings: DatabaseBackupSettings): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('app_runtime_config')
    .upsert({ key: BACKUP_SETTINGS_KEY, value: settings }, { onConflict: 'key' });
  if (error) throw new DatabaseBackupError('backup_settings_save_failed', 500, error.message);
}

// ── Destinations ─────────────────────────────────────────────────────────

const STORAGE_SCHEME: Record<string, string> = {
  bunny_storage: 'bunny',
  s3: 's3',
  arvan_storage: 's3',
  do_spaces: 's3',
  cloudflare_r2: 'r2',
  minio: 'minio',
  gcs: 'gs',
  azure_blob: 'azure',
};

/** A credential-free label for the backup_runs.destination column. */
export function destinationLabel(location: BackupLocation, storage?: StorageConfig | null): string {
  if (location.type === 'local') return `file://${localPathOf(location.file)}`;
  if (location.type === 'storage') {
    const scheme = STORAGE_SCHEME[location.provider] ?? location.provider.replace(/[^a-z0-9]/gi, '');
    const container = (location.provider === 'bunny_storage' ? storage?.storageZone : storage?.bucket) || location.provider;
    return `${scheme}://${container}/${location.key}`;
  }
  const dir = location.dir.replace(/^\/+|\/+$/g, '');
  return `${location.secure ? 'ftps' : 'ftp'}://${location.host}:${location.port}/${dir ? `${dir}/` : ''}${location.file}`;
}

export interface StorageVendor {
  name: string;
  primary: boolean;
  enabled: boolean;
}

export async function backupStorageVendors(config: ServerConfig): Promise<StorageVendor[]> {
  const pool = await readStoragePool(config);
  return Object.entries(pool.providers)
    .filter(([name]) => name !== 'local' && SUPPORTED_STORAGE_PROVIDERS.includes(name))
    .map(([name, entry]) => ({ name, primary: pool.primary === name, enabled: entry.enabled }));
}

async function storageTarget(config: ServerConfig, provider: string | null | undefined): Promise<StorageConfig> {
  if (!provider || provider === 'local' || !SUPPORTED_STORAGE_PROVIDERS.includes(provider)) {
    throw new DatabaseBackupError('storage_provider_invalid');
  }
  const pool = await readStoragePool(config);
  const entry = pool.providers[provider];
  if (!entry) throw new DatabaseBackupError('storage_provider_not_configured');
  return { ...storageConfigFromRecord(provider, entry.config), maxFileSizeMB: Math.ceil(MAX_REMOTE_BYTES / 1024 / 1024) };
}

function storageSecrets(sc: StorageConfig | null | undefined): (string | undefined)[] {
  return sc ? [sc.secretAccessKey, sc.apiKey, sc.accessKeyId] : [];
}

interface FtpTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  dir: string;
  secure: boolean;
  verifyTls: boolean;
}

function ftpTargetFromSettings(ftp: FtpSettings, masterKey: string | undefined): FtpTarget {
  if (!isFtpConfigured(ftp)) throw new DatabaseBackupError('ftp_settings_incomplete');
  let password: string;
  try {
    password = decryptPluginSecret(ftp.password!, masterKey);
  } catch {
    throw new DatabaseBackupError('ftp_password_unreadable');
  }
  return { host: ftp.host, port: ftp.port, username: ftp.username, password, dir: ftp.path, secure: ftp.secure, verifyTls: ftp.verifyTls };
}

async function withFtp<T>(target: FtpTarget, fn: (client: FtpClient) => Promise<T>): Promise<T> {
  let client: FtpClient;
  try {
    client = await FtpClient.connect({
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password,
      secure: target.secure,
      verifyTls: target.verifyTls,
      timeoutMs: 30_000,
    });
  } catch (err) {
    throw new DatabaseBackupError((err as { code?: string }).code ?? 'ftp_connect_failed', 502, sanitizeBackupError((err as Error).message, [target.password]));
  }
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof DatabaseBackupError) throw err;
    throw new DatabaseBackupError((err as { code?: string }).code ?? 'ftp_failed', 502, sanitizeBackupError((err as Error).message, [target.password]));
  } finally {
    await client.close();
  }
}

/** The stored FTP settings, when the backup was sent with the same server and login. */
function ftpTargetForLocation(location: Extract<BackupLocation, { type: 'ftp' }>, settings: DatabaseBackupSettings, masterKey: string | undefined): FtpTarget {
  const ftp = settings.ftp;
  if (ftp.host !== location.host || ftp.port !== location.port || ftp.username !== location.username) {
    throw new DatabaseBackupError('ftp_credentials_changed', 409);
  }
  return { ...ftpTargetFromSettings(ftp, masterKey), dir: location.dir };
}

// ── Lease ────────────────────────────────────────────────────────────────

async function acquireLease(config: ServerConfig): Promise<boolean> {
  const sb = getServiceClient(config);
  const now = new Date();
  const value = { lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), holder: INSTANCE_ID };
  const { data: existing, error } = await sb.from('app_runtime_config').select('key').eq('key', LOCK_KEY).maybeSingle();
  if (error) throw new DatabaseBackupError('backup_lock_failed', 500, error.message);
  if (!existing) {
    const { error: insertError } = await sb.from('app_runtime_config').insert({ key: LOCK_KEY, value: value });
    // A concurrent instance may have inserted first; the conditional update below then refuses.
    if (!insertError) return true;
  }
  const { data } = await sb
    .from('app_runtime_config')
    .update({ value: value })
    .eq('key', LOCK_KEY)
    .lt('value->>lease_until', now.toISOString())
    .select('key');
  return Array.isArray(data) && data.length > 0;
}

async function renewLease(config: ServerConfig): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('app_runtime_config')
    .update({ value: { lease_until: new Date(Date.now() + LEASE_MS).toISOString(), holder: INSTANCE_ID } })
    .eq('key', LOCK_KEY)
    .eq('value->>holder', INSTANCE_ID);
}

async function releaseLease(config: ServerConfig): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb
      .from('app_runtime_config')
      .update({ value: { lease_until: new Date(0).toISOString(), holder: null } })
      .eq('key', LOCK_KEY)
      .eq('value->>holder', INSTANCE_ID);
  } catch {
    /* it expires on its own */
  }
}

async function leaseHeld(config: ServerConfig): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('app_runtime_config').select('value').eq('key', LOCK_KEY).maybeSingle();
  const until = (data as { value?: { lease_until?: string } } | null)?.value?.lease_until;
  return !!until && new Date(until).getTime() > Date.now();
}

// ── Runs ─────────────────────────────────────────────────────────────────

/** The run this process is working on, if any. */
let activeRunId: string | null = null;

export function activeBackupRunId(): string | null {
  return activeRunId && activeRunId !== 'starting' ? activeRunId : null;
}

function runsQuery(config: ServerConfig) {
  return getServiceClient(config).from('backup_runs').select('*').eq('kind', 'logical').eq('metadata->>source', BACKUP_SOURCE);
}

export async function listDatabaseBackups(config: ServerConfig, limit = 100): Promise<DatabaseBackupRow[]> {
  const { data, error } = await runsQuery(config).order('started_at', { ascending: false }).limit(limit);
  if (error) throw new DatabaseBackupError('backup_list_failed', 500, error.message);
  return (data ?? []) as DatabaseBackupRow[];
}

export async function getDatabaseBackup(config: ServerConfig, id: string): Promise<DatabaseBackupRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DatabaseBackupError('backup_not_found', 404);
  const { data, error } = await runsQuery(config).eq('id', id).maybeSingle();
  if (error) throw new DatabaseBackupError('backup_read_failed', 500, error.message);
  if (!data) throw new DatabaseBackupError('backup_not_found', 404);
  return data as DatabaseBackupRow;
}

export async function lastScheduledAttempt(config: ServerConfig): Promise<Date | null> {
  const { data, error } = await runsQuery(config)
    .eq('metadata->>trigger', 'schedule')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw new DatabaseBackupError('backup_list_failed', 500, error.message);
  const row = (data as DatabaseBackupRow[] | null)?.[0];
  return row ? new Date(row.started_at) : null;
}

async function updateRun(config: ServerConfig, id: string, patch: Partial<DatabaseBackupRow>): Promise<DatabaseBackupRow> {
  const { data, error } = await getServiceClient(config).from('backup_runs').update(patch).eq('id', id).select().single();
  if (error) throw new DatabaseBackupError('backup_record_failed', 500, error.message);
  return data as DatabaseBackupRow;
}

/** Marks `running` rows that no live run owns (a container restarted mid-backup) as failed. */
export async function reapInterruptedRuns(config: ServerConfig): Promise<number> {
  const { data } = await runsQuery(config).eq('status', 'running').limit(20);
  const stale = ((data ?? []) as DatabaseBackupRow[]).filter((r) => r.id !== activeRunId);
  if (!stale.length) return 0;
  if (activeRunId === null && (await leaseHeld(config))) return 0; // another instance may own them
  for (const row of stale) {
    await updateRun(config, row.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: 'interrupted',
    }).catch(() => undefined);
  }
  return stale.length;
}

function stamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}Z`;
}

async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export interface StartBackupOptions {
  trigger: BackupTrigger;
  actorId: string | null;
  /** Overrides the saved destination for this one (manual) run. */
  destination?: BackupDestination;
  storageProvider?: string | null;
}

interface RunContext {
  config: ServerConfig;
  run: DatabaseBackupRow;
  settings: DatabaseBackupSettings;
  destination: BackupDestination;
  storage: StorageConfig | null;
  storageProvider: string | null;
  ftp: FtpTarget | null;
  conn: DumpConnection;
  pgDumpVersion: string;
}

/**
 * Starts a backup and returns its `running` row at once; `job` settles with
 * the final row and never rejects (a failure is recorded on the row).
 */
export async function startDatabaseBackup(
  config: ServerConfig,
  opts: StartBackupOptions,
): Promise<{ run: DatabaseBackupRow; job: Promise<DatabaseBackupRow> }> {
  if (activeRunId) throw new DatabaseBackupError('backup_already_running', 409);
  const settings = await getBackupSettings(config);
  const destination = opts.destination ?? settings.destination;
  const storageProvider = destination === 'storage' ? (opts.storageProvider ?? settings.storageProvider) : null;

  const tools = await detectBackupTools();
  if (!tools.pgDump || !tools.pgRestore) throw new DatabaseBackupError('pg_dump_unavailable', 503);
  const conn = resolveDumpConnection();
  if (!conn) throw new DatabaseBackupError('database_url_missing', 503);
  const masterKey = config.pluginSecretsMasterKey;
  if (destination !== 'local' && !isBackupEncryptionReady(masterKey)) throw new DatabaseBackupError('encryption_key_missing');
  const storage = destination === 'storage' ? await storageTarget(config, storageProvider) : null;
  const ftp = destination === 'ftp' ? ftpTargetFromSettings(settings.ftp, masterKey) : null;

  activeRunId = 'starting';
  let run: DatabaseBackupRow;
  try {
    if (!(await acquireLease(config))) throw new DatabaseBackupError('backup_already_running', 409);
    try {
      await reapInterruptedRuns(config);
      const startedAt = new Date();
      const backupId = `webyar-db-${stamp(startedAt)}-${randomBytes(4).toString('hex')}`;
      const { data, error } = await getServiceClient(config)
        .from('backup_runs')
        .insert({
          backup_id: backupId,
          kind: 'logical',
          status: 'running',
          started_at: startedAt.toISOString(),
          encrypted: destination !== 'local',
          metadata: {
            source: BACKUP_SOURCE,
            trigger: opts.trigger,
            actor_id: opts.actorId,
            destination_type: destination,
            storage_provider: storageProvider,
            credential: conn.credential,
          },
        })
        .select()
        .single();
      if (error) throw new DatabaseBackupError('backup_record_failed', 500, error.message);
      run = data as DatabaseBackupRow;
    } catch (err) {
      await releaseLease(config);
      throw err;
    }
  } catch (err) {
    activeRunId = null;
    throw err;
  }
  activeRunId = run.id;

  const job = executeBackup({
    config,
    run,
    settings,
    destination,
    storage,
    storageProvider,
    ftp,
    conn,
    pgDumpVersion: tools.pgDump,
  });
  return { run, job };
}

async function executeBackup(ctx: RunContext): Promise<DatabaseBackupRow> {
  const { config, run, conn } = ctx;
  const t0 = Date.now();
  const secrets = [conn.env.PGPASSWORD, ctx.ftp?.password, ...storageSecrets(ctx.storage)];
  const heartbeat = setInterval(() => {
    renewLease(config).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const dir = localBackupDir();
  const tmpDir = path.join(dir, '.tmp');
  const dumpPath = path.join(tmpDir, `${run.backup_id}.dump`);
  const encPath = `${dumpPath}.enc`;
  try {
    await ensurePrivateDir(dir);
    await ensurePrivateDir(tmpDir);

    // 1. Dump.
    const dumpArgs = ['--format=custom', '--compress=6', '--no-password', '--lock-wait-timeout=60s', `--file=${dumpPath}`];
    if (conn.role) dumpArgs.push(`--role=${conn.role}`);
    const dump = await runTool(pgDumpBin(), dumpArgs, { env: toolEnv(conn.env), timeoutMs: DUMP_TIMEOUT_MS });
    if (dump.code !== 0) throw toolFailure('pg_dump', dump, secrets);
    await fs.chmod(dumpPath, 0o600);

    // 2. Read the archive back completely before calling it a backup.
    let tocEntries = 0;
    let tail = '';
    const list = await runTool(pgRestoreBin(), ['--list', dumpPath], {
      env: toolEnv(),
      timeoutMs: 10 * 60_000,
      onStdout: (chunk) => {
        const lines = (tail + chunk.toString('utf8')).split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) if (line.trim() && !line.startsWith(';')) tocEntries += 1;
      },
    });
    if (tail.trim() && !tail.startsWith(';')) tocEntries += 1;
    if (list.code !== 0) throw toolFailure('pg_restore_list', list, secrets);
    if (tocEntries === 0) throw new DatabaseBackupError('backup_archive_empty', 500);
    const readBack = await runTool(pgRestoreBin(), ['--file=/dev/null', dumpPath], { env: toolEnv(), timeoutMs: DUMP_TIMEOUT_MS });
    if (readBack.code !== 0) throw toolFailure('pg_restore_verify', readBack, secrets);
    const dumpSum = await sha256File(dumpPath);
    const verifiedAt = new Date().toISOString();

    // 3. Deliver.
    let location: BackupLocation;
    let artifact = dumpSum;
    if (ctx.destination === 'local') {
      const file = `${run.backup_id}.dump`;
      await fs.rename(dumpPath, localPathOf(file));
      location = { type: 'local', file };
    } else {
      await encryptBackupFile(dumpPath, encPath, config.pluginSecretsMasterKey);
      artifact = await sha256File(encPath);
      if (artifact.bytes > MAX_REMOTE_BYTES) throw new DatabaseBackupError('backup_too_large_for_remote', 500);
      const file = `${run.backup_id}.dump.enc`;
      if (ctx.destination === 'storage') {
        const key = `${STORAGE_PREFIX}/${file}`;
        const result = await uploadWithConfig(ctx.storage!, {
          fileKey: key,
          data: await fs.readFile(encPath),
          contentType: 'application/octet-stream',
        });
        if (!result.success) {
          throw new DatabaseBackupError('storage_upload_failed', 502, sanitizeBackupError(result.error ?? '', secrets));
        }
        location = { type: 'storage', provider: ctx.storageProvider!, key };
      } else {
        const ftp = ctx.ftp!;
        await withFtp(ftp, async (client) => {
          await client.ensureDir(ftp.dir);
          const sent = await client.upload(file, createReadStream(encPath));
          if (sent !== artifact.bytes) throw new DatabaseBackupError('ftp_upload_incomplete', 502);
        });
        location = {
          type: 'ftp',
          host: ftp.host,
          port: ftp.port,
          username: ftp.username,
          dir: ftp.dir,
          file,
          secure: ftp.secure,
        };
      }
    }

    const metadata: Record<string, unknown> = {
      ...run.metadata,
      format: 'pg_dump-custom',
      pg_dump_version: ctx.pgDumpVersion,
      toc_entries: tocEntries,
      dump_bytes: dumpSum.bytes,
      dump_sha256: dumpSum.sha256,
      artifact_bytes: artifact.bytes,
      artifact_sha256: artifact.sha256,
      encryption: ctx.destination === 'local' ? null : 'aes-256-gcm/hkdf-sha256',
      duration_ms: Date.now() - t0,
      location,
    };
    let done = await updateRun(config, run.id, {
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      bytes: dumpSum.bytes,
      checksum: `sha256:${dumpSum.sha256}`,
      destination: destinationLabel(location, ctx.storage),
      verification_status: 'verified',
      verified_at: verifiedAt,
      error: null,
      metadata,
    });

    // 4. Retention, never failing the backup that just succeeded.
    try {
      await pruneOldBackups(config, ctx.settings, done.id);
    } catch (err) {
      done = await updateRun(config, run.id, {
        metadata: { ...metadata, prune_error: sanitizeBackupError((err as Error).message, secrets) },
      }).catch(() => done);
    }
    return done;
  } catch (err) {
    const e = err instanceof DatabaseBackupError ? err : new DatabaseBackupError('backup_failed', 500, (err as Error).message);
    const message = sanitizeBackupError(e.detail ? `${e.code}: ${e.detail}` : e.code, secrets);
    console.warn(`[db-backup] ${run.backup_id} failed: ${message}`);
    const failed = { status: 'failed' as const, finished_at: new Date().toISOString(), metadata: { ...run.metadata, duration_ms: Date.now() - t0 } };
    try {
      return await updateRun(config, run.id, { ...failed, error: message });
    } catch {
      // The credential guard on backup_runs refused the message: record the code alone.
      return await updateRun(config, run.id, { ...failed, error: e.code }).catch(() => ({ ...run, ...failed, error: e.code }));
    }
  } finally {
    clearInterval(heartbeat);
    await fs.rm(dumpPath, { force: true }).catch(() => undefined);
    await fs.rm(encPath, { force: true }).catch(() => undefined);
    await releaseLease(config);
    activeRunId = null;
  }
}

// ── Artifacts: remove, download ──────────────────────────────────────────

async function removeArtifact(config: ServerConfig, row: DatabaseBackupRow, settings: DatabaseBackupSettings): Promise<void> {
  const location = row.metadata?.location as BackupLocation | undefined;
  if (!location || row.metadata?.pruned_at) return;
  if (location.type === 'local') {
    await fs.rm(localPathOf(location.file), { force: true });
    return;
  }
  if (location.type === 'storage') {
    const sc = await storageTarget(config, location.provider);
    const result = await deleteWithConfig(sc, location.key);
    if (!result.success && result.httpStatus !== 404) {
      throw new DatabaseBackupError('storage_delete_failed', 502, sanitizeBackupError(result.error ?? '', storageSecrets(sc)));
    }
    return;
  }
  const target = ftpTargetForLocation(location, settings, config.pluginSecretsMasterKey);
  await withFtp(target, async (client) => {
    await client.ensureDir(location.dir, false);
    await client.remove(location.file);
  });
}

/**
 * Removes the files of successful backups older than the retention window.
 * The newest successful backup is always kept, and each record stays in the
 * history marked as removed. A backup on a destination that can no longer be
 * reached (another FTP login, a vendor taken out of the pool) is left alone.
 */
export async function pruneOldBackups(config: ServerConfig, settings: DatabaseBackupSettings, keepId: string): Promise<number> {
  const cutoff = new Date(Date.now() - settings.retentionDays * 24 * 3600_000).toISOString();
  const { data, error } = await runsQuery(config)
    .eq('status', 'succeeded')
    .lt('started_at', cutoff)
    .order('started_at', { ascending: true })
    .limit(200);
  if (error) throw new DatabaseBackupError('backup_list_failed', 500, error.message);
  const { data: newest } = await runsQuery(config).eq('status', 'succeeded').order('started_at', { ascending: false }).limit(1);
  const newestId = (newest as DatabaseBackupRow[] | null)?.[0]?.id;
  let pruned = 0;
  const failures: string[] = [];
  for (const row of (data ?? []) as DatabaseBackupRow[]) {
    if (row.id === keepId || row.id === newestId || row.metadata?.pruned_at) continue;
    try {
      await removeArtifact(config, row, settings);
    } catch (err) {
      const code = err instanceof DatabaseBackupError ? err.code : 'prune_failed';
      if (code !== 'ftp_credentials_changed' && code !== 'storage_provider_not_configured') failures.push(`${row.backup_id}: ${code}`);
      continue;
    }
    await updateRun(config, row.id, { metadata: { ...row.metadata, pruned_at: new Date().toISOString() } });
    pruned += 1;
  }
  if (failures.length) throw new DatabaseBackupError('prune_incomplete', 500, failures.slice(0, 5).join(', '));
  return pruned;
}

export async function deleteDatabaseBackup(config: ServerConfig, id: string, opts: { force?: boolean } = {}): Promise<void> {
  const row = await getDatabaseBackup(config, id);
  if (row.status === 'running') throw new DatabaseBackupError('backup_running', 409);
  if (row.status === 'succeeded') {
    try {
      await removeArtifact(config, row, await getBackupSettings(config));
    } catch (err) {
      if (!opts.force) {
        const e = err instanceof DatabaseBackupError ? err : new DatabaseBackupError('backup_artifact_delete_failed', 502, (err as Error).message);
        throw new DatabaseBackupError('backup_artifact_delete_failed', 502, e.detail ? `${e.code}: ${e.detail}` : e.code);
      }
    }
  }
  const { error } = await getServiceClient(config).from('backup_runs').delete().eq('id', row.id);
  if (error) throw new DatabaseBackupError('backup_delete_failed', 500, error.message);
}

export interface BackupDownload {
  fileName: string;
  bytes: number;
  stream: Readable;
}

/** The plain pg_dump archive of a backup, decrypted and checked against its recorded checksum. */
export async function downloadDatabaseBackup(config: ServerConfig, id: string): Promise<BackupDownload> {
  const row = await getDatabaseBackup(config, id);
  const location = row.metadata?.location as BackupLocation | undefined;
  if (row.status !== 'succeeded' || !location) throw new DatabaseBackupError('backup_not_downloadable', 409);
  if (row.metadata?.pruned_at) throw new DatabaseBackupError('backup_pruned', 410);
  const fileName = `${row.backup_id}.dump`;

  if (location.type === 'local') {
    const file = localPathOf(location.file);
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      throw new DatabaseBackupError('backup_file_missing', 404);
    }
    return { fileName, bytes: size, stream: createReadStream(file) };
  }

  let encrypted: Buffer;
  if (location.type === 'storage') {
    const sc = await storageTarget(config, location.provider);
    const result = await downloadWithConfig(sc, location.key);
    if (!result.success || !result.data) {
      throw new DatabaseBackupError('storage_download_failed', 502, sanitizeBackupError(result.error ?? '', storageSecrets(sc)));
    }
    encrypted = result.data;
  } else {
    const target = ftpTargetForLocation(location, await getBackupSettings(config), config.pluginSecretsMasterKey);
    encrypted = await withFtp(target, async (client) => {
      await client.ensureDir(location.dir, false);
      return client.download(location.file);
    });
  }
  const artifactSha = row.metadata?.artifact_sha256;
  if (typeof artifactSha === 'string' && createHash('sha256').update(encrypted).digest('hex') !== artifactSha) {
    throw new DatabaseBackupError('backup_checksum_mismatch', 502);
  }
  let plain: Buffer;
  try {
    plain = decryptBackupBuffer(encrypted, config.pluginSecretsMasterKey);
  } catch (err) {
    throw new DatabaseBackupError((err as { code?: string }).code ?? 'backup_decrypt_failed', 500);
  }
  const dumpSha = row.metadata?.dump_sha256;
  if (typeof dumpSha === 'string' && createHash('sha256').update(plain).digest('hex') !== dumpSha) {
    throw new DatabaseBackupError('backup_checksum_mismatch', 502);
  }
  return { fileName, bytes: plain.length, stream: Readable.from([plain]) };
}

// ── Destination test ─────────────────────────────────────────────────────

export interface DestinationTestInput {
  destination: BackupDestination;
  storageProvider?: string | null;
  /** Unsaved FTP settings from the form; a blank password means the stored one. */
  ftp?: BackupSettingsUpdate['ftp'];
}

export async function testBackupDestination(config: ServerConfig, input: DestinationTestInput): Promise<Record<string, unknown>> {
  const probe = `webyar-probe-${randomBytes(6).toString('hex')}`;
  const body = Buffer.from(`webyar backup destination test ${new Date().toISOString()}\n`);
  if (input.destination === 'local') {
    const status = await localBackupStatus();
    if (!status.writable) throw new DatabaseBackupError('local_dir_not_writable', 500);
    const file = localPathOf(probe);
    await fs.writeFile(file, body, { mode: 0o600 });
    await fs.rm(file, { force: true });
    return { ok: true, persistent: status.persistent, freeBytes: status.freeBytes };
  }
  if (!isBackupEncryptionReady(config.pluginSecretsMasterKey)) throw new DatabaseBackupError('encryption_key_missing');
  if (input.destination === 'storage') {
    const sc = await storageTarget(config, input.storageProvider);
    const key = `${STORAGE_PREFIX}/${probe}`;
    const up = await uploadWithConfig(sc, { fileKey: key, data: body, contentType: 'text/plain' });
    if (!up.success) throw new DatabaseBackupError('storage_upload_failed', 502, sanitizeBackupError(up.error ?? '', storageSecrets(sc)));
    const del = await deleteWithConfig(sc, key);
    return { ok: true, cleanedUp: del.success };
  }

  const saved = (await getBackupSettings(config)).ftp;
  const f = input.ftp;
  let target: FtpTarget;
  try {
    const host = f ? normalizeFtpHost(f.host ?? '') : saved.host;
    const username = f ? (f.username ?? '').trim() : saved.username;
    const sameLogin = host === saved.host && username === saved.username;
    let password = f?.password ?? '';
    if (!password) {
      if (!saved.password || !sameLogin) throw new DatabaseBackupError('ftp_settings_incomplete');
      password = ftpTargetFromSettings(saved, config.pluginSecretsMasterKey).password;
    }
    if (!host || !username) throw new DatabaseBackupError('ftp_settings_incomplete');
    target = {
      host,
      port: f?.port ?? saved.port,
      username,
      password,
      dir: f ? normalizeFtpPath(f.path ?? '') : saved.path,
      secure: f?.secure ?? saved.secure,
      verifyTls: f?.verifyTls ?? saved.verifyTls,
    };
  } catch (err) {
    if (err instanceof DatabaseBackupError) throw err;
    throw new DatabaseBackupError((err as { code?: string }).code ?? 'ftp_settings_incomplete');
  }
  await withFtp(target, async (client) => {
    await client.ensureDir(target.dir);
    await client.upload(probe, Readable.from([body]));
    await client.remove(probe);
  });
  return { ok: true };
}

// ── Status for the admin screen ──────────────────────────────────────────

export interface DatabaseBackupStatus {
  settings: DatabaseBackupSettingsView;
  nextRunAt: string | null;
  runningId: string | null;
  tools: BackupTools;
  connection: { credential: DumpConnection['credential']; role: string | null; database: string } | null;
  local: LocalStatus;
  encryptionReady: boolean;
  storageProviders: StorageVendor[];
  runs: BackupRunView[];
}

export async function databaseBackupStatus(config: ServerConfig): Promise<DatabaseBackupStatus> {
  await reapInterruptedRuns(config).catch(() => 0);
  const [settings, runs, tools, local, vendors, last] = await Promise.all([
    getBackupSettings(config),
    listDatabaseBackups(config),
    detectBackupTools(),
    localBackupStatus(),
    backupStorageVendors(config).catch(() => [] as StorageVendor[]),
    lastScheduledAttempt(config),
  ]);
  const conn = resolveDumpConnection();
  const next = computeNextBackupRun(settings, last);
  const running = runs.find((r) => r.status === 'running');
  return {
    settings: backupSettingsView(settings),
    nextRunAt: next ? next.toISOString() : null,
    runningId: running?.id ?? null,
    tools,
    connection: conn ? { credential: conn.credential, role: conn.role, database: conn.env.PGDATABASE } : null,
    local,
    encryptionReady: isBackupEncryptionReady(config.pluginSecretsMasterKey),
    storageProviders: vendors,
    runs: runs.map(toRunView),
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────

async function recordFailedScheduledRun(config: ServerConfig, settings: DatabaseBackupSettings, err: unknown): Promise<void> {
  const e = err instanceof DatabaseBackupError ? err : new DatabaseBackupError('backup_failed', 500, (err as Error)?.message);
  const now = new Date();
  const row = {
    backup_id: `webyar-db-${stamp(now)}-${randomBytes(4).toString('hex')}`,
    kind: 'logical',
    status: 'failed',
    started_at: now.toISOString(),
    finished_at: now.toISOString(),
    encrypted: false,
    metadata: { source: BACKUP_SOURCE, trigger: 'schedule', actor_id: null, destination_type: settings.destination },
  };
  const sb = getServiceClient(config);
  const message = sanitizeBackupError(e.detail ? `${e.code}: ${e.detail}` : e.code);
  const { error } = await sb.from('backup_runs').insert({ ...row, error: message });
  if (error) await sb.from('backup_runs').insert({ ...row, error: e.code });
}

/** One scheduler tick: runs a backup when the schedule says one is due. Exported for tests. */
export async function runScheduledBackupIfDue(config: ServerConfig, now = new Date()): Promise<'idle' | 'ran' | 'busy' | 'failed'> {
  if (activeRunId) return 'busy';
  const settings = await getBackupSettings(config);
  if (!settings.enabled) return 'idle';
  const next = computeNextBackupRun(settings, await lastScheduledAttempt(config));
  if (!next || next.getTime() > now.getTime()) return 'idle';
  try {
    const { job } = await startDatabaseBackup(config, { trigger: 'schedule', actorId: null });
    const done = await job;
    return done.status === 'succeeded' ? 'ran' : 'failed';
  } catch (err) {
    if (err instanceof DatabaseBackupError && err.code === 'backup_already_running') return 'busy';
    // Consume the slot so a broken setup is reported once per slot, not every tick.
    await recordFailedScheduledRun(config, settings, err).catch(() => undefined);
    return 'failed';
  }
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startDatabaseBackupScheduler(config: ServerConfig): void {
  if (schedulerTimer || process.env.DATABASE_BACKUP_SCHEDULER?.trim().toLowerCase() === 'off') return;
  const tick = () => {
    runScheduledBackupIfDue(config).catch((err) => {
      console.warn('[db-backup] scheduler tick failed:', sanitizeBackupError((err as Error).message));
    });
  };
  setTimeout(tick, 90_000).unref?.();
  schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
  schedulerTimer.unref?.();
  console.log('[db-backup] scheduler started');
}
