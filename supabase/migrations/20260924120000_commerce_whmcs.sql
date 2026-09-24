-- 211_commerce_whmcs.sql
--
-- WHMCS connector (docs/commerce/WHMCS.md). ADDITIVE ONLY: new nullable
-- columns and partial indexes on the existing commerce tables. Nothing is
-- renamed, dropped, rewritten or backfilled, and every existing WooCommerce
-- row keeps exactly the meaning it had.
--
-- What this deliberately does NOT add: any table holding WHMCS services,
-- domains, invoices, orders, tickets or catalogue rows. WHMCS stays the
-- source of truth and is queried live; Web Yar keeps only connection
-- metadata and one identity binding per (connection, widget visitor).
--
-- Idempotent: safe to re-run. Same service-role-only ACL as 148 (the
-- columns inherit the tables' existing grants and RLS policies).

-- A WHMCS install usually lives under a path (https://example.com/billing).
-- The origin alone cannot address its API, so pairing records the base URL
-- too; it is validated to sit on the approved origin (server/services/
-- commerce/pairing.ts normalizeStoreBaseUrl).
ALTER TABLE public.commerce_pairing_requests
  ADD COLUMN IF NOT EXISTS requested_base_url text;

-- The platform's own version (WHMCS 8.x), reported by the capability
-- handshake. WooCommerce keeps using woocommerce_version/wordpress_version.
ALTER TABLE public.commerce_connections
  ADD COLUMN IF NOT EXISTS platform_version text;

-- WHMCS identity binding. One row per (connection, visitor), updated only
-- when the bound grant/subject actually changes:
--   external_customer_id  (existing) the WHMCS Client Account id
--   external_user_id      the WHMCS User id acting for that account
--   grant_ref             the addon's grant id; WHMCS re-checks it on every read
--   subject_since         when this (user, account) pair took over the visitor;
--                         older conversation turns are kept out of the prompt
--   revoked_at            set once when WHMCS reports the grant is gone
ALTER TABLE public.commerce_customer_links
  ADD COLUMN IF NOT EXISTS external_user_id text,
  ADD COLUMN IF NOT EXISTS grant_ref        text,
  ADD COLUMN IF NOT EXISTS subject_since    timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at       timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz;

-- Partial on grant_ref: WooCommerce link rows (grant_ref IS NULL) are not
-- touched, so any duplicates they already contain cannot make this fail.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_customer_links_grant_visitor_unique
  ON public.commerce_customer_links (connection_id, visitor_id)
  WHERE grant_ref IS NOT NULL;

-- "One grant, one visitor" revocation on re-bind (identity.ts slow path).
CREATE INDEX IF NOT EXISTS commerce_customer_links_grant_idx
  ON public.commerce_customer_links (connection_id, grant_ref)
  WHERE grant_ref IS NOT NULL AND revoked_at IS NULL;
