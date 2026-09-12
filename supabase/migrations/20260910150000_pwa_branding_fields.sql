-- Platform PWA (Progressive Web App) branding fields.
--
-- Reuses existing platform_branding columns where they already fit:
--   pwa_icon_url   -> manifest icon (already existed, previously unused downstream)
--   primary_color  -> manifest theme_color
-- Adds the fields that have no existing equivalent:
--   pwa_enabled           -> lets an operator turn the installable web-app /
--                            service worker off entirely for this deployment
--   pwa_short_name        -> the label shown under the home-screen icon
--                            (manifest short_name; distinct from the full
--                            platform_branding_localized.platform_name, which
--                            is usually too long for that space)
--   pwa_background_color  -> manifest background_color (splash screen), kept
--                            separate from secondary_color since that field
--                            serves a different, unrelated UI purpose
ALTER TABLE public.platform_branding
  ADD COLUMN IF NOT EXISTS pwa_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pwa_short_name text,
  ADD COLUMN IF NOT EXISTS pwa_background_color text DEFAULT '#ffffff';
