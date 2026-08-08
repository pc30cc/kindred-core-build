/**
 * Local MaxMind MMDB reader — the canonical self-hosted geo source.
 *
 * Operators mount a GeoLite2/GeoIP2 `.mmdb` file on the server filesystem
 * and point `map_geo_settings.maxmind_local.db_path` at it (Super Admin →
 * Map & Geo). No external call is ever made by this module.
 *
 * Readers are cached in-process keyed by file path so we don't reopen the
 * file on every lookup. When `autoReload` is enabled, the file's mtime is
 * checked and the reader is re-opened transparently if the file changed
 * (this is what makes the atomic updater's rename visible without restart).
 *
 * Failure modes (missing file, bad format, IP not in DB) all return null so
 * callers fall back to the next geo source. Nothing here ever throws.
 */
import { promises as fs } from 'node:fs';
import { open, type Reader, type CityResponse } from 'maxmind';

interface CachedReader {
  reader: Reader<CityResponse>;
  mtimeMs: number;
}

const READERS = new Map<string, CachedReader>();

/** Drop the cached reader for a path (used after an atomic DB replace). */
export function invalidateMaxmindReader(dbPath?: string): void {
  if (dbPath) READERS.delete(dbPath);
  else READERS.clear();
}

async function getReader(dbPath: string, autoReload: boolean): Promise<Reader<CityResponse> | null> {
  try {
    const stat = await fs.stat(dbPath);
    if (!stat.isFile()) return null;
    const cached = READERS.get(dbPath);
    if (cached && (!autoReload || cached.mtimeMs === stat.mtimeMs)) {
      return cached.reader;
    }
    const reader = await open<CityResponse>(dbPath);
    READERS.set(dbPath, { reader, mtimeMs: stat.mtimeMs });
    return reader;
  } catch (err) {
    console.warn('[geo:maxmind_local] cannot open DB:', dbPath, (err as Error).message);
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
  opts: { autoReload?: boolean } = {},
): Promise<LocalLookupResult | null> {
  const reader = await getReader(dbPath, !!opts.autoReload);
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
    const meta: any = (reader as any).metadata ?? {};
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
