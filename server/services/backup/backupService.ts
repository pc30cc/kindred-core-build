/**
 * Backup & disaster-recovery service.
 *
 * WEBYAR does not implement its own PITR engine. PostgreSQL already archives
 * WAL continuously (see docs/BACKUP_AND_DISASTER_RECOVERY.md); this service is
 * the *observability and bookkeeping* layer around it:
 *
 *   - it reads live WAL-archiver state out of the database,
 *   - it keeps the registry of backup runs (base / wal / logical / object),
 *   - it derives one canonical set of alerts that both the worker and the
 *     Super Admin badge use, so they can never disagree,
 *   - it queues the two safe operator actions (backup now, verify latest).
 *
 * There is deliberately NO restore path here. Restoring production is a
 * controlled operational procedure, never an HTTP endpoint.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type BackupKind = 'base' | 'wal' | 'logical' | 'object';
export type BackupStatus = 'running' | 'succeeded' | 'failed';
export type VerificationStatus = 'unverified' | 'verified' | 'failed';
export type BackupHealthState = 'ok' | 'attention' | 'critical';

export class BackupError extends Error {
  constructor(public code: string, message?: string) {
    super(message || code);
  }
}

/** Recovery objectives. Targets, not guarantees — measured values live in the drill log. */
export const RPO_TARGET_SECONDS = 15 * 60;
export const RTO_TARGET_SECONDS = 60 * 60;

/** Freshness windows, per backup kind, in seconds. Configurable via env. */
export const MAX_AGE_SECONDS: Record<BackupKind, number> = {
  base: intEnv('BACKUP_MAX_AGE_BASE_SECONDS', 26 * 3600), // daily + 2h grace
  logical: intEnv('BACKUP_MAX_AGE_LOGICAL_SECONDS', 26 * 3600),
  object: intEnv('BACKUP_MAX_AGE_OBJECT_SECONDS', 7 * 26 * 3600), // weekly + grace
  wal: intEnv('BACKUP_MAX_AGE_WAL_SECONDS', RPO_TARGET_SECONDS),
};

