-- 1. Default allow_subdomains to TRUE for new widget settings
ALTER TABLE public.widget_settings ALTER COLUMN allow_subdomains SET DEFAULT true;

-- 2. Backfill existing widget_settings rows that were left at false
-- (only flip rows that haven't been explicitly customised — i.e. still at the old default)
UPDATE public.widget_settings SET allow_subdomains = true WHERE allow_subdomains = false;

-- 3. Domain normalization helper (mirrors server/utils/domain.ts)
CREATE OR REPLACE FUNCTION public.normalize_domain(_input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF _input IS NULL THEN RETURN NULL; END IF;
  v := lower(trim(_input));
  IF v = '' THEN RETURN NULL; END IF;
  -- strip protocol
  v := regexp_replace(v, '^https?://', '');
  -- strip path
  v := split_part(v, '/', 1);
  -- strip port
  v := split_part(v, ':', 1);
  -- strip leading www.
  IF v LIKE 'www.%' THEN
    v := substring(v from 5);
  END IF;
  IF v = '' THEN RETURN NULL; END IF;
  RETURN v;
END;
$$;

-- 4. Normalize the domain on insert/update of workspace_domains
CREATE OR REPLACE FUNCTION public.workspace_domains_normalize()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.domain := public.normalize_domain(NEW.domain);
  IF NEW.domain IS NULL OR NEW.domain = '' THEN
    RAISE EXCEPTION 'Invalid domain';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_domains_normalize ON public.workspace_domains;
CREATE TRIGGER trg_workspace_domains_normalize
  BEFORE INSERT OR UPDATE OF domain ON public.workspace_domains
  FOR EACH ROW EXECUTE FUNCTION public.workspace_domains_normalize();

-- 5. Helper that registers a domain for a workspace, idempotently
CREATE OR REPLACE FUNCTION public.register_workspace_domain(
  _workspace_id uuid,
  _raw_domain text,
  _make_primary boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
  v_existing_id uuid;
  v_allowed text[];
BEGIN
  v_domain := public.normalize_domain(_raw_domain);
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN;
  END IF;

  -- Insert into workspace_domains (verified, optionally primary)
  SELECT id INTO v_existing_id
  FROM public.workspace_domains
  WHERE workspace_id = _workspace_id AND domain = v_domain
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    -- If we're making this primary, unset any existing primary first
    IF _make_primary THEN
      UPDATE public.workspace_domains
      SET is_primary = false
      WHERE workspace_id = _workspace_id AND is_primary = true;
    END IF;

    INSERT INTO public.workspace_domains (workspace_id, domain, verified, is_primary)
    VALUES (_workspace_id, v_domain, true, _make_primary);
  END IF;

  -- Ensure widget_settings exists, append domain to allowed_domains, enable subdomains
  INSERT INTO public.widget_settings (workspace_id, allowed_domains, allow_subdomains)
  VALUES (_workspace_id, ARRAY[v_domain], true)
  ON CONFLICT (workspace_id) DO UPDATE
    SET allowed_domains = (
      SELECT ARRAY(
        SELECT DISTINCT unnest(
          COALESCE(public.widget_settings.allowed_domains, ARRAY[]::text[]) || ARRAY[v_domain]
        )
      )
    ),
    allow_subdomains = true,
    updated_at = now();
END;
$$;

-- 6. Trigger: when a workspace is created, auto-register the owner's website_domain
CREATE OR REPLACE FUNCTION public.workspaces_auto_register_owner_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_domain text;
  v_owner_id uuid;
BEGIN
  -- Find the account owner
  SELECT a.owner_id INTO v_owner_id
  FROM public.accounts a
  WHERE a.id = NEW.account_id;

  IF v_owner_id IS NULL THEN RETURN NEW; END IF;

  -- Pull the website domain from the owner's profile
  SELECT website_domain INTO v_owner_domain
  FROM public.profiles
  WHERE id = v_owner_id;

  IF v_owner_domain IS NULL OR trim(v_owner_domain) = '' THEN
    RETURN NEW;
  END IF;

  PERFORM public.register_workspace_domain(NEW.id, v_owner_domain, true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspaces_auto_register_owner_domain ON public.workspaces;
CREATE TRIGGER trg_workspaces_auto_register_owner_domain
  AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.workspaces_auto_register_owner_domain();

-- 7. Backfill: register profile.website_domain for every existing workspace
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT w.id AS workspace_id, p.website_domain
    FROM public.workspaces w
    JOIN public.accounts a ON a.id = w.account_id
    JOIN public.profiles p ON p.id = a.owner_id
    WHERE p.website_domain IS NOT NULL AND trim(p.website_domain) <> ''
  LOOP
    PERFORM public.register_workspace_domain(r.workspace_id, r.website_domain, true);
  END LOOP;
END $$;

-- 8. Normalize any pre-existing rows in workspace_domains
UPDATE public.workspace_domains
SET domain = public.normalize_domain(domain)
WHERE domain IS NOT NULL AND domain <> public.normalize_domain(domain);
