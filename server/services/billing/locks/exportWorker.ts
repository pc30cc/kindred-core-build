// ============================================================================
// SIMPLE BILLING phase 4 — the owner's export of locked data
// (docs/billing/SIMPLE_BILLING.md: "Locked data can always be exported by
// the owner"; design §7).
//
// A job (billing_lock_exports, one live per workspace) is started from the
// billing page by the workspace owner (routes/billingLockExport.ts) and built
// here, in-process, like the privacy exports (privacy/worker.ts):
//
//   pending --(claim)--> running --> completed (a ZIP, kept 7 days)
//                                \--> failed (after MAX_ATTEMPTS)
//
// The ZIP holds what is locked when the job runs, on every plan and whatever
// `contact_export` says:
//   kb_articles.json, kb/<locale>/<slug>.md   locked articles
//   contacts.json, contacts.csv               locked contacts
//   conversations.json                        chats past retention, with messages
//   attachments/<chat>/<file>                 their files, up to 500 MB
//   manifest.json, README.txt                 counts, what was left out
//
// The file is stored under workspace/<id>/billing-exports/<job>.zip in the
// privacy-export storage (else the workspace's own), never counted against
// the workspace's storage quota (a system file, not an upload), never public:
// it is streamed through a single-use token. The hourly expiry sweep
// (privacy/expirySweep.ts) deletes it after 7 days.
// ============================================================================

import crypto from 'node:crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { ZipBuilder } from '../../privacy/zip.js';
import { PrivacyStorageNotConfigured, resolvePrivacyStoragePolicy } from '../../privacy/storageResolver.js';
import {
  deleteWithConfig,
  downloadFile,
  downloadWithConfig,
  resolveStorageConfig,
  uploadWithConfigForOwner,
  type StorageConfig,
} from '../../storage/index.js';
import { workspaceRoot } from '../../storage/keys.js';
import { IdleBackoff } from '../../jobs/idleBackoff.js';
import { readLockedIds } from './state.js';

export const LOCK_EXPORT_KINDS = ['kb_article', 'contact', 'conversation'] as const;
export type LockExportKind = (typeof LOCK_EXPORT_KINDS)[number];

