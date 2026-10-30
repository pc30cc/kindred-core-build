// @vitest-environment node
/**
 * 290 — the platform's own logo, uploaded once (Super Admin → Branding →
 * Visual identity), on a database built by the whole chain, through the real
 * routes and data layer (postgres-only) with the local storage provider:
 *
 *   - the migration: twelve nullable columns on platform_branding, no
 *     default, nothing for anon or authenticated; a second run changes
 *     nothing;
 *   - POST …/platform-branding/assets/:variant stores keys only
 *     (platform/brand/<uuid>-<variant>.<ext>), never a URL; an unsafe SVG, a
 *     wrong icon size or a dark logo before a light one is refused and
 *     writes nothing; a replaced file is deleted, but never an email PNG
 *     (the emails already sent show it);
 *   - the dark logo keeps the light one's shape (an email draws both at one
 *     size): another shape is refused, and a new light logo of another shape
 *     puts the dark pair back to the light one;
 *   - the public config sends the uploads as URLs (`brand_assets`), and the
 *     one resolver answers them over the kit, in both editions;
 *   - DELETE puts the brand's default back (the light logo takes its pair).
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const MIGRATION = resolve(process.cwd(), 'database/migrations/290_platform_brand_assets.sql');
const COLUMNS = [
  'logo_dark_storage_key', 'logo_email_dark_height', 'logo_email_dark_storage_key', 'logo_email_dark_width', 'logo_email_height',
  'logo_email_light_storage_key', 'logo_email_width', 'logo_light_storage_key', 'symbol_apple_touch_storage_key', 'symbol_png_192_storage_key', 'symbol_png_512_storage_key', 'symbol_storage_key',
];
const CDN = 'https://cdn.example.test';
const file = (p: string) => readFileSync(resolve(process.cwd(), p));
const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64');
const LOGO_SVG = file('public/brand/intl/respok-thread-horizontal-color.svg');
const LOGO_PNG = file('public/brand/intl/email/respok-logo.png');
/** Another shape (360x139, against 400x92). */
const OTHER_SHAPE_PNG = file('public/brand/webyar/email/webyar-logo.png');
const ICONS = {
  apple_touch_180: b64(file('public/brand/intl/apple-touch-icon.png')),
  png_192: b64(file('public/brand/intl/android-chrome-192x192.png')),
  png_512: b64(file('public/brand/intl/android-chrome-512x512.png')),
};

