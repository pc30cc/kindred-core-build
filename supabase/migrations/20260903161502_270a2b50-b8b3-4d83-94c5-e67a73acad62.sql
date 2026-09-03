ALTER TABLE public.platform_branding
  ADD COLUMN IF NOT EXISTS default_ui_font_size text NOT NULL DEFAULT 'md',
  ADD COLUMN IF NOT EXISTS default_ui_accent    text NOT NULL DEFAULT 'blue',
  ADD COLUMN IF NOT EXISTS default_ui_chroma    text NOT NULL DEFAULT 'color',
  ADD COLUMN IF NOT EXISTS default_ui_skin      text NOT NULL DEFAULT 'cloud';

DO $$
BEGIN
  ALTER TABLE public.platform_branding ADD CONSTRAINT platform_branding_default_ui_font_size_chk CHECK (default_ui_font_size IN ('xs','sm','md','lg','xl'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TABLE public.platform_branding ADD CONSTRAINT platform_branding_default_ui_accent_chk CHECK (default_ui_accent IN ('blue','emerald','violet','amber','rose','slate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TABLE public.platform_branding ADD CONSTRAINT platform_branding_default_ui_chroma_chk CHECK (default_ui_chroma IN ('color','mono'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TABLE public.platform_branding ADD CONSTRAINT platform_branding_default_ui_skin_chk CHECK (default_ui_skin IN ('cloud','linen','graphite'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;