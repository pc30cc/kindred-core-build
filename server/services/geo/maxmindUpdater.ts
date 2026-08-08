/**
 * MaxMind GeoLite2 auto-updater — in-process, production-grade.
 *
 * Why in-process: this repo already runs every scheduled job as an in-process
 * ticker on the Express backend (alertingTicker, autoActionsTicker, queueTicker,
 * retentionJanitor …). There is no cron/sidecar layer to reuse, and the widget
 * request path must never wait on a database download. So the updater follows
 * the exact same pattern: one interval, best-effort, never throws into the
 * request path, never crashes the process.
 *
 * Safety properties:
 *   • Multi-container safe — a DB-backed lease in `app_runtime_config`
 *     (`maxmind_update_lock`) is acquired with a single conditional UPDATE, so
 *     only one replica can be downloading at any moment.
 *   • Atomic — the archive is downloaded to `<db>.tmp-<pid>`, extracted to
 *     `<db>.new-<pid>`, validated by actually opening it with the maxmind
 *     reader, and only then `rename()`d over the live path. rename(2) within
 *     the same directory is atomic, so readers never observe a partial file.
 *   • Non-destructive — an invalid/corrupt/truncated download is discarded and
 *     the previous healthy database stays exactly where it was.
 *   • Quiet — credentials are never logged; only status/error text is stored.
 *
 * Nothing is downloaded unless: maxmind_local.enabled === true AND
 * maxmind_update.mode === 'auto' AND account_id + license_key are present.
 * `runMaxmindUpdateNow()` is the manual (admin button) entrypoint and bypasses
 * only the `mode === 'auto'` requirement.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getMapGeoSettings, patchMapGeoSettings } from './settings.js';
import { invalidateMaxmindReader, validateMmdbCandidate } from './maxmindLocal.js';

const LOCK_KEY = 'maxmind_update_lock';
/** How long one updater run may hold the lease before another replica may steal it. */
const LEASE_MS = 30 * 60 * 1000;
/** Ticker cadence — the interval setting is enforced separately, per-run. */
const TICK_MS = 30 * 60 * 1000;
/** Never allow a configured interval below this, whatever the UI stored. */
export const MIN_INTERVAL_HOURS = 24;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface UpdateOutcome {
  ok: boolean;
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;
  db_path?: string;
  size_bytes?: number;
}

