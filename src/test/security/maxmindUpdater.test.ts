/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase/provider test doubles are intentionally untyped. */
/**
 * MaxMind auto-updater: atomicity, credential redaction and lease behaviour.
 *
 * A failed or corrupt download must NEVER replace a healthy database, and a
 * license key must never reach logs or the settings row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const state = {
  dir: '',
  dbPath: '',
  settings: null as any,
  patched: [] as any[],
  leaseTaken: false,
  leaseInsertFails: false,
};

vi.mock('../../../server/services/geo/settings', () => ({
  getMapGeoSettings: async () => state.settings,
  patchMapGeoSettings: async (_c: any, patch: any) => { state.patched.push(patch); return state.settings; },
}));

let validationError: string | null = null;
vi.mock('../../../server/services/geo/maxmindLocal', () => ({
  validateMmdbCandidate: async () => validationError,
  invalidateMaxmindReader: () => {},
  lookupMaxmindLocal: async () => null,
  checkMaxmindLocalHealth: async () => ({ ok: true }),
}));

vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => ({
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        lt: () => chain,
        gt: () => chain,
        maybeSingle: async () => ({ data: null }),
        insert: async () => (state.leaseInsertFails ? { error: { message: 'duplicate key' } } : { error: null }),
        upsert: async () => (state.leaseInsertFails ? { error: { message: 'duplicate key' } } : { error: null }),
        update: () => chain,
        delete: () => chain,
      };
      return chain;
    },
    rpc: async () => ({ data: !state.leaseInsertFails, error: null }),
  }),
}));

const { runMaxmindUpdate, extractMmdbFromTar, redactSecrets, MIN_INTERVAL_HOURS } =
  await import('../../../server/services/geo/maxmindUpdater');

const cfg = {} as any;

/** Build a minimal ustar archive containing one file. */
function tarWith(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148); // checksum placeholder
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

/** Members + the two zero blocks that terminate a real archive. */
function tarArchive(...members: Buffer[]): Buffer {
  return Buffer.concat([...members, Buffer.alloc(1024)]);
}

const FAKE_DB = Buffer.alloc(2 * 1024 * 1024, 7);

beforeEach(async () => {
  state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmdb-'));
  state.dbPath = path.join(state.dir, 'GeoLite2-City.mmdb');
  state.patched = [];
  state.leaseInsertFails = false;
  validationError = null;
  state.settings = {
    maxmind_local: { enabled: true, db_path: state.dbPath, auto_reload: true, cache_ttl_seconds: 600 },
    maxmind_update: {
      mode: 'auto', account_id: '12345', license_key: 'SUPER_SECRET_KEY',
      edition_id: 'GeoLite2-City', interval_hours: 24,
      last_run_at: null, last_status: null, last_error: null,
    },
  };
});

afterEach(async () => { await fs.rm(state.dir, { recursive: true, force: true }); });

describe('tar extraction', () => {
  it('finds the .mmdb member and ignores siblings', () => {
    const tar = tarArchive(
      tarWith('GeoLite2-City_20260101/COPYRIGHT.txt', Buffer.from('c')),
      tarWith('GeoLite2-City_20260101/GeoLite2-City.mmdb', FAKE_DB),
    );
    const out = extractMmdbFromTar(tar);
    expect(out?.length).toBe(FAKE_DB.length);
  });

  it('returns null when no .mmdb member exists', () => {
    expect(extractMmdbFromTar(tarArchive(tarWith('README.txt', Buffer.from('x'))))).toBeNull();
  });
});

describe('secret redaction', () => {
  it('scrubs license keys, account ids and basic auth', () => {
    const msg = redactSecrets('GET https://x/?edition_id=E&license_key=SUPER_SECRET_KEY&account_id=12345 Basic YWJjOmRlZg==');
    expect(msg).not.toContain('SUPER_SECRET_KEY');
    expect(msg).not.toContain('12345');
    expect(msg).not.toContain('YWJjOmRlZg==');
  });
});

describe('runMaxmindUpdate', () => {
  const goodArchive = async () => gzipSync(tarArchive(tarWith('GeoLite2-City_20260101/GeoLite2-City.mmdb', FAKE_DB)));

  it('downloads, validates and atomically installs the database', async () => {
    const r = await runMaxmindUpdate(cfg, { manual: true, deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('updated');
    const stat = await fs.stat(state.dbPath);
    expect(stat.size).toBe(FAKE_DB.length);
    // No staging leftovers.
    const leftovers = (await fs.readdir(state.dir)).filter((f) => f.includes('.new-'));
    expect(leftovers).toEqual([]);
    expect(state.patched.at(-1).maxmind_update.last_status).toBe('success');
  });

  it('keeps the previous healthy DB when the download fails', async () => {
    await fs.writeFile(state.dbPath, Buffer.from('OLD-BUT-HEALTHY'));
    const r = await runMaxmindUpdate(cfg, {
      manual: true,
      deps: { fetchArchive: async () => { throw new Error('MaxMind download failed with HTTP 401 license_key=SUPER_SECRET_KEY'); } },
    });
    expect(r.status).toBe('failed');
    expect(await fs.readFile(state.dbPath, 'utf8')).toBe('OLD-BUT-HEALTHY');
    expect(r.reason).not.toContain('SUPER_SECRET_KEY');
    expect(state.patched.at(-1).maxmind_update.last_error).not.toContain('SUPER_SECRET_KEY');
  });

  it('keeps the previous DB when the downloaded file fails validation', async () => {
    await fs.writeFile(state.dbPath, Buffer.from('OLD-BUT-HEALTHY'));
    validationError = 'File is not a valid MaxMind database';
    const r = await runMaxmindUpdate(cfg, { manual: true, deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('failed');
    expect(await fs.readFile(state.dbPath, 'utf8')).toBe('OLD-BUT-HEALTHY');
    expect((await fs.readdir(state.dir)).filter((f) => f.includes('.new-'))).toEqual([]);
  });

  it('skips without credentials instead of failing loudly', async () => {
    state.settings.maxmind_update.license_key = '';
    const r = await runMaxmindUpdate(cfg, { manual: true, deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/license key/i);
  });

  it('skips scheduled runs when the mode is manual', async () => {
    state.settings.maxmind_update.mode = 'manual';
    const r = await runMaxmindUpdate(cfg, { deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('skipped');
    // …but the admin button still works.
    const manual = await runMaxmindUpdate(cfg, { manual: true, deps: { fetchArchive: goodArchive } });
    expect(manual.status).toBe('updated');
  });

  it('respects the minimum interval for scheduled runs', async () => {
    state.settings.maxmind_update.last_run_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    state.settings.maxmind_update.interval_hours = 1; // clamped up to MIN_INTERVAL_HOURS
    expect(MIN_INTERVAL_HOURS).toBeGreaterThanOrEqual(24);
    const r = await runMaxmindUpdate(cfg, { deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/interval/i);
  });

  it('yields to another replica that already holds the lease', async () => {
    state.leaseInsertFails = true;
    const r = await runMaxmindUpdate(cfg, { manual: true, deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/replica/i);
  });

  it('fails clearly when the data volume is not mounted', async () => {
    state.settings.maxmind_local.db_path = path.join(state.dir, 'missing-volume', 'db.mmdb');
    const r = await runMaxmindUpdate(cfg, { manual: true, deps: { fetchArchive: goodArchive } });
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/directory does not exist|volume/i);
  });
});
