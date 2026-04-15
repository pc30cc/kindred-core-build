ALTER TABLE public.widget_settings
ADD COLUMN IF NOT EXISTS allow_subdomains boolean NOT NULL DEFAULT false;