/** A restore drill older than this means the recovery system is unproven. */
export const RESTORE_DRILL_MAX_AGE_SECONDS = intEnv('BACKUP_DRILL_MAX_AGE_SECONDS', 90 * 24 * 3600);

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface BackupRun {
  id: string;
  backup_id: string;
  kind: BackupKind;
  status: BackupStatus;
  started_at: string;
  finished_at: string | null;
  bytes: number | null;
  checksum: string | null;
  destination: string | null;
  lsn: string | null;
  encrypted: boolean;
  verification_status: VerificationStatus;
  verified_at: string | null;
  last_restore_tested_at: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface BackupHealthRow {
  kind: BackupKind;
  backup_id: string;
  status: BackupStatus;
  finished_at: string | null;
  age_seconds: number | null;
  bytes: number | null;
  encrypted: boolean;
  verification_status: VerificationStatus;
  verified_at: string | null;
  last_restore_tested_at: string | null;
  destination: string | null;
  lsn: string | null;
}

export interface WalStatus {
  archive_mode: string;
  wal_level: string;
  archive_timeout_seconds: number;
  archived_count: number;
  last_archived_wal: string | null;
  last_archived_time: string | null;
  archive_lag_seconds: number | null;
  failed_count: number;
  last_failed_wal: string | null;
  last_failed_time: string | null;
  stats_reset: string | null;
  current_lsn: string | null;
  database_bytes: number;
}

export interface RestoreDrill {
  id: string;
  drill_kind: 'full_restore' | 'pitr' | 'object_storage';
  environment: string;
  source_backup_id: string | null;
  target_time: string | null;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'passed' | 'failed';
  findings: Record<string, unknown>;
  notes: string | null;
}

export type BackupAlertCode =
  | 'backup_failed'
  | 'backup_missing'
  | 'backup_too_old'
  | 'backup_unverified'
  | 'verification_failed'
  | 'checksum_missing'
  | 'backup_not_encrypted'
  | 'backup_not_offsite'
  | 'wal_archiving_disabled'
  | 'wal_archive_failing'
  | 'wal_archive_lag'
  | 'restore_drill_overdue'
  | 'restore_drill_never';

export interface BackupAlert {
  scope: string;
  severity: 'warning' | 'critical';
  code: BackupAlertCode;
  detail?: string;
}

export interface BackupOverview {
  health: BackupHealthState;
  alerts: BackupAlert[];
  latest: BackupHealthRow[];
  wal: WalStatus | null;
  /** Oldest point PITR can currently reach: the oldest retained, verified base backup. */
  pitr: {
    window_start: string | null;
    window_end: string | null;
    /** Seconds of data at risk right now = WAL archive lag. */
    rpo_actual_seconds: number | null;
    rpo_target_seconds: number;
    rto_target_seconds: number;
  };
  lastDrills: RestoreDrill[];
  destinations: { kind: BackupKind; destination: string | null; offsite: boolean }[];
  /** Next scheduled run per kind, as declared by the host agent's schedule. */
  schedule: { kind: BackupKind; cron: string | null; next_run_at: string | null }[];
}

/** A destination is off-server when it is an object-storage URI, not a local path. */
export function isOffsite(destination: string | null | undefined): boolean {
  if (!destination) return false;
  return /^(s3|gs|b2|azure|r2|minio|swift):\/\//i.test(destination.trim());
}

async function rpc<T>(config: ServerConfig, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new BackupError('backup_rpc_failed', `${fn}: ${error.message}`);
  return data as T;
}

/**
 * The single source of truth for "is our recovery system healthy?".
 * Both the worker log and the admin badge render exactly this list.
 */
export function deriveAlerts(input: {
  latest: BackupHealthRow[];
  wal: WalStatus | null;
  lastDrills: RestoreDrill[];
  now?: Date;
}): BackupAlert[] {
  const alerts: BackupAlert[] = [];
  const byKind = new Map(input.latest.map((r) => [r.kind, r]));

  for (const kind of ['base', 'logical'] as BackupKind[]) {
    const row = byKind.get(kind);
    if (!row) {
      alerts.push({ scope: kind, severity: 'critical', code: 'backup_missing' });
      continue;
    }
    if (row.status === 'failed') {
      alerts.push({ scope: kind, severity: 'critical', code: 'backup_failed' });
    }
    if ((row.age_seconds ?? Infinity) > MAX_AGE_SECONDS[kind]) {
      alerts.push({ scope: kind, severity: 'critical', code: 'backup_too_old' });
    }
    if (!isOffsite(row.destination)) {
      // The single most dangerous failure mode: a backup that dies with the server.
      alerts.push({ scope: kind, severity: 'critical', code: 'backup_not_offsite' });
    }
    if (!row.encrypted) {
      alerts.push({ scope: kind, severity: 'warning', code: 'backup_not_encrypted' });
    }
    if (!row.checksum) {
      alerts.push({ scope: kind, severity: 'warning', code: 'checksum_missing' });
    }
    if (row.verification_status === 'failed') {
      alerts.push({ scope: kind, severity: 'critical', code: 'verification_failed' });
    } else if (row.verification_status === 'unverified' && row.status === 'succeeded') {
      alerts.push({ scope: kind, severity: 'warning', code: 'backup_unverified' });
    }
  }

  const objectRow = byKind.get('object');
  if (objectRow && (objectRow.age_seconds ?? Infinity) > MAX_AGE_SECONDS.object) {
    alerts.push({ scope: 'object', severity: 'warning', code: 'backup_too_old' });
  }

  const wal = input.wal;
  if (wal) {
    if (wal.archive_mode !== 'on' && wal.archive_mode !== 'always') {
      // Without archiving there is no PITR at all, whatever else exists.
      alerts.push({ scope: 'wal', severity: 'critical', code: 'wal_archiving_disabled' });
    }
    if ((wal.archive_lag_seconds ?? Infinity) > MAX_AGE_SECONDS.wal) {
      alerts.push({
        scope: 'wal',
        severity: 'critical',
        code: 'wal_archive_lag',
        detail: `${Math.round(wal.archive_lag_seconds ?? 0)}s`,
      });
    }
    // Only a *recent* failure matters: failed_count is cumulative since stats_reset.
    if (wal.last_failed_time && wal.last_archived_time && wal.last_failed_time > wal.last_archived_time) {
      alerts.push({ scope: 'wal', severity: 'critical', code: 'wal_archive_failing' });
    }
  }

  const now = input.now ? input.now.getTime() : Date.now();
  const lastPassed = input.lastDrills
    .filter((d) => d.status === 'passed' && d.finished_at)
    .map((d) => new Date(d.finished_at as string).getTime())
    .sort((a, b) => b - a)[0];
  if (!lastPassed) {
    alerts.push({ scope: 'drill', severity: 'critical', code: 'restore_drill_never' });
  } else if ((now - lastPassed) / 1000 > RESTORE_DRILL_MAX_AGE_SECONDS) {
    alerts.push({ scope: 'drill', severity: 'warning', code: 'restore_drill_overdue' });
  }

  return alerts;
}

export function healthOf(alerts: BackupAlert[]): BackupHealthState {
  if (alerts.some((a) => a.severity === 'critical')) return 'critical';
  return alerts.length > 0 ? 'attention' : 'ok';
}

function parseSchedule(): { kind: BackupKind; cron: string | null; next_run_at: string | null }[] {
  const raw = process.env.BACKUP_SCHEDULE_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, { cron?: string; next_run_at?: string }>;
    return (Object.keys(parsed) as BackupKind[]).map((kind) => ({
      kind,
      cron: parsed[kind]?.cron ?? null,
      next_run_at: parsed[kind]?.next_run_at ?? null,
    }));
  } catch {
    return [];
  }
}

