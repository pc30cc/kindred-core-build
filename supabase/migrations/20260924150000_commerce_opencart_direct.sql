-- Hosted mirror of database/migrations/214_commerce_opencart_direct.sql.
-- OpenCart connector — direct (index-less) commerce reads.
--
-- ADDITIVE ONLY. No column is dropped, renamed or retyped; no row is deleted.
-- Every statement is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- What Web Yar keeps for an OpenCart store is METADATA only. Products,
-- prices, stock, customers, orders, addresses and reviews stay in OpenCart
-- and are read live, per question, through the signed extension endpoint;
-- nothing here holds any of them. See docs/commerce/OPENCART.md §Data.
--
-- commerce_connections
--   external_store_id     OpenCart store_id inside one installation (a
--                          multi-store shop connects each store separately;
--                          every signed call carries it and the extension
--                          refuses a mismatch)
--   (platform_version, added by 212 for WHMCS, holds the OpenCart version and
--    picks the 3.0 vs 4.1 route shape)
--   last_health_check_at   rate limit of the manual "check connection" button
--                          (health is otherwise observed from real requests,
--                          never polled)
--
-- commerce_pairing_requests
--   external_store_id / platform_version carried from register to exchange
--   (the store's base URL uses 212's requested_base_url), so the connection
--   is created for exactly the store that asked.
--   permissions: what the owner ticked on the consent screen. It was
--   accepted by /approve but never stored, so every new connection started
--   with the column default instead of the owner's choice.
--
-- commerce_customer_links (existing identity link, now updated in place)
--   session_ref        opaque, store-encrypted reference to the OpenCart
--                      session the customer was signed in with. Web Yar can
--                      neither read it nor use it as a cookie; the extension
--                      re-validates it on every private read (logout, expiry,
--                      another customer, disabled account → refused).
--   customer_group_id  the group the store reported, used ONLY as a cache-key
--                      component so group prices never mix
--   private_cutoff_at  when the linked identity last changed (switch or
--                      sign-out): conversation history older than this is not
--                      fed back to the model, so one customer's private
--                      answers never reach the next customer's prompt
--   (updated_at is added by 212.)
ALTER TABLE public.commerce_connections ADD COLUMN IF NOT EXISTS external_store_id text;
ALTER TABLE public.commerce_connections ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz;

ALTER TABLE public.commerce_pairing_requests ADD COLUMN IF NOT EXISTS external_store_id text;
ALTER TABLE public.commerce_pairing_requests ADD COLUMN IF NOT EXISTS platform_version text;
ALTER TABLE public.commerce_pairing_requests ADD COLUMN IF NOT EXISTS permissions jsonb;

ALTER TABLE public.commerce_customer_links ADD COLUMN IF NOT EXISTS session_ref text;
ALTER TABLE public.commerce_customer_links ADD COLUMN IF NOT EXISTS customer_group_id text;
ALTER TABLE public.commerce_customer_links ADD COLUMN IF NOT EXISTS private_cutoff_at timestamptz;

-- The identity bridge now looks up "this visitor's current link on this
-- connection" and updates it in place instead of inserting a row per page
-- view; this is the index that lookup uses.
CREATE INDEX IF NOT EXISTS commerce_customer_links_visitor_conn_idx
  ON public.commerce_customer_links (connection_id, visitor_id, verified_at DESC)
  WHERE visitor_id IS NOT NULL;

-- Rollout stays a platform-admin decision, exactly as for WooCommerce: the
-- catalog entry exists but is not installable until enabled in Super Admin.
INSERT INTO public.plugin_platform_state
  (plugin_id, enabled, marketplace_visible, installable, featured, sort_order, rollout_status)
VALUES
  ('opencart', true, true, false, false, 105, 'coming_soon')
ON CONFLICT (plugin_id) DO NOTHING;
