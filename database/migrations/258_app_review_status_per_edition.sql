-- ════════════════════════════════════════════════════════════════════════════
-- 258 — App Review: the running edition's seed time (follow-up to 257)
-- ════════════════════════════════════════════════════════════════════════════
--
-- 257 gave mobile_app_settings one row per edition and made app_review_seed
-- record itself on the running edition's row only. app_review_status still
-- reported max(app_review_seeded_at) over both rows, so right after a seed in
-- an edition that had never been seeded it could show the other edition's
-- older time. It now reports the running edition's own row, like every other
-- per-edition setting. (The seed route creates that row first when the
-- edition has none yet: server/routes/adminAppReview.ts.)
--
-- Same name, arguments, result and grants as 257's; safe to apply twice.

CREATE OR REPLACE FUNCTION public.app_review_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user   public.profiles%ROWTYPE;
  v_status text;
  v_ws     public.workspaces%ROWTYPE;
  v_at     timestamptz;
BEGIN
  SELECT * INTO v_user FROM public.profiles WHERE email = 'apple@webyar.ai';
  IF v_user.id IS NOT NULL THEN
    SELECT status INTO v_status FROM public.user_credentials WHERE user_id = v_user.id;
  END IF;
  SELECT * INTO v_ws FROM public.workspaces WHERE slug = 'ws_appreview';
  SELECT app_review_seeded_at INTO v_at
    FROM public.mobile_app_settings
   WHERE edition = public.platform_edition();

  RETURN jsonb_build_object(
    'email', 'apple@webyar.ai',
    'exists', v_user.id IS NOT NULL,
    'user_id', v_user.id,
    'full_name', v_user.full_name,
    'enabled', v_user.id IS NOT NULL AND coalesce(v_status, 'active') = 'active',
    'workspace_id', v_ws.id,
    'workspace_name', v_ws.name,
    'seeded_at', v_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_status() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.app_review_status() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.app_review_status() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.app_review_status() TO service_role';
  END IF;
END;
$$;
