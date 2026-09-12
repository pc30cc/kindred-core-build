-- 159: Workspace branding no longer carries a platform name.
-- The platform name is owned exclusively by platform_branding_localized.
-- Clears legacy values ("My Platform", "widget Destekly", ...) and removes the default.

ALTER TABLE public.workspace_branding ALTER COLUMN platform_name SET DEFAULT '';

UPDATE public.workspace_branding
SET platform_name = ''
WHERE platform_name IS NOT NULL AND platform_name <> '';