// ── Minimal tar reader ───────────────────────────────────────────────────────
// MaxMind ships `<Edition>_<date>.tar.gz` containing `<dir>/<Edition>.mmdb`.
// A tar archive is a sequence of 512-byte headers followed by padded payloads,
// so extracting the single member we need needs no extra dependency.
export function extractMmdbFromTar(buf: Buffer): Buffer | null {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break; // two zero blocks terminate the archive
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const start = off + 512;
    if (name.toLowerCase().endsWith('.mmdb')) {
      return buf.subarray(start, start + size);
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function gunzip(buf: Buffer): Promise<Buffer> {
  const { gunzip: gz } = await import('node:zlib');
  return await new Promise<Buffer>((resolve, reject) =>
    gz(buf, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

// ── Distributed lease ────────────────────────────────────────────────────────

async function acquireLease(config: ServerConfig): Promise<boolean> {
  const sb = getServiceClient(config);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  // Ensure the row exists (expired lease) without clobbering a live one.
  const { data: existing } = await sb
    .from('app_runtime_config')
    .select('key')
    .eq('key', LOCK_KEY)
    .maybeSingle();
  if (!existing) {
    const { error } = await sb
      .from('app_runtime_config')
      .insert({ key: LOCK_KEY, value: { lease_until: leaseUntil } as any });
    // A concurrent replica may have inserted first — fall through to the
    // conditional update below, which will then correctly refuse.
    if (!error) return true;
  }
  // Single atomic conditional UPDATE: only succeeds when the stored lease has
  // already expired. Two replicas racing here → exactly one gets a row back.
  const { data } = await sb
    .from('app_runtime_config')
    .update({ value: { lease_until: leaseUntil } as any })
    .eq('key', LOCK_KEY)
    .lt('value->>lease_until', now.toISOString())
    .select('key');
  return Array.isArray(data) && data.length > 0;
}

async function releaseLease(config: ServerConfig): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb
      .from('app_runtime_config')
      .update({ value: { lease_until: new Date(0).toISOString() } as any })
      .eq('key', LOCK_KEY);
  } catch { /* best effort */ }
}

// ── Core update ──────────────────────────────────────────────────────────────

function downloadUrl(editionId: string, licenseKey: string): string {
  const params = new URLSearchParams({
    edition_id: editionId,
    license_key: licenseKey,
    suffix: 'tar.gz',
  });
  return `https://download.maxmind.com/app/geoip_download?${params.toString()}`;
}

/** Strip anything credential-shaped out of a message before it is stored/logged. */
export function redactSecrets(msg: string): string {
  return msg
    .replace(/license_key=[^&\s]*/gi, 'license_key=***')
    .replace(/account_id=[^&\s]*/gi, 'account_id=***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***');
}

export interface UpdateDeps {
  /** Injectable for tests — returns the raw `.tar.gz` bytes. */
  fetchArchive?: (url: string, auth: string) => Promise<Buffer>;
}

async function defaultFetchArchive(url: string, auth: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'selfhost-geoip-updater/1.0' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`MaxMind download failed with HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one update. Safe to call concurrently from many replicas — all but one
 * will return `{ status: 'skipped', reason: 'another update is in progress' }`.
 */
export async function runMaxmindUpdate(
  config: ServerConfig,
  opts: { manual?: boolean; deps?: UpdateDeps } = {},
): Promise<UpdateOutcome> {
  const settings = await getMapGeoSettings(config).catch(() => null);
  if (!settings) return { ok: false, status: 'failed', reason: 'Cannot read map_geo_settings' };

  const { maxmind_local: local, maxmind_update: upd } = settings;
  if (!local.enabled) return { ok: false, status: 'skipped', reason: 'MaxMind Local is disabled' };
  if (!local.db_path) return { ok: false, status: 'skipped', reason: 'No database path configured' };
  if (!opts.manual && upd.mode !== 'auto') {
    return { ok: false, status: 'skipped', reason: 'Auto-update is disabled' };
  }
  if (!upd.account_id || !upd.license_key) {
    return { ok: false, status: 'skipped', reason: 'MaxMind account ID / license key not configured' };
  }
  if (!opts.manual) {
    const intervalHours = Math.max(MIN_INTERVAL_HOURS, Number(upd.interval_hours) || MIN_INTERVAL_HOURS);
    const last = upd.last_run_at ? new Date(upd.last_run_at).getTime() : 0;
    if (last && Date.now() - last < intervalHours * 3600 * 1000) {
      return { ok: true, status: 'skipped', reason: 'Interval has not elapsed yet' };
    }
  }

  if (!(await acquireLease(config))) {
    return { ok: true, status: 'skipped', reason: 'Another replica is already updating' };
  }

  const dbPath = local.db_path;
  const dir = path.dirname(dbPath);
  const stagePath = `${dbPath}.new-${process.pid}-${Date.now()}`;
  try {
    // The directory must already exist — mounting the volume is the operator's
    // job (see Map & Geo diagnostics). We never create data volumes from code.
    await fs.access(dir).catch(() => {
      throw new Error(`Data directory does not exist: ${dir}. Mount a persistent volume there.`);
    });

    const auth = Buffer.from(`${upd.account_id}:${upd.license_key}`).toString('base64');
    const fetcher = opts.deps?.fetchArchive ?? defaultFetchArchive;
    const archive = await fetcher(downloadUrl(upd.edition_id || 'GeoLite2-City', upd.license_key), auth);

    const tarBuf = await gunzip(archive);
    const mmdb = extractMmdbFromTar(tarBuf);
    if (!mmdb) throw new Error('Archive did not contain an .mmdb file');

    await fs.writeFile(stagePath, mmdb);
    const invalid = await validateMmdbCandidate(stagePath);
    if (invalid) throw new Error(invalid);

    // Atomic swap — same directory, so rename(2) is a single inode flip. The
    // previous healthy DB is only ever unlinked *after* validation passed.
    await fs.rename(stagePath, dbPath);
    invalidateMaxmindReader(dbPath);

    await patchMapGeoSettings(config, {
      maxmind_update: {
        ...upd,
        last_run_at: new Date().toISOString(),
        last_status: 'success',
        last_error: null,
      },
    } as any);
    console.log('[geo:maxmind_update] database updated', { db_path: dbPath, size_bytes: mmdb.length });
    return { ok: true, status: 'updated', db_path: dbPath, size_bytes: mmdb.length };
  } catch (err) {
    const reason = redactSecrets((err as Error).message || 'Unknown error');
    await fs.unlink(stagePath).catch(() => {});
    await patchMapGeoSettings(config, {
      maxmind_update: {
        ...upd,
        last_run_at: new Date().toISOString(),
        last_status: 'failed',
        last_error: reason,
      },
    } as any).catch(() => {});
    console.warn('[geo:maxmind_update] update failed:', reason);
    return { ok: false, status: 'failed', reason };
  } finally {
    await releaseLease(config);
  }
}

/** Manual (admin button) entrypoint. */
export function runMaxmindUpdateNow(config: ServerConfig, deps?: UpdateDeps): Promise<UpdateOutcome> {
  return runMaxmindUpdate(config, { manual: true, deps });
}

// ── Ticker ───────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the in-process auto-update ticker. Idempotent — calling it twice never
 * creates a second scheduler. A missing/expired MaxMind setup only produces a
 * skipped run; startup never fails because MaxMind is unavailable.
 */
export function startMaxmindUpdateTicker(config: ServerConfig): void {
  if (timer) return;
  const tick = () => {
    runMaxmindUpdate(config).catch((e) =>
      console.warn('[geo:maxmind_update] ticker error:', redactSecrets(e?.message || String(e))),
    );
  };
  // Delay the first run so boot is never blocked by a large download.
  setTimeout(tick, 60_000).unref?.();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}

/** Test seam. */
export function __stopMaxmindUpdateTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
