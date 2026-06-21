-- Close browser-side bypass for contact creation. The canonical create
-- path is now POST /api/contacts and POST /api/contacts/bulk on the
-- self-hosted Express server, which performs:
--   1. Bearer token auth + is_workspace_member check
--   2. requireLimit('max_contacts', live count(*) resolver)
--   3. service-role INSERT into public.contacts
-- Direct PostgREST INSERT and direct RPC EXECUTE from authenticated
-- JWTs are revoked so the Express chokepoint is the single canonical
-- path. UPDATE / DELETE / SELECT grants on public.contacts are
-- intentionally NOT touched.

REVOKE INSERT ON public.contacts FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.create_contact(uuid, text, text, text, text, text[], text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.bulk_create_contacts(uuid, jsonb) FROM authenticated;

-- service_role retains EXECUTE / ALL (granted in the previous migration).