-- Merchant label observed from the authenticated connector health response.
-- Not an authorization field; existing service-role-only table ACLs apply.
ALTER TABLE public.commerce_connections
  ADD COLUMN IF NOT EXISTS store_name text;
COMMENT ON COLUMN public.commerce_connections.store_name IS
  'Configured merchant name, refreshed at pairing or connection checks; display only.';
NOTIFY pgrst, 'reload schema';
