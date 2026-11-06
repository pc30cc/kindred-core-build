/**
 * Local MaxMind MMDB reader — the canonical self-hosted geo source.
 *
 * Operators mount a GeoLite2/GeoIP2 `.mmdb` file on the server filesystem
 * and point `map_geo_settings.maxmind_local.db_path` at it (Super Admin →
 * Map & Geo). No external call is ever made by this module.
 *
 * Readers are cached in-process keyed by file path so we don't reopen the
 * file on every lookup. The file is re-checked at most every RECHECK_MS: with
 * `autoReload` enabled, a changed mtime re-opens the reader transparently, and
 * a file mounted after startup is picked up the same way. The in-app updater
 * drops the cached reader of that file after its atomic rename, in every
 * backend process (the cache bus's `geo:<path>`), so its new database is live
 * at once. Concurrent lookups that find no fresh reader share one open: each
 * open reads the whole file (tens of MB) into memory.
 *
 * Failure modes (missing file, bad format, IP not in DB) all return null so
 * callers fall back to the next geo source. Nothing here ever throws.
 */
import { promises as fs } from 'node:fs';
import { open, type Reader, type CityResponse } from 'maxmind';
import { onInvalidate } from '../../lib/cacheBus.js';
import { maxmindPathKey } from './maxmindScope.js';

interface CachedReader {
  /** null: the file was missing, not a regular file, or unreadable at checkedAt. */
  reader: Reader<CityResponse> | null;
  mtimeMs: number;
  checkedAt: number;
}

/**
 * How often a lookup re-checks the file on disk (existence, mtime). Every
 * visitor request resolves geo, so a stat() per lookup — and, with the file
 * missing, a warning line per lookup — is paid on the hot path; under load
 * that logging alone was thousands of synchronous writes a minute.
 */
const RECHECK_MS = 30_000;
/** A path that cannot be opened is reported at most this often. */
const WARN_EVERY_MS = 10 * 60_000;

const READERS = new Map<string, CachedReader>();
/** The check (and open) in progress per path, shared by every lookup that waits for it. */
const OPENING = new Map<string, Promise<Reader<CityResponse> | null>>();
const WARNED_AT = new Map<string, number>();
/** Bumped by every invalidation: an open that started before one does not cache its reader. */
let generation = 0;

/** Drop the cached reader for a path (used after an atomic DB replace). */
export function invalidateMaxmindReader(dbPath?: string): void {
  generation += 1;
  if (dbPath) {
    READERS.delete(dbPath);
    OPENING.delete(dbPath);
  } else {
    READERS.clear();
    OPENING.clear();
  }
}

// The updater publishes `geo:<key of the file>` after it swapped a new file in
// (maxmindUpdater.ts, maxmindScope.ts), so every backend process on the same
// disk (another cluster worker, the other container of a deploy) reopens that
// file at once, also with auto_reload off. Only that file's reader: an 'all'
// (a plan or settings save) or the bus's resync calls this with no key and
// leaves the readers alone, since nothing about the file changed, and the
// mtime check above still runs every RECHECK_MS.
onInvalidate('geo', (key) => {
  if (!key) return;
  for (const dbPath of new Set([...READERS.keys(), ...OPENING.keys()])) {
    if (maxmindPathKey(dbPath) === key) invalidateMaxmindReader(dbPath);
  }
});

function getReader(dbPath: string, autoReload: boolean, fresh: boolean): Promise<Reader<CityResponse> | null> {
  const cached = READERS.get(dbPath);
  if (cached && !fresh && Date.now() - cached.checkedAt < RECHECK_MS) return Promise.resolve(cached.reader);
  // One check per path at a time: a burst of lookups after a swap (or the
  // first lookups after a start) must not each read the whole file.
  const inFlight = OPENING.get(dbPath);
  if (inFlight) return inFlight;
  const check = checkReader(dbPath, autoReload, cached);
  OPENING.set(dbPath, check);
  void check.finally(() => {
    if (OPENING.get(dbPath) === check) OPENING.delete(dbPath);
  });
  return check;
}

async function checkReader(
  dbPath: string,
  autoReload: boolean,
  cached: CachedReader | undefined,
): Promise<Reader<CityResponse> | null> {
  const now = Date.now();
  const gen = generation;
  // An invalidation while this ran: the next lookup checks again.
  const remember = (entry: CachedReader) => {
    if (gen === generation) READERS.set(dbPath, entry);
  };
  try {
    const stat = await fs.stat(dbPath);
    if (!stat.isFile()) {
      remember({ reader: null, mtimeMs: 0, checkedAt: now });
      return null;
    }
    if (cached?.reader && (!autoReload || cached.mtimeMs === stat.mtimeMs)) {
      cached.checkedAt = now;
      return cached.reader;
    }
    const reader = await open<CityResponse>(dbPath);
    remember({ reader, mtimeMs: stat.mtimeMs, checkedAt: now });
    return reader;
  } catch (err) {
    remember({ reader: null, mtimeMs: 0, checkedAt: now });
    if (now - (WARNED_AT.get(dbPath) ?? 0) >= WARN_EVERY_MS) {
      WARNED_AT.set(dbPath, now);
      console.warn('[geo:maxmind_local] cannot open DB:', dbPath, (err as Error).message);
    }
    return null;
  }
}

