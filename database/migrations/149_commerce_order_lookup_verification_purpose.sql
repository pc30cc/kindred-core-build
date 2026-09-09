-- 149_commerce_order_lookup_verification_purpose.sql
--
-- Enables the Generic Verification Core's ONE real, active consumer:
-- 'commerce_order_lookup' (guest order verification for the Commerce
-- Integration Platform — docs/commerce/SECURITY.md §Guest order
-- verification). Per 098_generic_verification_core.sql's own §7 comment,
-- enabling a purpose is a deliberate two-key change: this migration (the
-- database-facing dormancy gate) PLUS
-- server/services/verification/types.ts (the TypeScript purpose registry,
-- already shipping `commerce_order_lookup: { enabled: true, ... }`).
-- Every other purpose remains disabled — this array adds exactly one value.

CREATE OR REPLACE FUNCTION public.gv_is_purpose_enabled(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY['commerce_order_lookup']::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_is_purpose_enabled(text) FROM PUBLIC;
