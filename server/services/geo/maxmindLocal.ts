/**
 * Local MaxMind MMDB reader.
 *
 * Self-hosted, no external calls. Operators mount a GeoLite2/GeoIP2 .mmdb
 * file on the server filesystem and point the provider config at it.
 *
 * Readers are cached in-process keyed by file path so we don't reopen the
 * file on every lookup. When `autoReload` is enabled, the file's mtime is
 * checked and the reader is re-opened transparently if the file changed.
 *
 * Failure modes (missing file, bad format, IP not in DB) all return null so
 * callers fall back to centroid resolution.
 */
import { promises as fs } from 'node:fs';
import { open, type Reader, type CityResponse } from 'maxmind';

interface CachedReader {
  reader: Reader<CityResponse>;
  mtimeMs: number;
}

const READERS = new Map<string, CachedReader>();

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

/**
 * Health check — returns metadata about the loaded DB or null if not loadable.
 */
export async function checkMaxmindLocalHealth(dbPath: string): Promise<{
  ok: boolean;
  size_bytes?: number;
  mtime?: string;
  error?: string;
}> {
  try {
    const stat = await fs.stat(dbPath);
    if (!stat.isFile()) return { ok: false, error: 'Not a file' };
    await open<CityResponse>(dbPath);
    return { ok: true, size_bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}