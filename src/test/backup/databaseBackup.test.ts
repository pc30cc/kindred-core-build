// @vitest-environment node
/**
 * Super Admin database backups end to end (server/services/backup/databaseBackup.ts)
 * with stand-in pg_dump / pg_restore executables, an in-memory database
 * client and an in-memory storage vendor:
 *
 *  - a backup is recorded only after the archive was read back; the row
 *    carries the checksum, the verification and a credential-free destination;
 *  - the database password reaches pg_dump through the environment only,
 *    and never lands in an error recorded on the run;
 *  - off-server copies are encrypted, and downloads decrypt and check them;
 *  - one backup at a time, interrupted runs are closed, retention removes
 *    old files but keeps the history, and the schedule runs once per slot.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

// ── In-memory stand-ins ──────────────────────────────────────────────────

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { app_runtime_config: [], backup_runs: [] };
const objects = new Map<string, Buffer>();

const CREDENTIAL = /(:\/\/[^/\s]*:[^/@\s]+@)|((password|passwd|secret_access_key|aws_secret|private_key|service_role_key)\s*[:=])|(AKIA[0-9A-Z]{16})/i;

function field(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (!m) return row[col];
  const v = (row[m[1]] as Record<string, unknown> | null)?.[m[2]];
  return v === undefined || v === null ? null : String(v);
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row = {};
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { col: string; asc: boolean } | null = null;
  private max = Infinity;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  constructor(private table: string) {}
  select() { return this; }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  upsert(row: Row) { this.op = 'upsert'; this.payload = row; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => String(field(r, col)) === String(v)); return this; }
  lt(col: string, v: unknown) { this.filters.push((r) => field(r, col) !== null && String(field(r, col)) < String(v)); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.sort = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  private guard(row: Row): string | null {
    if (this.table !== 'backup_runs') return null;
    const blob = `${row.destination ?? ''} ${JSON.stringify(row.metadata ?? {})}`;
    return CREDENTIAL.test(blob) ? 'backup_metadata_contains_credentials' : null;
  }

  private run(): { data: unknown; error: { message: string } | null } {
    const rows = tables[this.table];
    let out: Row[];
    if (this.op === 'insert') {
      if (this.table === 'app_runtime_config' && rows.some((r) => r.key === this.payload.key)) {
        return { data: null, error: { message: 'duplicate key' } };
      }
      const row: Row = { id: randomUUID(), verification_status: 'unverified', bytes: null, checksum: null, destination: null, finished_at: null, verified_at: null, error: null, encrypted: false, ...structuredClone(this.payload) };
      const bad = this.guard(row);
      if (bad) return { data: null, error: { message: bad } };
      rows.push(row);
      out = [row];
    } else if (this.op === 'upsert') {
      const existing = rows.find((r) => r.key === this.payload.key);
      if (existing) Object.assign(existing, structuredClone(this.payload));
      else rows.push(structuredClone(this.payload));
      out = [];
    } else {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === 'update') {
        for (const r of out) {
          const next = { ...r, ...structuredClone(this.payload) };
          const bad = this.guard(next);
          if (bad) return { data: null, error: { message: bad } };
        }
        for (const r of out) Object.assign(r, structuredClone(this.payload));
      } else if (this.op === 'delete') {
        tables[this.table] = rows.filter((r) => !out.includes(r));
      }
    }
    if (this.sort) {
      const { col, asc } = this.sort;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    out = out.slice(0, this.max).map((r) => structuredClone(r));
    if (this.mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected 1 row, got ${out.length}` } };
    if (this.mode === 'maybe') return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  then<A, B>(ok?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, bad);
  }
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => new FakeQuery(table) }),
}));

vi.mock('../../../server/services/storage/pool.js', () => ({
  readStoragePool: async () => ({
    primary: 's3',
    replication: { enabled: false, mirrorDeletes: false },
    providers: { s3: { enabled: true, config: { bucket: 'wy-backups' } }, local: { enabled: true, config: {} } },
    revision: 1,
  }),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  SUPPORTED_STORAGE_PROVIDERS: ['s3', 'bunny_storage', 'local'],
  storageConfigFromRecord: (provider: string, c: Record<string, unknown>) => ({ provider, bucket: c.bucket, secretAccessKey: 'SECRETKEY-xyz' }),
  uploadWithConfig: async (_c: unknown, req: { fileKey: string; data: Buffer }) => {
    objects.set(req.fileKey, Buffer.from(req.data));
    return { success: true, fileKey: req.fileKey };
  },
  downloadWithConfig: async (_c: unknown, key: string) =>
    objects.has(key) ? { success: true, data: objects.get(key) } : { success: false, error: 'not found' },
  deleteWithConfig: async (_c: unknown, key: string) => ({ success: objects.delete(key) }),
}));

const svc = await import('../../../server/services/backup/databaseBackup');
const { isOffsite } = await import('../../../server/services/backup/backupService');
const { defaultBackupSettings } = await import('../../../server/services/backup/databaseBackupSettings');

// ── Stand-in pg_dump / pg_restore ────────────────────────────────────────

const KEY = 'm'.repeat(48);
const DB_PASSWORD = 'Db-Pa55word-Secret';
const config = { pluginSecretsMasterKey: KEY } as Parameters<typeof svc.startDatabaseBackup>[0];
let root: string;
let backupDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wy-db-backup-'));
  backupDir = path.join(root, 'backups');
  const argvLog = path.join(root, 'pg_dump.argv');
  writeFileSync(path.join(root, 'pg_dump'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 17.11"; exit 0; fi
echo "$@ | PGUSER=$PGUSER PGDATABASE=$PGDATABASE PGSSLMODE=$PGSSLMODE" >> "${argvLog}"
if [ "$PGDATABASE" = "broken" ]; then echo "pg_dump: error: connection to server failed: password=$PGPASSWORD rejected" >&2; exit 1; fi
for a in "$@"; do case "$a" in --file=*) f="\${a#--file=}";; esac; done
printf 'PGDMP fake archive of %s\\n' "$PGDATABASE" > "$f"
head -c 40000 /dev/urandom >> "$f"
`);
  writeFileSync(path.join(root, 'pg_restore'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 17.11"; exit 0; fi
if [ "$1" = "--list" ]; then printf ';\\n; Archive created\\n;\\n1; 2615 2200 SCHEMA - public owner\\n2; 1259 16385 TABLE public t1 owner\\n'; exit 0; fi
exit 0
`);
  chmodSync(path.join(root, 'pg_dump'), 0o755);
  chmodSync(path.join(root, 'pg_restore'), 0o755);
  for (const k of ['PG_DUMP_PATH', 'PG_RESTORE_PATH', 'BACKUP_LOCAL_DIR', 'DATABASE_URL', 'BACKUP_DATABASE_URL', 'DATABASE_ROLE']) saved[k] = process.env[k];
  process.env.PG_DUMP_PATH = path.join(root, 'pg_dump');
  process.env.PG_RESTORE_PATH = path.join(root, 'pg_restore');
  process.env.BACKUP_LOCAL_DIR = backupDir;
  delete process.env.BACKUP_DATABASE_URL;
  delete process.env.DATABASE_ROLE;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  tables.app_runtime_config = [];
  tables.backup_runs = [];
  objects.clear();
  process.env.DATABASE_URL = `postgresql://webyar_app:${encodeURIComponent(DB_PASSWORD)}@db.internal:5432/webyar?sslmode=disable`;
});

function setSettings(p: Partial<ReturnType<typeof defaultBackupSettings>>) {
  tables.app_runtime_config.push({ key: 'database_backup_settings', value: { ...defaultBackupSettings(), ...p } });
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('connection and error hygiene', () => {
  it('prefers BACKUP_DATABASE_URL, maps sslmode, and keeps the role rule of the server', () => {
    const app = svc.resolveDumpConnection({ DATABASE_URL: 'postgres://u:p%40ss@h:6000/db?sslmode=no-verify' });
    expect(app).toMatchObject({ credential: 'database_url', role: 'service_role' });
    expect(app?.env).toMatchObject({ PGHOST: 'h', PGPORT: '6000', PGUSER: 'u', PGPASSWORD: 'p@ss', PGDATABASE: 'db', PGSSLMODE: 'require' });
    expect(svc.resolveDumpConnection({ DATABASE_URL: 'postgres://u:p@h/db', DATABASE_ROLE: 'none' })?.role).toBeNull();
    const own = svc.resolveDumpConnection({ DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DATABASE_URL: 'postgresql://webyar_backup:x@db:5432/webyar?sslmode=disable' });
    expect(own).toMatchObject({ credential: 'backup_url', role: null });
    expect(own?.env).toMatchObject({ PGUSER: 'webyar_backup', PGSSLMODE: 'disable' });
    expect(svc.resolveDumpConnection({})).toBeNull();
    expect(svc.resolveDumpConnection({ DATABASE_URL: 'mysql://x' })).toBeNull();
  });

  it('removes secrets and credential-shaped text from errors', () => {
    const msg = svc.sanitizeBackupError('failed postgres://u:hunter22@h/db password=hunter22 AKIAABCDEFGHIJKLMNOP and hunter22', ['hunter22']);
    expect(msg).not.toContain('hunter22');
    expect(msg).not.toMatch(CREDENTIAL);
    expect(svc.sanitizeBackupError('x'.repeat(5000)).length).toBeLessThanOrEqual(1000);
  });

  it('destinations never carry credentials, and bunny / ftp count as off-server', () => {
    expect(svc.destinationLabel({ type: 'ftp', host: 'ftp.example.com', port: 21, username: 'bk', dir: '/db/', file: 'a.dump.enc', secure: true }))
      .toBe('ftps://ftp.example.com:21/db/a.dump.enc');
    expect(svc.destinationLabel({ type: 'storage', provider: 'bunny_storage', key: 'backups/database/a' }, { provider: 'bunny_storage', storageZone: 'zone' }))
      .toBe('bunny://zone/backups/database/a');
    expect(isOffsite('bunny://zone/x')).toBe(true);
    expect(isOffsite('ftps://h:21/x')).toBe(true);
    expect(isOffsite('file:///app/data/backups/database/x.dump')).toBe(false);
  });
});

// ── Runs ─────────────────────────────────────────────────────────────────

describe('database backups', () => {
  it('a local backup is verified, recorded and downloadable; the password stays out of argv', async () => {
    const { run, job } = await svc.startDatabaseBackup(config, { trigger: 'manual', actorId: 'admin-1' });
    expect(run.status).toBe('running');
    await expect(svc.startDatabaseBackup(config, { trigger: 'manual', actorId: 'admin-1' })).rejects.toMatchObject({ code: 'backup_already_running' });
    const done = await job;

    expect(done.status).toBe('succeeded');
    expect(done.verification_status).toBe('verified');
    expect(done.encrypted).toBe(false);
    expect(done.metadata).toMatchObject({ source: 'database_backup', trigger: 'manual', actor_id: 'admin-1', toc_entries: 2, location: { type: 'local' } });
    const file = path.join(backupDir, `${done.backup_id}.dump`);
    expect(done.destination).toBe(`file://${file}`);
    expect(statSync(file).mode & 0o077).toBe(0);
    const bytes = readFileSync(file);
    expect(done.checksum).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(done.bytes).toBe(bytes.length);
    expect(readdirSync(path.join(backupDir, '.tmp'))).toEqual([]);

    const argv = readFileSync(path.join(root, 'pg_dump.argv'), 'utf8');
    expect(argv).toContain('--format=custom');
    expect(argv).toContain('--role=service_role');
    expect(argv).toContain('PGUSER=webyar_app PGDATABASE=webyar PGSSLMODE=disable');
    expect(argv).not.toContain(DB_PASSWORD);

    const lease = tables.app_runtime_config.find((r) => r.key === 'database_backup_lock')?.value as { lease_until: string };
    expect(new Date(lease.lease_until).getTime()).toBe(0);

    const dl = await svc.downloadDatabaseBackup(config, done.id);
    expect(dl.fileName).toBe(`${done.backup_id}.dump`);
    expect((await readAll(dl.stream)).equals(bytes)).toBe(true);

    const view = svc.toRunView(done);
    expect(view).toMatchObject({ status: 'succeeded', trigger: 'manual', destinationType: 'local', verified: true, downloadable: true, tocEntries: 2 });
  });

  it('a storage backup is uploaded encrypted and downloads decrypted', async () => {
    const { job } = await svc.startDatabaseBackup(config, { trigger: 'manual', actorId: 'admin-1', destination: 'storage', storageProvider: 's3' });
    const done = await job;
    expect(done.status).toBe('succeeded');
    expect(done.encrypted).toBe(true);
    const key = `backups/database/${done.backup_id}.dump.enc`;
    expect(done.destination).toBe(`s3://wy-backups/${key}`);
    const stored = objects.get(key)!;
    expect(stored.subarray(0, 8).toString('ascii')).toBe('WYDBK001');
    expect(stored.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(existsSync(path.join(backupDir, `${done.backup_id}.dump`))).toBe(false);

    const plain = await readAll((await svc.downloadDatabaseBackup(config, done.id)).stream);
    expect(plain.subarray(0, 5).toString()).toBe('PGDMP');
    expect(done.checksum).toBe(`sha256:${createHash('sha256').update(plain).digest('hex')}`);

    objects.set(key, Buffer.concat([stored.subarray(0, stored.length - 1), Buffer.from([stored[stored.length - 1] ^ 1])]));
    await expect(svc.downloadDatabaseBackup(config, done.id)).rejects.toMatchObject({ code: 'backup_checksum_mismatch' });

    await svc.deleteDatabaseBackup(config, done.id);
    expect(objects.has(key)).toBe(false);
    expect(tables.backup_runs).toHaveLength(0);
  });

  it('a failed dump is recorded without the password and leaves no temp files', async () => {
    process.env.DATABASE_URL = `postgresql://webyar_app:${encodeURIComponent(DB_PASSWORD)}@db.internal:5432/broken`;
    const { job } = await svc.startDatabaseBackup(config, { trigger: 'manual', actorId: null });
    const done = await job;
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^pg_dump_failed/);
    expect(done.error).not.toContain(DB_PASSWORD);
    expect(readdirSync(path.join(backupDir, '.tmp'))).toEqual([]);
  });

  it('refuses an off-server destination it cannot encrypt for, before starting', async () => {
    await expect(
      svc.startDatabaseBackup({ pluginSecretsMasterKey: '' } as typeof config, { trigger: 'manual', actorId: null, destination: 'storage', storageProvider: 's3' }),
    ).rejects.toMatchObject({ code: 'encryption_key_missing' });
    await expect(svc.startDatabaseBackup(config, { trigger: 'manual', actorId: null, destination: 'ftp' })).rejects.toMatchObject({
      code: 'ftp_settings_incomplete',
    });
    expect(tables.backup_runs).toHaveLength(0);
  });

  it('retention removes old files but keeps their history; deleting removes file and record', async () => {
    setSettings({ retentionDays: 30 });
    const oldFile = 'webyar-db-20260801-020000Z-aaaaaaaa.dump';
    writeFileSync(path.join(backupDir, oldFile), 'old');
    tables.backup_runs.push({
      id: randomUUID(), backup_id: 'webyar-db-20260801-020000Z-aaaaaaaa', kind: 'logical', status: 'succeeded',
      started_at: '2026-08-01T02:00:00.000Z', finished_at: '2026-08-01T02:01:00.000Z', encrypted: false,
      metadata: { source: 'database_backup', trigger: 'schedule', location: { type: 'local', file: oldFile } },
    });
    const done = await (await svc.startDatabaseBackup(config, { trigger: 'manual', actorId: null })).job;
    expect(done.status).toBe('succeeded');
    expect(existsSync(path.join(backupDir, oldFile))).toBe(false);
    const old = tables.backup_runs.find((r) => r.backup_id === 'webyar-db-20260801-020000Z-aaaaaaaa')!;
    expect((old.metadata as Record<string, unknown>).pruned_at).toBeTruthy();
    expect(svc.toRunView(old as never).downloadable).toBe(false);
    await expect(svc.downloadDatabaseBackup(config, old.id as string)).rejects.toMatchObject({ code: 'backup_pruned' });

    const file = path.join(backupDir, `${done.backup_id}.dump`);
    expect(existsSync(file)).toBe(true);
    await svc.deleteDatabaseBackup(config, done.id);
    expect(existsSync(file)).toBe(false);
    expect(tables.backup_runs.some((r) => r.id === done.id)).toBe(false);
  });

  it('a run left "running" by a stopped server is closed as interrupted', async () => {
    tables.backup_runs.push({
      id: randomUUID(), backup_id: 'webyar-db-x', kind: 'logical', status: 'running', started_at: new Date().toISOString(),
      encrypted: false, metadata: { source: 'database_backup', trigger: 'manual' },
    });
    const status = await svc.databaseBackupStatus(config);
    expect(status.runs[0]).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(status.tools.pgDump).toContain('17.11');
    expect(status.connection).toMatchObject({ credential: 'database_url', database: 'webyar' });
    expect(status.storageProviders.map((v) => v.name)).toEqual(['s3']);
  });

  it('the schedule runs once per slot', async () => {
    setSettings({ enabled: true, schedule: 'daily', hourUtc: 2, scheduleAnchor: '2026-01-01T00:00:00.000Z' });
    expect(await svc.runScheduledBackupIfDue(config)).toBe('ran');
    expect(await svc.runScheduledBackupIfDue(config)).toBe('idle');
    const runs = tables.backup_runs.filter((r) => (r.metadata as Record<string, unknown>).trigger === 'schedule');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
  });

  it('a schedule that cannot start records one failed run for the slot', async () => {
    setSettings({ enabled: true, destination: 'ftp', scheduleAnchor: '2026-01-01T00:00:00.000Z' });
    expect(await svc.runScheduledBackupIfDue(config)).toBe('failed');
    expect(await svc.runScheduledBackupIfDue(config)).toBe('idle');
    expect(tables.backup_runs).toHaveLength(1);
    expect(tables.backup_runs[0]).toMatchObject({ status: 'failed', error: 'ftp_settings_incomplete' });
  });
});