export const LOCK_EXPORT_TTL_MS = 7 * 86_400_000;
/** Rows exported per kind at most (the manifest says when more were locked). */
export const LOCK_EXPORT_ROW_CAP = 50_000;
/** Attachment bytes in one ZIP; the rest is listed in the manifest only. */
export const LOCK_EXPORT_ATTACHMENT_BUDGET = 500 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const STUCK_AFTER_MS = 15 * 60_000;
const RECOVER_EVERY_MS = 10 * 60_000;
const POLL_MS = 5_000;
const MAX_IDLE_POLL_MS = 60_000;
const READ_CHUNK = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LockExportRow {
  id: string;
  workspace_id: string;
  requested_by: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'expired';
  kinds: string[];
  counts: Record<string, number>;
  artifact_storage_provider: string | null;
  artifact_storage_key: string | null;
  artifact_size_bytes: number | null;
  download_token_hash: string | null;
  expires_at: string | null;
  attempts: number;
  locked_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** The object key of an export: workspace/<id>/billing-exports/<job>.zip. */
export function lockExportKey(workspaceId: string, jobId: string): string {
  if (!UUID_RE.test(jobId)) throw new Error('lockExportKey: jobId must be a uuid');
  return `${workspaceRoot(workspaceId)}/billing-exports/${jobId.toLowerCase()}.zip`;
}

/**
 * Where exports are stored: the privacy-export storage when one is set (a
 * private store, the same policy as the privacy exports), else the
 * workspace's own storage. The same answer is read again to download and
 * to delete; a provider changed since leaves the file to manual cleanup.
 */
export async function resolveLockExportStorage(config: ServerConfig, workspaceId: string): Promise<{ provider: string; config: StorageConfig }> {
  try {
    const policy = await resolvePrivacyStoragePolicy(config, workspaceId);
    return { provider: policy.provider, config: policy.config };
  } catch (e) {
    if (!(e instanceof PrivacyStorageNotConfigured)) throw e;
  }
  const own = await resolveStorageConfig(config, workspaceId);
  if (!own) throw new Error('No storage provider configured');
  return { provider: own.provider, config: own };
}

/** The job as the billing page sees it (no storage key, no token). */
export function publicLockExport(row: LockExportRow | null): Record<string, unknown> | null {
  if (!row) return null;
  const expired = row.status === 'expired'
    || (row.status === 'completed' && (!row.artifact_storage_key || (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now())));
  return {
    id: row.id,
    status: expired ? 'expired' : row.status,
    kinds: row.kinds ?? [],
    counts: row.counts ?? {},
    artifact_size_bytes: row.artifact_size_bytes ?? null,
    expires_at: row.expires_at ?? null,
    error: row.status === 'failed' ? row.error ?? null : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const safeName = (name: string, fallback: string): string =>
  (name || '').normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 80) || fallback;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('; ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CONTACT_COLUMNS = ['id', 'name', 'email', 'phone', 'tags', 'notes', 'visitor_code', 'created_at', 'updated_at'] as const;

export function contactsCsv(rows: Array<Record<string, unknown>>): string {
  const lines = [CONTACT_COLUMNS.join(',')];
  for (const row of rows) lines.push(CONTACT_COLUMNS.map((c) => csvCell(row[c])).join(','));
  // A BOM, so spreadsheet apps read Persian and Turkish text as UTF-8.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

type Client = ReturnType<typeof getServiceClient>;

async function readRows(sb: Client, table: string, workspaceId: string, ids: string[], order = 'created_at'): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await sb
      .from(table)
      .select('*')
      .eq('workspace_id', workspaceId)
      .in('id', ids.slice(i, i + READ_CHUNK))
      .order(order, { ascending: true });
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return out;
}

async function readByConversation(
  sb: Client,
  table: string,
  ids: string[],
  only: { workspaceId?: string; statuses?: string[] } = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    // Paged: the data layer answers at most 1000 rows per read.
    for (let from = 0; ; from += 1000) {
      let query = sb.from(table).select('*').in('conversation_id', ids.slice(i, i + READ_CHUNK));
      if (only.workspaceId) query = query.eq('workspace_id', only.workspaceId);
      if (only.statuses) query = query.in('status', only.statuses);
      const { data, error } = await query.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      out.push(...rows);
      if (rows.length < 1000) break;
    }
  }
  return out;
}

/**
 * Builds the ZIP of what is locked now in `kinds`. Reads only; the rows are
 * those billing_locked_ids names at this moment (nothing while the edition's
 * switch is off).
 */
export async function buildLockedExportZip(
  config: ServerConfig,
  job: Pick<LockExportRow, 'id' | 'workspace_id' | 'kinds'>,
): Promise<{ buffer: Buffer; counts: Record<string, number>; truncated: string[] }> {
  const sb = getServiceClient(config);
  const ws = job.workspace_id;
  const kinds = new Set(job.kinds.filter((k): k is LockExportKind => (LOCK_EXPORT_KINDS as readonly string[]).includes(k)));
  const zip = new ZipBuilder();
  const counts: Record<string, number> = {};
  const truncated: string[] = [];
  const omitted: Array<{ id: string; conversation_id: unknown; file_name: unknown; size_bytes: unknown; reason: string }> = [];

  const lockedIds = async (kind: LockExportKind) => {
    const ids = await readLockedIds(config, ws, kind, LOCK_EXPORT_ROW_CAP + 1, sb);
    if (ids.length > LOCK_EXPORT_ROW_CAP) {
      truncated.push(kind);
      return ids.slice(0, LOCK_EXPORT_ROW_CAP);
    }
    return ids;
  };

  if (kinds.has('kb_article')) {
    const rows = await readRows(sb, 'knowledge_base_articles', ws, await lockedIds('kb_article'));
    zip.add('kb_articles.json', JSON.stringify(rows, null, 2));
    const used = new Set<string>();
    for (const row of rows) {
      const locale = safeName(String(row.locale ?? ''), 'default');
      let name = `kb/${locale}/${safeName(String(row.slug ?? ''), String(row.id))}.md`;
      if (used.has(name)) name = `kb/${locale}/${safeName(String(row.slug ?? ''), 'article')}-${String(row.id).slice(0, 8)}.md`;
      used.add(name);
      const excerpt = typeof row.excerpt === 'string' && row.excerpt.trim() ? `> ${row.excerpt.trim()}\n\n` : '';
      zip.add(name, `# ${String(row.title ?? '')}\n\n${excerpt}${String(row.content ?? '')}\n`);
    }
    counts.kb_article = rows.length;
  }

  if (kinds.has('contact')) {
    const rows = await readRows(sb, 'contacts', ws, await lockedIds('contact'));
    zip.add('contacts.json', JSON.stringify(rows, null, 2));
    zip.add('contacts.csv', contactsCsv(rows));
    counts.contact = rows.length;
  }

  if (kinds.has('conversation')) {
    const ids = await lockedIds('conversation');
    const rows = await readRows(sb, 'conversations', ws, ids);
    const messages = await readByConversation(sb, 'conversation_messages', ids);
    const byChat = new Map<string, Array<Record<string, unknown>>>();
    for (const m of messages) {
      const key = String(m.conversation_id);
      const list = byChat.get(key) ?? [];
      list.push(m);
      byChat.set(key, list);
    }
    zip.add('conversations.json', JSON.stringify(rows.map((c) => ({ ...c, messages: byChat.get(String(c.id)) ?? [] })), null, 2));
    counts.conversation = rows.length;
    counts.messages = messages.length;

    const attachments = await readByConversation(sb, 'conversation_attachments', ids, { workspaceId: ws, statuses: ['uploaded', 'attached'] });
    let budget = LOCK_EXPORT_ATTACHMENT_BUDGET;
    let included = 0;
    const index: Array<Record<string, unknown>> = [];
    for (const a of attachments) {
      const size = Number(a.size_bytes ?? 0) || 0;
      const entry = `attachments/${String(a.conversation_id)}/${String(a.id)}__${safeName(String(a.file_name ?? ''), 'file')}`;
      if (size > budget) {
        omitted.push({ id: String(a.id), conversation_id: a.conversation_id, file_name: a.file_name, size_bytes: a.size_bytes, reason: 'size_budget' });
        index.push({ ...a, exported_as: null });
        continue;
      }
      const dl = await downloadFile(config, ws, String(a.storage_path ?? '')).catch(() => ({ success: false as const, data: undefined }));
      if (!dl.success || !dl.data) {
        omitted.push({ id: String(a.id), conversation_id: a.conversation_id, file_name: a.file_name, size_bytes: a.size_bytes, reason: 'unreadable' });
        index.push({ ...a, exported_as: null });
        continue;
      }
      budget -= dl.data.length;
      zip.add(entry, dl.data);
      index.push({ ...a, exported_as: entry });
      included += 1;
    }
    zip.add('attachments_index.json', JSON.stringify(index, null, 2));
    counts.attachments = included;
    counts.attachments_omitted = omitted.length;
  }

  const generated = new Date().toISOString();
  zip.add('manifest.json', JSON.stringify({
    schema_version: 1,
    job_id: job.id,
    workspace_id: ws,
    kinds: [...kinds],
    generated_at: generated,
    counts,
    truncated: truncated.map((kind) => ({ kind, exported: LOCK_EXPORT_ROW_CAP })),
    attachments_omitted: omitted,
  }, null, 2));
  zip.add('README.txt', [
    `Locked data export — job ${job.id}`,
    `Workspace: ${ws}`,
    `Generated: ${generated}`,
    '',
    'This archive holds what was locked by the plan when it was made: the',
    'knowledge-base articles, contacts and chats over the plan\'s limits.',
    '',
    '  kb_articles.json, kb/<locale>/<slug>.md   locked articles',
    '  contacts.json, contacts.csv               locked contacts',
    '  conversations.json                        chats past the plan\'s retention, with their messages',
    '  attachments/<chat>/<file>                 their files (attachments_index.json lists every one)',
    '  manifest.json                             counts, and what was left out',
    '',
    `Files beyond ${LOCK_EXPORT_ATTACHMENT_BUDGET / 1024 / 1024} MB in total, and files that could not be read, are listed`,
    'in manifest.json (attachments_omitted) but not included.',
    truncated.length ? `Only the first ${LOCK_EXPORT_ROW_CAP} rows of: ${truncated.join(', ')}.` : '',
    '',
  ].join('\n'));

  return { buffer: zip.build(), counts, truncated };
}

/** Builds, stores and completes one claimed job. Throws on failure (the caller records it). */
export async function processLockExportJob(config: ServerConfig, job: LockExportRow): Promise<void> {
  const sb = getServiceClient(config);
  const { data: ws } = await sb.from('workspaces').select('status').eq('id', job.workspace_id).maybeSingle();
  if ((ws as { status?: string } | null)?.status !== 'active') throw new Error('workspace_not_active');

  const { buffer, counts } = await buildLockedExportZip(config, job);
  const storage = await resolveLockExportStorage(config, job.workspace_id);
  const key = lockExportKey(job.workspace_id, job.id);
  // The owner-scoped upload keeps the workspace-deletion write lock (as the
  // privacy exports do); no storage_usage_logs row: not an upload of theirs.
  const upload = await uploadWithConfigForOwner(config, { kind: 'workspace', workspaceId: job.workspace_id }, storage.config, {
    fileKey: key,
    data: buffer,
    contentType: 'application/zip',
  });
  if (!upload.success) throw new Error(`upload failed via ${storage.provider}: ${upload.error || 'unknown'}`);

  const now = new Date();
  const { data: done, error } = await sb
    .from('billing_lock_exports')
    .update({
      status: 'completed',
      counts,
      artifact_storage_provider: storage.provider,
      artifact_storage_key: key,
      artifact_size_bytes: buffer.length,
      expires_at: new Date(now.getTime() + LOCK_EXPORT_TTL_MS).toISOString(),
      error: null,
      updated_at: now.toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'running')
    .select('id');
  if (error || !Array.isArray(done) || !done.length) {
    // Recovered as stuck meanwhile: the file is not the job's any more.
    await deleteWithConfig(storage.config, key).catch(() => undefined);
    throw new Error(error?.message || 'job no longer running');
  }
}

/** Running jobs a worker left behind: back to pending, or failed after MAX_ATTEMPTS. */
export async function recoverStuckLockExports(config: ServerConfig, now = Date.now()): Promise<number> {
  const sb = getServiceClient(config);
  const cutoff = new Date(now - STUCK_AFTER_MS).toISOString();
  const { data, error } = await sb.from('billing_lock_exports').select('id, attempts').eq('status', 'running').lt('locked_at', cutoff).limit(100);
  if (error) throw new Error(error.message);
  let n = 0;
  for (const row of (data ?? []) as Array<{ id: string; attempts: number }>) {
    const failed = Number(row.attempts ?? 0) >= MAX_ATTEMPTS;
    const { data: moved } = await sb
      .from('billing_lock_exports')
      .update(failed
        ? { status: 'failed', error: 'worker stopped while running', locked_at: null, updated_at: new Date(now).toISOString() }
        : { status: 'pending', locked_at: null, updated_at: new Date(now).toISOString() })
      .eq('id', row.id)
      .eq('status', 'running')
      .lt('locked_at', cutoff)
      .select('id');
    if (Array.isArray(moved) && moved.length) n += 1;
  }
  return n;
}

/** The oldest pending job, claimed with a conditional update (a second worker loses the race). */
export async function claimNextLockExport(config: ServerConfig): Promise<LockExportRow | null> {
  const sb = getServiceClient(config);
  const { data: candidate, error } = await sb
    .from('billing_lock_exports')
    .select('id, attempts')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!candidate) return null;
  const c = candidate as { id: string; attempts: number };
  const nowIso = new Date().toISOString();
  const { data: claimed } = await sb
    .from('billing_lock_exports')
    .update({ status: 'running', attempts: Number(c.attempts ?? 0) + 1, locked_at: nowIso, updated_at: nowIso })
    .eq('id', c.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return (claimed as LockExportRow | null) ?? null;
}

let lastRecover = 0;

/** One poll: recovery now and then, then at most one job. True when a job was handled. */
export async function runLockExportTick(config: ServerConfig): Promise<boolean> {
  try {
    if (Date.now() - lastRecover > RECOVER_EVERY_MS) {
      lastRecover = Date.now();
      await recoverStuckLockExports(config);
    }
    const job = await claimNextLockExport(config);
    if (!job) return false;
    try {
      await processLockExportJob(config, job);
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000) || 'unknown error';
      console.warn(`[billing-locks] export ${job.id} failed (attempt ${job.attempts}):`, message);
      // A transient failure is tried again; the last attempt fails the job.
      const retry = job.attempts < MAX_ATTEMPTS && message !== 'workspace_not_active';
      await getServiceClient(config)
        .from('billing_lock_exports')
        .update({ status: retry ? 'pending' : 'failed', error: message, locked_at: null, updated_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('status', 'running');
    }
    return true;
  } catch (e) {
    console.error('[billing-locks] export worker tick:', e instanceof Error ? e.message : e);
    return false; // counted as idle: an outage is polled less and less often
  }
}

let started = false;

/** The in-process export worker (server/index.ts), polling like the privacy worker. */
export function startLockExportWorker(config: ServerConfig): void {
  if (started) return;
  started = true;
  const backoff = new IdleBackoff({ busyMs: POLL_MS, idleMs: POLL_MS, maxIdleMs: MAX_IDLE_POLL_MS });
  const schedule = (delayMs: number) => {
    const id = setTimeout(() => {
      void runLockExportTick(config).then((worked) => schedule(backoff.next(worked)));
    }, delayMs);
    id.unref?.();
  };
  schedule(POLL_MS);
}

/** Reads a completed export's ZIP from where it was stored. Null when it is gone or the provider changed. */
export async function readLockExportArtifact(config: ServerConfig, job: LockExportRow): Promise<Buffer | null> {
  if (!job.artifact_storage_key || !job.artifact_storage_provider) return null;
  const storage = await resolveLockExportStorage(config, job.workspace_id);
  if (storage.provider !== job.artifact_storage_provider) return null;
  const dl = await downloadWithConfig(storage.config, job.artifact_storage_key);
  return dl.success && dl.data ? dl.data : null;
}

/**
 * Deletes expired export files (the hourly sweep in privacy/expirySweep.ts).
 * A row is kept for its history with status 'expired'. A provider changed
 * since the export is skipped and logged (never deleted from the wrong one).
 */
export async function purgeExpiredLockExports(config: ServerConfig, now = new Date()): Promise<{ purged: number; skipped: number }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('billing_lock_exports')
    .select('*')
    .eq('status', 'completed')
    .lt('expires_at', now.toISOString())
    .limit(100);
  if (error) throw new Error(error.message);
  let purged = 0;
  let skipped = 0;
  for (const job of (data ?? []) as LockExportRow[]) {
    if (job.artifact_storage_key) {
      try {
        const storage = await resolveLockExportStorage(config, job.workspace_id);
        if (storage.provider !== job.artifact_storage_provider) {
          console.warn(`[billing-locks] expired export ${job.id} left in ${job.artifact_storage_provider}: storage is now ${storage.provider}`);
          skipped += 1;
          continue;
        }
        const r = await deleteWithConfig(storage.config, job.artifact_storage_key);
        if (!r.success) {
          skipped += 1;
          continue;
        }
      } catch (e) {
        console.warn(`[billing-locks] expired export ${job.id} not deleted:`, e instanceof Error ? e.message : e);
        skipped += 1;
        continue;
      }
    }
    await sb
      .from('billing_lock_exports')
      .update({ status: 'expired', artifact_storage_key: null, download_token_hash: null, updated_at: now.toISOString() })
      .eq('id', job.id)
      .eq('status', 'completed');
    purged += 1;
  }
  return { purged, skipped };
}

/** A token's stored form. */
export const hashLockExportToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
