/**
 * The platform's own logo and symbol (Super Admin → Branding → Visual
 * identity; migration 290). Mounted at
 * /api/admin/management/platform-branding/assets, platform admin only:
 *
 *   POST   /:variant   logo-light | logo-dark | symbol: the original (SVG, PNG
 *                      or WebP) and its PNG copies, drawn by the Super
 *                      Admin's browser (the server never rasterises): the
 *                      email copy of a logo, or the symbol's 180 (opaque),
 *                      192 and 512 px icons.
 *   DELETE /:variant   back to the brand's kit. The light logo takes the
 *                      dark one with it: the two are one pair.
 *
 * An email draws the dark PNG at the light one's size (BrandAssets.logoPng),
 * so the two keep one shape: a dark logo of another shape is refused, and a
 * new light logo of another shape resets the dark pair.
 *
 * Modelled on the ringback and workspace-icon uploads: base64 JSON in, the
 * platform-wide storage provider, a new key per file
 * (platform/brand/<uuid>-<variant>.<ext>), only the keys stored, the old
 * files deleted best-effort, except the email PNGs: every email already sent
 * names them, so they are kept (small, one key per upload). Then every cache
 * that shows the logo is dropped, here and on every other replica (the public
 * config, the widgets' platform snapshot, the call widget bootstrap).
 *
 * What a file must be: server/services/platformBrandUpload.ts.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { publishCacheInvalidation } from '../lib/cacheBus.js';
import { invalidatePlatformPublicConfig } from '../services/platformPublicConfig.js';
import { readCustomBrandAssets, type BrandAssetKeyColumn } from '../services/platformBrandAssets.js';
import { deleteWithConfig, resolveGlobalStorageConfig, uploadWithConfig } from '../services/storage/index.js';
import { platformBrandAssetKey } from '../services/storage/keys.js';
import {
  BrandUploadError,
  SYMBOL_ICON_SIZES,
  checkBrandOriginal,
  checkBrandPng,
  checkEmailLogoPng,
  isBrandAssetVariant,
  type BrandAssetVariant,
  type SymbolIconName,
} from '../services/platformBrandUpload.js';

export const platformBrandAssetsRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as { serverConfig: ServerConfig }).serverConfig;
}

const uploadSchema = z.object({
  contentType: z.string().min(1).max(80),
  data: z.string().min(1),
  /** A logo's email copy (PNG). */
  png: z.string().min(1).optional(),
  /** The symbol's PNG icons. */
  icons: z.object({
    apple_touch_180: z.string().min(1),
    png_192: z.string().min(1),
    png_512: z.string().min(1),
  }).strict().optional(),
}).strict();

const ICON_COLUMNS: Record<SymbolIconName, BrandAssetKeyColumn> = {
  apple_touch_180: 'symbol_apple_touch_storage_key',
  png_192: 'symbol_png_192_storage_key',
  png_512: 'symbol_png_512_storage_key',
};

const DARK_PAIR: BrandAssetKeyColumn[] = ['logo_dark_storage_key', 'logo_email_dark_storage_key'];
const DARK_SIZE = { logo_email_dark_width: null, logo_email_dark_height: null };

/** The key columns a reset clears, per variant (the light logo takes its pair along). */
const CLEARED_BY: Record<BrandAssetVariant, BrandAssetKeyColumn[]> = {
  'logo-light': ['logo_light_storage_key', 'logo_email_light_storage_key', ...DARK_PAIR],
  'logo-dark': DARK_PAIR,
  symbol: ['symbol_storage_key', ...Object.values(ICON_COLUMNS)],
};

/** The size columns a reset clears with them. */
const SIZES_CLEARED_BY: Record<BrandAssetVariant, Record<string, null>> = {
  'logo-light': { logo_email_width: null, logo_email_height: null, ...DARK_SIZE },
  'logo-dark': DARK_SIZE,
  symbol: {},
};

/**
 * Files no longer named by the row that stay in storage: every email already
 * sent shows its logo from that URL, and deleting it would break the image in
 * every inbox. Their keys are unique per upload, so nothing is overwritten.
 */