suite('290 — the platform\'s own logo, uploaded once (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let server: http.Server;
  let storageDir: string;
  let config: import('../../../server/config.js').ServerConfig;
  let assets: typeof import('../../../server/services/platformBrandAssets.js');
  const admin = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;

  function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
    return new Promise((done, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {}, raw }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  const row = async () => (await q(`SELECT * FROM public.platform_branding LIMIT 1`))[0] ?? {};
  const onDisk = (key: unknown) => existsSync(join(storageDir, String(key)));

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `brand290_${Date.now()}`);
    storageDir = mkdtempSync(join(tmpdir(), 'brand290-'));
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'd'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, 'owner@example.test', 'Owner')`, [admin]);
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    await q(`DELETE FROM public.platform_domains`);
    await q(`INSERT INTO public.platform_domains (app_base_url) VALUES ('https://app.example.test')`);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_storage_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'local', config: { local_path: storageDir, public_url: CDN } })],
    );
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    vi.doMock('../../../server/lib/workspaceAuth.js', () => ({ requirePlatformAdmin: async () => admin }));
    const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');
    const { platformPublicRouter } = await import('../../../server/routes/platformPublic.js');
    assets = await import('../../../server/services/platformBrandAssets.js');
    (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { serverConfig: config });
      next();
    });
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/admin/management', adminManagementRouter);
    app.use('/api/platform/public', platformPublicRouter);
    server = http.createServer(app).listen(0);
  }, 600_000);

  afterAll(async () => {
    server?.close();
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  describe('the migration', () => {
    it('adds twelve nullable columns with no default, for the backend only', async () => {
      const cols = await q(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'platform_branding' AND column_name = ANY($1) ORDER BY column_name`,
        [COLUMNS],
      );
      expect(cols.map((c) => c.column_name)).toEqual(COLUMNS);
      for (const c of cols) {
        expect(c.is_nullable, String(c.column_name)).toBe('YES');
        expect(c.column_default, String(c.column_name)).toBeNull();
        expect(c.data_type, String(c.column_name)).toBe(String(c.column_name).endsWith('_key') ? 'text' : 'integer');
      }
      for (const role of ['anon', 'authenticated']) {
        const [grant] = await q(`SELECT has_table_privilege($1, 'public.platform_branding', 'SELECT') AS sel`, [role]);
        expect(grant.sel, role).toBe(false);
      }
      const [svc] = await q(`SELECT has_column_privilege('service_role', 'public.platform_branding', 'logo_light_storage_key', 'UPDATE') AS upd`);
      expect(svc.upd).toBe(true);
    });

    it('a second run changes nothing (and keeps an upload)', async () => {
      await q(`INSERT INTO public.platform_branding (logo_light_storage_key) SELECT 'platform/brand/keep.svg' WHERE NOT EXISTS (SELECT 1 FROM public.platform_branding)`);
      await q(`UPDATE public.platform_branding SET logo_light_storage_key = 'platform/brand/keep.svg'`);
      await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
      expect((await row()).logo_light_storage_key).toBe('platform/brand/keep.svg');
      expect(await q(`SELECT current_setting('lock_timeout') AS lt`)).toEqual([{ lt: '0' }]);
      await q(`UPDATE public.platform_branding SET logo_light_storage_key = NULL`);
    });
  });

  describe('the upload', () => {
    it('refuses a dark logo before a light one, an unsafe SVG and a wrong icon, writing nothing', async () => {
      const dark = await call('POST', '/api/admin/management/platform-branding/assets/logo-dark', {
        contentType: 'image/svg+xml', data: b64(LOGO_SVG), png: b64(LOGO_PNG),
      });
      expect(dark).toMatchObject({ status: 409, json: { error: 'logo_light_required' } });
      const unsafe = await call('POST', '/api/admin/management/platform-branding/assets/logo-light', {
        contentType: 'image/svg+xml', data: b64('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"/>'), png: b64(LOGO_PNG),
      });
      expect(unsafe).toMatchObject({ status: 400, json: { error: 'svg_not_allowed' } });
      const wrongIcon = await call('POST', '/api/admin/management/platform-branding/assets/symbol', {
        contentType: 'image/png', data: ICONS.png_512, icons: { ...ICONS, apple_touch_180: ICONS.png_192 },
      });
      expect(wrongIcon).toMatchObject({ status: 400, json: { error: 'png_wrong_size' } });
      const noCopy = await call('POST', '/api/admin/management/platform-branding/assets/logo-light', { contentType: 'image/svg+xml', data: b64(LOGO_SVG) });
      expect(noCopy).toMatchObject({ status: 400, json: { error: 'png_required' } });
      const unknown = await call('POST', '/api/admin/management/platform-branding/assets/favicon', { contentType: 'image/png', data: ICONS.png_192 });
      expect(unknown.status).toBe(404);
      const r = await row();
      for (const c of COLUMNS) expect(r[c] ?? null, c).toBeNull();
    });

    it('stores keys only, and every surface reads the URLs', async () => {
      const res = await call('POST', '/api/admin/management/platform-branding/assets/logo-light', {
        contentType: 'image/svg+xml', data: b64(LOGO_SVG), png: b64(LOGO_PNG),
      });
      expect(res.status).toBe(200);
      const r = await row();
      expect(String(r.logo_light_storage_key)).toMatch(/^platform\/brand\/[0-9a-f-]{36}-logo-light\.svg$/);
      expect(String(r.logo_email_light_storage_key)).toMatch(/^platform\/brand\/[0-9a-f-]{36}-logo-light-email\.png$/);
      expect([r.logo_email_width, r.logo_email_height]).toEqual([400, 92]);
      // Keys, never a URL, in the row.
      expect(JSON.stringify(r)).not.toContain(CDN);
      expect(onDisk(r.logo_light_storage_key)).toBe(true);
      expect(readFileSync(join(storageDir, String(r.logo_light_storage_key)), 'utf8')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(res.json.assets).toMatchObject({ logo_light: `${CDN}/${r.logo_light_storage_key}`, logo_png_light: `${CDN}/${r.logo_email_light_storage_key}`, logo_png_width: 400 });

      const symbol = await call('POST', '/api/admin/management/platform-branding/assets/symbol', {
        contentType: 'image/png', data: ICONS.png_512, icons: ICONS,
      });
      expect(symbol.status).toBe(200);
      const after = await row();
      for (const c of ['symbol_storage_key', 'symbol_apple_touch_storage_key', 'symbol_png_192_storage_key', 'symbol_png_512_storage_key']) {
        expect(onDisk(after[c]), c).toBe(true);
      }

      const pub = await call('GET', '/api/platform/public/config');
      expect(pub.json.brand_assets).toMatchObject({
        logo_light: `${CDN}/${after.logo_light_storage_key}`,
        logo_dark: null,
        symbol: `${CDN}/${after.symbol_storage_key}`,
        icon_192: `${CDN}/${after.symbol_png_192_storage_key}`,
      });
      expect(pub.raw).not.toContain('storage_key');
      expect(pub.raw).not.toContain('app.example.test');

      const resolved = await assets.resolveBrandAssets(config);
      expect(resolved).toMatchObject({
        source: 'custom',
        logo: { light: `${CDN}/${after.logo_light_storage_key}`, dark: `${CDN}/${after.logo_light_storage_key}` },
        logoPng: { light: `${CDN}/${after.logo_email_light_storage_key}`, width: 400, height: 92 },
        icons: { appleTouch180: `${CDN}/${after.symbol_apple_touch_storage_key}` },
      });
      // The Iranian edition reads the same upload.
      expect((await assets.resolveBrandAssets(config, { edition: 'iran' }))?.source).toBe('custom');
    });

    it('a replaced logo gets a new key; its old file is deleted, its old email PNG kept', async () => {
      const before = await row();
      const res = await call('POST', '/api/admin/management/platform-branding/assets/logo-light', {
        contentType: 'image/png', data: b64(LOGO_PNG), png: b64(LOGO_PNG),
      });
      expect(res.status).toBe(200);
      const after = await row();
      expect(after.logo_light_storage_key).not.toBe(before.logo_light_storage_key);
      expect(String(after.logo_light_storage_key)).toMatch(/-logo-light\.png$/);
      expect(onDisk(before.logo_light_storage_key)).toBe(false);
      // Every email already sent shows it from that URL.
      expect(after.logo_email_light_storage_key).not.toBe(before.logo_email_light_storage_key);
      expect(onDisk(before.logo_email_light_storage_key)).toBe(true);
      expect(onDisk(after.logo_light_storage_key)).toBe(true);

      const dark = await call('POST', '/api/admin/management/platform-branding/assets/logo-dark', {
        contentType: 'image/svg+xml', data: b64(LOGO_SVG), png: b64(LOGO_PNG),
      });
      expect(dark.status).toBe(200);
      const withDark = await row();
      expect((dark.json.assets as Record<string, unknown>).logo_dark).toBe(`${CDN}/${withDark.logo_dark_storage_key}`);
      expect([withDark.logo_email_dark_width, withDark.logo_email_dark_height]).toEqual([400, 92]);
    });

    it('the dark logo keeps the light one\'s shape', async () => {
      const before = await row();
      const other = await call('POST', '/api/admin/management/platform-branding/assets/logo-dark', {
        contentType: 'image/png', data: b64(OTHER_SHAPE_PNG), png: b64(OTHER_SHAPE_PNG),
      });
      expect(other).toMatchObject({ status: 409, json: { error: 'logo_dark_ratio' } });
      expect(await row()).toEqual(before);

      // The same shape again: the dark pair stays.
      const same = await call('POST', '/api/admin/management/platform-branding/assets/logo-light', {
        contentType: 'image/png', data: b64(LOGO_PNG), png: b64(LOGO_PNG),
      });
      expect(same.status).toBe(200);
      expect(same.json.dark_reset).toBeUndefined();
      const kept = await row();
      expect(kept.logo_dark_storage_key).toBe(before.logo_dark_storage_key);
      expect(kept.logo_email_dark_storage_key).toBe(before.logo_email_dark_storage_key);

      // A light logo of another shape: the dark pair goes, its email PNG stays in storage.
      const reshaped = await call('POST', '/api/admin/management/platform-branding/assets/logo-light', {
        contentType: 'image/png', data: b64(OTHER_SHAPE_PNG), png: b64(OTHER_SHAPE_PNG),
      });
      expect(reshaped.status).toBe(200);
      expect(reshaped.json.dark_reset).toBe(true);
      const after = await row();
      for (const c of ['logo_dark_storage_key', 'logo_email_dark_storage_key', 'logo_email_dark_width', 'logo_email_dark_height']) expect(after[c], c).toBeNull();
      expect([after.logo_email_width, after.logo_email_height]).toEqual([360, 139]);
      expect(onDisk(before.logo_dark_storage_key)).toBe(false);
      expect(onDisk(before.logo_email_dark_storage_key)).toBe(true);
      expect((reshaped.json.assets as Record<string, unknown>).logo_dark).toBeNull();
      const resolved = await assets.resolveBrandAssets(config);
      expect(resolved?.logo.dark).toBe(`${CDN}/${after.logo_light_storage_key}`);
      expect(resolved?.logoPng).toMatchObject({ dark: `${CDN}/${after.logo_email_light_storage_key}`, width: 360, height: 139 });

      // Back to a dark logo of the new shape.
      const dark = await call('POST', '/api/admin/management/platform-branding/assets/logo-dark', {
        contentType: 'image/png', data: b64(OTHER_SHAPE_PNG), png: b64(OTHER_SHAPE_PNG),
      });
      expect(dark.status).toBe(200);
    });
  });

  describe('back to the brand\'s default', () => {
    it('the light logo takes its pair with it; the kit shows again', async () => {
      const before = await row();
      const res = await call('DELETE', '/api/admin/management/platform-branding/assets/logo-light');
      expect(res.status).toBe(200);
      const after = await row();
      for (const c of [
        'logo_light_storage_key', 'logo_dark_storage_key', 'logo_email_light_storage_key', 'logo_email_dark_storage_key',
        'logo_email_width', 'logo_email_height', 'logo_email_dark_width', 'logo_email_dark_height',
      ]) {
        expect(after[c], c).toBeNull();
      }
      for (const c of ['logo_light_storage_key', 'logo_dark_storage_key']) expect(onDisk(before[c]), c).toBe(false);
      // The emails already sent keep their logo.
      for (const c of ['logo_email_light_storage_key', 'logo_email_dark_storage_key']) expect(onDisk(before[c]), c).toBe(true);
      // The symbol stays.
      expect(after.symbol_storage_key).toBe(before.symbol_storage_key);
      const resolved = await assets.resolveBrandAssets(config);
      expect(resolved?.source).toBe('kit');
      expect(resolved?.logo.light).toBe('https://app.example.test/brand/intl/respok-thread-horizontal-color.svg');
      expect(resolved?.logoPng).toMatchObject({ light: 'https://app.example.test/brand/intl/email/respok-logo.png', width: 400, height: 92 });

      const symbolKey = before.symbol_png_192_storage_key;
      expect((await call('DELETE', '/api/admin/management/platform-branding/assets/symbol')).status).toBe(200);
      expect(onDisk(symbolKey)).toBe(false);
      expect((await call('GET', '/api/platform/public/config')).json.brand_assets).toBeNull();
      expect((await call('GET', '/api/admin/management/platform-branding')).json.assets).toBeNull();
    });
  });
});
