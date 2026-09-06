REVOKE ALL ON FUNCTION public.billing_begin_collection(uuid, text, bigint, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_begin_collection(uuid, text, bigint, text, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.billing_begin_collection(uuid, text, bigint, text, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_begin_collection(uuid, text, bigint, text, uuid, integer) TO service_role;