const KEPT_FOR_SENT_EMAILS = new Set<BrandAssetKeyColumn>(['logo_email_light_storage_key', 'logo_email_dark_storage_key']);

/** How far a dark logo's shape (width to height) may stray from the light one's. */
const SHAPE_TOLERANCE = 0.02;

interface PngSize { width: number; height: number }

function storedSize(row: Record<string, unknown>, width: string, height: string): PngSize | null {
  const w = row[width];
  const h = row[height];
  return typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0 ? { width: w, height: h } : null;
}

function sameShape(a: PngSize, b: PngSize): boolean {
  return Math.abs((a.width / a.height) / (b.width / b.height) - 1) <= SHAPE_TOLERANCE;
}

interface PreparedFile {
  column: BrandAssetKeyColumn;
  name: string;
  ext: string;
  contentType: string;
  bytes: Buffer;
}

/** The files of one upload, checked; a BrandUploadError says what is wrong. `png`: the logo's email copy's size. */
function prepare(
  variant: BrandAssetVariant,
  body: z.infer<typeof uploadSchema>,
): { files: PreparedFile[]; extra: Record<string, unknown>; png: PngSize | null } {
  const original = checkBrandOriginal(body.contentType, body.data);
  const files: PreparedFile[] = [{
    column: variant === 'symbol' ? 'symbol_storage_key' : variant === 'logo-dark' ? 'logo_dark_storage_key' : 'logo_light_storage_key',
    name: variant,
    ext: original.type,
    contentType: original.contentType,
    bytes: original.bytes,
  }];
  const extra: Record<string, unknown> = {};
  let emailSize: PngSize | null = null;
  if (variant === 'symbol') {
    if (!body.icons) throw new BrandUploadError('icons_required');
    for (const [name, size] of Object.entries(SYMBOL_ICON_SIZES) as Array<[SymbolIconName, number]>) {
      const png = checkBrandPng(body.icons[name], name, size);
      files.push({ column: ICON_COLUMNS[name], name: `symbol-${size}`, ext: 'png', contentType: 'image/png', bytes: png.bytes });
    }
  } else {
    if (!body.png) throw new BrandUploadError('png_required');
    const png = checkEmailLogoPng(body.png, 'png');
    files.push({
      column: variant === 'logo-dark' ? 'logo_email_dark_storage_key' : 'logo_email_light_storage_key',
      name: `${variant}-email`,
      ext: 'png',
      contentType: 'image/png',
      bytes: png.bytes,
    });
    emailSize = { width: png.width, height: png.height };
    if (variant === 'logo-light') {
      extra.logo_email_width = png.width;
      extra.logo_email_height = png.height;
    } else {
      extra.logo_email_dark_width = png.width;
      extra.logo_email_dark_height = png.height;
    }
  }
  return { files, extra, png: emailSize };
}

/** Write the patch to the one platform_branding row (or create it). */
async function savePatch(config: ServerConfig, rowId: string | null, patch: Record<string, unknown>) {
  const sb = getServiceClient(config);
  const payload = { ...patch, updated_at: new Date().toISOString() };
  return rowId
    ? sb.from('platform_branding').update(payload).eq('id', rowId).select().maybeSingle()
    : sb.from('platform_branding').insert(payload).select().maybeSingle();
}

/** Every process forgets the logo it showed: the public config, the widget snapshot, the call widget bootstrap. */
function announce() {
  invalidatePlatformPublicConfig();
  publishCacheInvalidation(['platform']);
}

