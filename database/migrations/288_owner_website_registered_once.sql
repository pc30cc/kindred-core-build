-- 288 — The owner's website is registered once (owner, 2026-10-28: «توی
-- ثبت نام آدرس سایت ضروری باشه و یکبار ثبت بشه و همیشه ثابت باشه»: the
-- website is required at signup, registered once, and fixed for good).
--
-- 239's trigger trg_workspaces_auto_register_owner_domain runs on every
-- workspace INSERT and verifies the account owner's profiles.website_domain
-- for the new workspace (register_workspace_domain: a verified primary
-- workspace_domains row, the widget's allowed_domains, allow_subdomains).
-- A verified domain belongs to one workspace on the platform
-- (workspace_domains_verified_domain_uniq), and the account's first
-- workspace already holds it, so every later workspace of the same account
-- failed with 23505 (POST /api/workspaces answered the raw "duplicate key
-- value violates unique constraint"). With the website required at signup
-- that is every account whose plan allows a second workspace.
--
-- The function is 239's, word for word, but for one step before the
-- register: when another workspace of the same account already holds the
-- website as a verified domain, this workspace does not claim it again (it
-- gets no domain row and no allow-list entry, like a workspace whose owner
-- has no website). The website is compared as the row would store it
-- (normalize_domain, then the row's own normalize trigger) and as the
-- generated normalized_domain reads it, so the probe is the unique index's
-- own key. A website verified by ANOTHER account is still registered, and
-- still refused by the index: provision-account answers DOMAIN_TAKEN for it
-- (signup refuses such a website before any row exists; this is the race).
--
-- Applied by hand on WebYar BEFORE the merge of the code that requires the
-- website (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The
-- running backend needs nothing from it and it needs no new backend. It
-- writes no data: no row is changed, nothing is dropped or deleted; a
-- workspace created before it keeps what it has. CREATE OR REPLACE keeps the
-- function's owner, grants and its trigger; the grants are set again below
-- anyway (service_role only), as 239 sets them. Safe to run twice; it needs
-- 239. Like 284 to 287, it sets lock_timeout 5s itself (a function replace
-- waits on no table, but a hand-run without PGOPTIONS must not queue behind
-- one).

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.register_workspace_domain(uuid, text, boolean)') IS NULL
     OR to_regprocedure('public.normalize_domain(text)') IS NULL
     OR to_regprocedure('public.workspaces_auto_register_owner_domain()') IS NULL THEN
    RAISE EXCEPTION '288 needs 239 (register_workspace_domain, normalize_domain or workspaces_auto_register_owner_domain is missing)';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.workspaces_auto_register_owner_domain() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_owner_domain text;
  v_owner_id uuid;
  v_key text;
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

  -- Registered once (288): another workspace of this account already holds
  -- the website, verified. The key is the stored row's normalized_domain.
  v_key := regexp_replace(regexp_replace(regexp_replace(
    lower(btrim(public.normalize_domain(public.normalize_domain(v_owner_domain)))),
    '^https?://'::text, ''::text), '[:/?#].*$'::text, ''::text), '^www\.'::text, ''::text);
  IF v_key IS NOT NULL AND v_key <> '' AND EXISTS (
    SELECT 1
    FROM public.workspace_domains d
    JOIN public.workspaces w ON w.id = d.workspace_id
    WHERE d.verified
      AND d.normalized_domain = v_key
      AND w.account_id = NEW.account_id
      AND w.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.register_workspace_domain(NEW.id, v_owner_domain, true);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.workspaces_auto_register_owner_domain() FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.workspaces_auto_register_owner_domain() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.workspaces_auto_register_owner_domain() FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON FUNCTION public.workspaces_auto_register_owner_domain() TO service_role;
  END IF;
END $acl$;

RESET lock_timeout;
