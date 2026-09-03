-- 102 — Generic Verification Core: restore the backend's EXECUTE grant on
-- public.gv_is_purpose_enabled(text).
--
-- The security-definer ACL lockdown left this function with no EXECUTE for
-- service_role, so the Express backend's readiness/gate probes
-- (server/services/verification/{readiness,adminSettings}.ts) failed with a
-- permission error and the Super Admin "Verification & OTP" page returned
-- VERIFICATION_ADMIN_UNAVAILABLE. Only the backend service role may call it;
-- anon/authenticated stay revoked.

REVOKE ALL ON FUNCTION public.gv_is_purpose_enabled(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gv_is_purpose_enabled(text) TO service_role;
