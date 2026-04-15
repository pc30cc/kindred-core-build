
-- Update workspace branding for admin workspace with destekly.tr domain
UPDATE workspace_branding 
SET widget_base_url = 'https://destekly.tr',
    canonical_base_url = 'https://destekly.tr',
    panel_base_url = 'https://destekly.tr',
    asset_base_url = 'https://destekly.tr'
WHERE workspace_id = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';

-- Drop existing UPDATE policy on workspace_branding that allows workspace admins
DROP POLICY IF EXISTS "Workspace admins can update branding" ON workspace_branding;
DROP POLICY IF EXISTS "Members can update branding" ON workspace_branding;

-- Recreate: only platform admins OR workspace owner/admin can update branding,
-- but domain fields (widget_base_url, canonical_base_url, panel_base_url, asset_base_url)
-- can ONLY be changed by platform admins via a trigger.

-- Create a trigger function that prevents non-platform-admins from changing domain fields
CREATE OR REPLACE FUNCTION public.protect_workspace_domain_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If any domain field changed, only allow platform admins
  IF (
    COALESCE(OLD.widget_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_base_url, '') OR
    COALESCE(OLD.canonical_base_url, '') IS DISTINCT FROM COALESCE(NEW.canonical_base_url, '') OR
    COALESCE(OLD.panel_base_url, '') IS DISTINCT FROM COALESCE(NEW.panel_base_url, '') OR
    COALESCE(OLD.asset_base_url, '') IS DISTINCT FROM COALESCE(NEW.asset_base_url, '')
  ) THEN
    IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
      -- Revert domain fields to old values
      NEW.widget_base_url := OLD.widget_base_url;
      NEW.canonical_base_url := OLD.canonical_base_url;
      NEW.panel_base_url := OLD.panel_base_url;
      NEW.asset_base_url := OLD.asset_base_url;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS trg_protect_workspace_domains ON workspace_branding;
CREATE TRIGGER trg_protect_workspace_domains
  BEFORE UPDATE ON workspace_branding
  FOR EACH ROW
  EXECUTE FUNCTION protect_workspace_domain_fields();
