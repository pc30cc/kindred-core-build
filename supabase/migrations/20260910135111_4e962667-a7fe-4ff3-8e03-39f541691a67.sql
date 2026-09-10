-- 153_signup_email_verification_purpose.sql
--
-- Second key for the self-hosted signup email OTP. The TypeScript registry
-- (server/services/verification/types.ts) already ships
-- `signup_email: { enabled: true }`; this migration flips the database-side
-- dormancy gate plus the two admin gates so a Super Admin toggle on
-- "Signup — Email" can become effective. Every other purpose stays exactly
-- as it was: commerce_order_lookup keeps its runtime gate (149) and the
-- admin gates list exactly one new value.

CREATE OR REPLACE FUNCTION public.gv_is_purpose_enabled(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY['commerce_order_lookup','signup_email']::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_is_purpose_enabled(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.gv_admin_consumer_implemented(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY['signup_email']::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_consumer_implemented(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.gv_admin_deployment_allowlisted(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY['signup_email']::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_deployment_allowlisted(text) FROM PUBLIC;

-- Verify: exactly the intended purposes moved, nothing else.
DO $$
DECLARE p text;
BEGIN
  IF NOT public.gv_is_purpose_enabled('signup_email') THEN
    RAISE EXCEPTION '153: signup_email must be runtime-enabled';
  END IF;
  IF NOT public.gv_is_purpose_enabled('commerce_order_lookup') THEN
    RAISE EXCEPTION '153: commerce_order_lookup must stay runtime-enabled';
  END IF;
  FOREACH p IN ARRAY ARRAY['signup_phone','password_reset','login_step_up','change_email','change_phone','sensitive_action','workspace_invitation'] LOOP
    IF public.gv_is_purpose_enabled(p) THEN
      RAISE EXCEPTION '153: % must remain dormant', p;
    END IF;
    IF public.gv_admin_consumer_implemented(p) OR public.gv_admin_deployment_allowlisted(p) THEN
      RAISE EXCEPTION '153: % must not be admin-gated open', p;
    END IF;
  END LOOP;
END $$;