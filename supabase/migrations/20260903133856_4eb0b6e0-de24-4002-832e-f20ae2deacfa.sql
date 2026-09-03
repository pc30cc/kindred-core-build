REVOKE ALL ON FUNCTION public.gv_is_purpose_enabled(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gv_is_purpose_enabled(text) TO service_role;