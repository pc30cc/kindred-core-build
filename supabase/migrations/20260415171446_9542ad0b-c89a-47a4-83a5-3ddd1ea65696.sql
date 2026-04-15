ALTER TABLE public.workspace_branding
ADD COLUMN IF NOT EXISTS widget_public_base_url text,
ADD COLUMN IF NOT EXISTS widget_loader_base_url text,
ADD COLUMN IF NOT EXISTS widget_api_base_url text;

ALTER TABLE public.widget_settings
ADD COLUMN IF NOT EXISTS debug_mode boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.protect_workspace_domain_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF (
    COALESCE(OLD.widget_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_base_url, '') OR
    COALESCE(OLD.widget_public_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_public_base_url, '') OR
    COALESCE(OLD.widget_loader_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_loader_base_url, '') OR
    COALESCE(OLD.widget_api_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_api_base_url, '') OR
    COALESCE(OLD.canonical_base_url, '') IS DISTINCT FROM COALESCE(NEW.canonical_base_url, '') OR
    COALESCE(OLD.panel_base_url, '') IS DISTINCT FROM COALESCE(NEW.panel_base_url, '') OR
    COALESCE(OLD.asset_base_url, '') IS DISTINCT FROM COALESCE(NEW.asset_base_url, '')
  ) THEN
    IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
      NEW.widget_base_url := OLD.widget_base_url;
      NEW.widget_public_base_url := OLD.widget_public_base_url;
      NEW.widget_loader_base_url := OLD.widget_loader_base_url;
      NEW.widget_api_base_url := OLD.widget_api_base_url;
      NEW.canonical_base_url := OLD.canonical_base_url;
      NEW.panel_base_url := OLD.panel_base_url;
      NEW.asset_base_url := OLD.asset_base_url;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;