platformBrandAssetsRouter.post('/:variant', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const variant = req.params.variant;
  if (!isBrandAssetVariant(variant)) return res.status(404).json({ error: 'unknown_variant' });
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(variant, parsed.data);
  } catch (err) {
    if (err instanceof BrandUploadError) return res.status(err.status).json({ error: err.code, detail: err.detail ?? null });
    throw err;
  }

  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data: row, error: readError } = await sb.from('platform_branding').select('*').limit(1).maybeSingle();
  if (readError) return res.status(500).json({ error: readError.message });
  const current = (row ?? {}) as Record<string, unknown>;
  // The dark logo is the light one's partner; alone it would pair the kit's
  // light logo with the Super Admin's dark one.
  if (variant === 'logo-dark' && !current.logo_light_storage_key) return res.status(409).json({ error: 'logo_light_required' });
  // An email draws the dark PNG at the light one's size: another shape would
  // be stretched in every email.
  const lightSize = storedSize(current, 'logo_email_width', 'logo_email_height');
  if (variant === 'logo-dark' && prepared.png && lightSize && !sameShape(prepared.png, lightSize)) {
    return res.status(409).json({ error: 'logo_dark_ratio' });
  }
  // A new light logo of another shape leaves the dark pair behind (as does
  // one whose dark size is unknown): dark surfaces wear the light one.
  const darkSize = storedSize(current, 'logo_email_dark_width', 'logo_email_dark_height');
  const dropsDark = variant === 'logo-light' && !!prepared.png
    && DARK_PAIR.some((column) => current[column])
    && !(darkSize && sameShape(prepared.png, darkSize));

  const storage = await resolveGlobalStorageConfig(config);
  if (!storage) return res.status(500).json({ error: 'global_storage_not_configured' });
  const written: string[] = [];
  const dropWritten = () => Promise.all(written.map((key) => deleteWithConfig(storage, key).catch(() => undefined)));
  const patch: Record<string, unknown> = { ...prepared.extra };
  if (dropsDark) Object.assign(patch, Object.fromEntries(DARK_PAIR.map((column) => [column, null])), DARK_SIZE);
  for (const file of prepared.files) {
    const fileKey = platformBrandAssetKey({ variant: file.name, ext: file.ext });
    const uploaded = await uploadWithConfig(storage, { fileKey, data: file.bytes, contentType: file.contentType });
    if (!uploaded.success) {
      await dropWritten();
      return res.status(500).json({ error: 'upload_failed', detail: uploaded.error ?? null });
    }
    written.push(fileKey);
    // KEY ONLY: the URL is derived on read (server/services/platformBrandAssets.ts).
    patch[file.column] = fileKey;
  }

  const { error: saveError } = await savePatch(config, (current.id as string | undefined) ?? null, patch);
  if (saveError) {
    await dropWritten();
    return res.status(500).json({ error: saveError.message });
  }
  // Best-effort: the old files are no longer named anywhere (the email PNGs
  // still are, by the emails already sent).
  const replaced = [...prepared.files.map((file) => file.column), ...(dropsDark ? DARK_PAIR : [])];
  for (const column of replaced) {
    const previous = current[column];
    if (!KEPT_FOR_SENT_EMAILS.has(column) && typeof previous === 'string' && previous && previous !== patch[column]) {
      await deleteWithConfig(storage, previous).catch(() => undefined);
    }
  }
  announce();
  return res.json({ assets: await readCustomBrandAssets(config), ...(dropsDark ? { dark_reset: true } : {}) });
});

platformBrandAssetsRouter.delete('/:variant', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const variant = req.params.variant;
  if (!isBrandAssetVariant(variant)) return res.status(404).json({ error: 'unknown_variant' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data: row, error: readError } = await sb.from('platform_branding').select('*').limit(1).maybeSingle();
  if (readError) return res.status(500).json({ error: readError.message });
  const current = (row ?? null) as Record<string, unknown> | null;
  const columns = CLEARED_BY[variant];
  const named = columns.filter((column) => typeof current?.[column] === 'string' && current[column]);
  if (current?.id && named.length) {
    const patch: Record<string, unknown> = { ...Object.fromEntries(columns.map((column) => [column, null])), ...SIZES_CLEARED_BY[variant] };
    const { error } = await savePatch(config, current.id as string, patch);
    if (error) return res.status(500).json({ error: error.message });
    // The email PNGs stay: the emails already sent show them.
    const storage = await resolveGlobalStorageConfig(config).catch(() => null);
    if (storage) {
      for (const column of named) {
        if (!KEPT_FOR_SENT_EMAILS.has(column)) await deleteWithConfig(storage, current[column] as string).catch(() => undefined);
      }
    }
    announce();
  }
  return res.json({ assets: await readCustomBrandAssets(config) });
});
