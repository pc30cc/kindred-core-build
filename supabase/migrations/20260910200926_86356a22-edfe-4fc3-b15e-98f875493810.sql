ALTER TABLE public.workspace_branding ALTER COLUMN platform_name SET DEFAULT '';
UPDATE public.workspace_branding SET platform_name = '' WHERE platform_name IS NOT NULL AND platform_name <> '';