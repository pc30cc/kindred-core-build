-- 290 — The platform's own logo, uploaded once (owner, 2026-10-30: «لوگو
-- توی کل پروژه چه وب یار چه ریسپوک از یکجا بخون که هر وقت عوض کردیم همش
-- عوض بشه همه جا»: read the logo from one place, for both brands, so a
-- change shows everywhere).
--
-- Super Admin → Branding → Visual identity uploads the brand's logo
-- (POST /api/admin/management/platform-branding/assets/:variant) and every
-- surface reads it through one resolver (server/services/platformBrandAssets.ts):
-- the panel, the chat and call widgets' "powered by", the help center and the
-- emails. Without an upload each brand keeps its kit's logo, as before.
--
-- Only storage keys are kept (`platform/brand/<uuid>-<variant>.<ext>`), never
-- a URL: the URL is derived on read for whichever storage provider is primary
-- (server/services/storage/urlResolver.ts). One nullable column per file, on
-- platform_branding (one row per brand's database):
--
--   logo_light_storage_key          the lockup (mark and name) for light
--                                   surfaces: SVG, PNG or WebP;
--   logo_dark_storage_key           the same for dark surfaces; optional,
--                                   the light one stands in;
--   logo_email_light_storage_key    PNG copies of the two, drawn by the
--   logo_email_dark_storage_key     Super Admin's browser (email clients show
--                                   no SVG), about 3x a 40 px display height;
--   logo_email_width/_height        the light PNG's natural size, in pixels,
--                                   read from its header at upload;
--   symbol_storage_key              the square mark, where the panel shows
--                                   the app's mark; optional, the kit's
--                                   symbol stands in;
--   symbol_apple_touch_storage_key  PNGs of it, drawn the same way: 180 px
--   symbol_png_192_storage_key      opaque (the home-screen icon), 192 and
--   symbol_png_512_storage_key      512 px (the web app's icons and the
--                                   browser notifications).
--
-- logo_url, favicon_url and pwa_icon_url stay, untouched: nothing is dropped
-- or rewritten, and an operator value in them keeps working as before
-- wherever no upload replaces it. The table's grants cover the new columns
-- (service_role only; nothing for anon or authenticated), so none are added.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that reads
-- it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The code
-- before it reads nothing of it (platform_branding is read with `select *`
-- and whitelisted), and the code after it treats a missing column as no
-- upload. It writes no data and drops nothing; every column is nullable with
-- no default, so adding them rewrites no row. Safe to run twice. Dry run:
-- wrap the file in BEGIN; … ROLLBACK; (it opens no transaction of its own).
-- Like 284 to 289, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

ALTER TABLE public.platform_branding
  ADD COLUMN IF NOT EXISTS logo_light_storage_key text,
  ADD COLUMN IF NOT EXISTS logo_dark_storage_key text,
  ADD COLUMN IF NOT EXISTS logo_email_light_storage_key text,
  ADD COLUMN IF NOT EXISTS logo_email_dark_storage_key text,
  ADD COLUMN IF NOT EXISTS logo_email_width integer,
  ADD COLUMN IF NOT EXISTS logo_email_height integer,
  ADD COLUMN IF NOT EXISTS symbol_storage_key text,
  ADD COLUMN IF NOT EXISTS symbol_apple_touch_storage_key text,
  ADD COLUMN IF NOT EXISTS symbol_png_192_storage_key text,
  ADD COLUMN IF NOT EXISTS symbol_png_512_storage_key text;

COMMENT ON COLUMN public.platform_branding.logo_light_storage_key IS
  'The platform logo (lockup) for light surfaces: a storage key (platform/brand/...), never a URL. NULL: the edition''s kit logo.';
COMMENT ON COLUMN public.platform_branding.logo_dark_storage_key IS
  'The platform logo for dark surfaces (storage key). NULL: the light one.';
COMMENT ON COLUMN public.platform_branding.logo_email_light_storage_key IS
  'PNG copy of the light logo for email (storage key), drawn by the uploading browser.';
COMMENT ON COLUMN public.platform_branding.logo_email_dark_storage_key IS
  'PNG copy of the dark logo for email (storage key).';
COMMENT ON COLUMN public.platform_branding.logo_email_width IS
  'Natural width in pixels of the light email PNG.';
COMMENT ON COLUMN public.platform_branding.logo_email_height IS
  'Natural height in pixels of the light email PNG.';
COMMENT ON COLUMN public.platform_branding.symbol_storage_key IS
  'The platform''s square mark (storage key). NULL: the edition''s kit symbol.';
COMMENT ON COLUMN public.platform_branding.symbol_apple_touch_storage_key IS
  'The square mark as an opaque 180 px PNG: the home-screen icon (storage key).';
COMMENT ON COLUMN public.platform_branding.symbol_png_192_storage_key IS
  'The square mark as a 192 px PNG: web app icon, favicon, notifications (storage key).';
COMMENT ON COLUMN public.platform_branding.symbol_png_512_storage_key IS
  'The square mark as a 512 px PNG: web app icon (storage key).';

RESET lock_timeout;