export interface LocalLookupResult {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  /** IANA timezone from the MMDB `location.time_zone` field, when present. */
  timezone: string | null;
}

export async function lookupMaxmindLocal(
  dbPath: string,
  ip: string,
  /** fresh: re-check the file now instead of within RECHECK_MS (admin test lookups). */
  opts: { autoReload?: boolean; fresh?: boolean } = {},
): Promise<LocalLookupResult | null> {
  const reader = await getReader(dbPath, !!opts.autoReload, !!opts.fresh);
  if (!reader) return null;
  try {
    const r = reader.get(ip);
    if (!r) return null;
    return {
      country: r.country?.names?.en ?? null,
      country_code: r.country?.iso_code ?? null,
      region: r.subdivisions?.[0]?.names?.en ?? null,
      city: r.city?.names?.en ?? null,
      latitude: r.location?.latitude ?? null,
      longitude: r.location?.longitude ?? null,
      timezone: r.location?.time_zone ?? null,
    };
  } catch (err) {
    console.warn('[geo:maxmind_local] lookup failed:', (err as Error).message);
    return null;
  }
}

export interface MaxmindLocalHealth {
  ok: boolean;
  /** Path stat succeeded and it is a regular file. */
  file_exists: boolean;
  /** The process can read the file. */
  readable: boolean;
  /** The maxmind library could parse it (i.e. it is a real MMDB). */
  usable: boolean;
  size_bytes?: number;
  mtime?: string;
  /** MMDB metadata — e.g. 'GeoLite2-City'. */
  database_type?: string;
  /** MMDB build timestamp (ISO). */
  build_epoch?: string;
  error?: string;
}

/**
 * Deep health check — separates "missing", "unreadable" and "corrupt" so the
 * admin diagnostics panel can tell operators exactly what is wrong.
 */
export async function checkMaxmindLocalHealth(dbPath: string): Promise<MaxmindLocalHealth> {
  const base: MaxmindLocalHealth = { ok: false, file_exists: false, readable: false, usable: false };
  if (!dbPath) return { ...base, error: 'No database path configured' };
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    return { ...base, error: `File not found: ${(err as Error).message}` };
  }
  if (!stat.isFile()) return { ...base, error: 'Path exists but is not a regular file' };
  base.file_exists = true;
  base.size_bytes = stat.size;
  base.mtime = stat.mtime.toISOString();
  try {
    await fs.access(dbPath, (await import('node:fs')).constants.R_OK);
    base.readable = true;
  } catch {
    return { ...base, error: 'File exists but is not readable by the server process' };
  }
  try {
    const reader = await open<CityResponse>(dbPath);
    const meta = ((reader as { metadata?: { databaseType?: unknown; buildEpoch?: unknown } }).metadata ?? {});
    base.usable = true;
    base.ok = true;
    if (meta.databaseType) base.database_type = String(meta.databaseType);
    if (meta.buildEpoch) {
      const d = meta.buildEpoch instanceof Date ? meta.buildEpoch : new Date(Number(meta.buildEpoch) * 1000);
      if (!Number.isNaN(d.getTime())) base.build_epoch = d.toISOString();
    }
    return base;
  } catch (err) {
    return { ...base, error: `File is not a valid MMDB database: ${(err as Error).message}` };
  }
}

/**
 * Validate a candidate `.mmdb` file before it replaces a healthy database.
 * Returns null when valid, or a human-readable reason when it must be rejected.
 */
export async function validateMmdbCandidate(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    // A real GeoLite2-City DB is tens of MB; anything under 1 MB is a truncated
    // download or an HTML error page saved to disk.
    if (stat.size < 1024 * 1024) return `Downloaded file is too small (${stat.size} bytes)`;
  } catch (err) {
    return `Downloaded file missing: ${(err as Error).message}`;
  }
  try {
    const reader = await open<CityResponse>(filePath);
    // Probe a well-known public address so a structurally-valid but empty DB
    // is still caught. A null lookup is acceptable; a throw is not.
    reader.get('8.8.8.8');
    return null;
  } catch (err) {
    return `Not a valid MMDB database: ${(err as Error).message}`;
  }
}