export async function getBackupOverview(config: ServerConfig): Promise<BackupOverview> {
  const sb = getServiceClient(config);

  const latest = ((await rpc<BackupHealthRow[]>(config, 'backup_health')) || []).filter(Boolean);

  let wal: WalStatus | null = null;
  try {
    const rows = (await rpc<WalStatus[]>(config, 'backup_wal_status')) || [];
    wal = rows[0] ?? null;
  } catch {
    // A database that cannot report archiver state is itself a finding, but it
    // must not blank the whole panel.
    wal = null;
  }

  const { data: drills } = await sb
    .from('backup_restore_drills')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(10);

  const lastDrills = (drills || []) as RestoreDrill[];
  const alerts = deriveAlerts({ latest, wal, lastDrills });

  const { data: oldestBase } = await sb
    .from('backup_runs')
    .select('finished_at')
    .eq('kind', 'base')
    .eq('status', 'succeeded')
    .order('started_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return {
    health: healthOf(alerts),
    alerts,
    latest,
    wal,
    pitr: {
      window_start: (oldestBase as { finished_at?: string } | null)?.finished_at ?? null,
      window_end: wal?.last_archived_time ?? null,
      rpo_actual_seconds: wal?.archive_lag_seconds ?? null,
      rpo_target_seconds: RPO_TARGET_SECONDS,
      rto_target_seconds: RTO_TARGET_SECONDS,
    },
    lastDrills,
    destinations: (['base', 'wal', 'logical', 'object'] as BackupKind[]).map((kind) => {
      const row = latest.find((r) => r.kind === kind);
      return { kind, destination: row?.destination ?? null, offsite: isOffsite(row?.destination) };
    }),
    schedule: parseSchedule(),
  };
}

export async function listBackupRuns(
  config: ServerConfig,
  opts: { kind?: BackupKind; limit?: number } = {},
): Promise<BackupRun[]> {
  const sb = getServiceClient(config);
  let q = sb.from('backup_runs').select('*').order('started_at', { ascending: false }).limit(opts.limit ?? 50);
  if (opts.kind) q = q.eq('kind', opts.kind);
  const { data, error } = await q;
  if (error) throw new BackupError('backup_list_failed', error.message);
  return (data || []) as BackupRun[];
}

export async function listRestoreDrills(config: ServerConfig, limit = 25): Promise<RestoreDrill[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('backup_restore_drills')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new BackupError('drill_list_failed', error.message);
  return (data || []) as RestoreDrill[];
}

/** Report shape sent by the host-side backup agent. Never contains credentials. */
export interface BackupReport {
  backup_id: string;
  kind: BackupKind;
  status: BackupStatus;
  started_at?: string;
  finished_at?: string;
  bytes?: number;
  checksum?: string;
  destination?: string;
  lsn?: string;
  encrypted?: boolean;
  verification_status?: VerificationStatus;
  verified_at?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export async function recordBackupReport(config: ServerConfig, report: BackupReport): Promise<BackupRun> {
  const sb = getServiceClient(config);
  const row = {
    backup_id: report.backup_id,
    kind: report.kind,
    status: report.status,
    started_at: report.started_at ?? new Date().toISOString(),
    finished_at: report.finished_at ?? (report.status === 'running' ? null : new Date().toISOString()),
    bytes: report.bytes ?? null,
    checksum: report.checksum ?? null,
    destination: report.destination ?? null,
    lsn: report.lsn ?? null,
    encrypted: report.encrypted ?? false,
    verification_status: report.verification_status ?? 'unverified',
    verified_at: report.verified_at ?? null,
    error: report.error ?? null,
    metadata: report.metadata ?? {},
  };
  const { data, error } = await sb
    .from('backup_runs')
    .upsert(row, { onConflict: 'kind,backup_id' })
    .select()
    .single();
  if (error) throw new BackupError('backup_report_failed', error.message);
  return data as BackupRun;
}

export async function recordRestoreDrill(
  config: ServerConfig,
  drill: Omit<RestoreDrill, 'id' | 'started_at'> & { started_at?: string },
): Promise<RestoreDrill> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('backup_restore_drills').insert(drill).select().single();
  if (error) throw new BackupError('drill_record_failed', error.message);
  if (drill.status === 'passed' && drill.source_backup_id) {
    await sb
      .from('backup_runs')
      .update({ last_restore_tested_at: drill.finished_at ?? new Date().toISOString() })
      .eq('backup_id', drill.source_backup_id);
  }
  return data as RestoreDrill;
}

/** Safe operator actions. There is no restore command, by design. */
export type SafeCommand = 'run_logical_backup' | 'run_base_backup' | 'verify_latest_backup';
const SAFE_COMMANDS: SafeCommand[] = ['run_logical_backup', 'run_base_backup', 'verify_latest_backup'];

export async function requestCommand(
  config: ServerConfig,
  command: string,
  actorId: string,
): Promise<{ id: string; command: string; status: string }> {
  if (!SAFE_COMMANDS.includes(command as SafeCommand)) {
    throw new BackupError('command_not_allowed', `unsupported backup command: ${command}`);
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('backup_commands')
    .insert({ command, requested_by: actorId })
    .select('id, command, status')
    .single();
  if (error) throw new BackupError('command_request_failed', error.message);
  return data as { id: string; command: string; status: string };
}

export async function claimCommand(config: ServerConfig) {
  const rows = (await rpc<Array<{ id: string; command: string }>>(config, 'backup_claim_command')) || [];
  return rows[0] ?? null;
}

export async function completeCommand(
  config: ServerConfig,
  id: string,
  status: 'succeeded' | 'failed',
  result: Record<string, unknown> = {},
  error?: string,
) {
  const sb = getServiceClient(config);
  const { error: err } = await sb
    .from('backup_commands')
    .update({ status, completed_at: new Date().toISOString(), result, error: error ?? null })
    .eq('id', id);
  if (err) throw new BackupError('command_complete_failed', err.message);
}

export async function listCommands(config: ServerConfig, limit = 20) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('backup_commands')
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(limit);
  if (error) throw new BackupError('command_list_failed', error.message);
  return data || [];
}
