-- 148_commerce_platform.sql
--
-- Commerce Integration Platform — canonical schema. WooCommerce is the
-- first connector; every table here is provider-neutral (see
-- docs/commerce/ARCHITECTURE.md). Credentials are NOT stored here — a
-- commerce connection's installation_id is a
-- public.workspace_plugin_installations row (plugin_id = 'woocommerce'),
-- and its secret (installation_secret / store API credentials) is stored
-- through the EXISTING public.plugin_secrets envelope, reusing
-- server/lib/pluginCrypto.ts unmodified. This migration adds zero new
-- encryption/credential machinery.
--
-- Same backend-only ACL convention as 048/146: service-role only RLS, all
-- access through Express (server/routes/commerce/**). No anon/authenticated
-- grants anywhere in this file.
--
-- Idempotent: safe to re-run.

-- ── Connections (one per paired WooCommerce store) ─────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  installation_id     uuid NOT NULL UNIQUE REFERENCES public.workspace_plugin_installations(id) ON DELETE CASCADE,
  provider_type       text NOT NULL DEFAULT 'woocommerce',
  store_id            text NOT NULL,
  -- Exact scheme+host+port approved at pairing time. Every live call is
  -- re-validated against this — never a per-request caller-supplied URL.
  approved_origin     text NOT NULL,

  protocol_version    text NOT NULL DEFAULT 'webyar-commerce/1',
  connector_version   text,
  woocommerce_version text,
  wordpress_version   text,
  hpos_enabled        boolean,
  capabilities        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Owner-controlled tool permissions. Read directly alongside capabilities
  -- on every gated call so a permission change takes effect immediately —
  -- no separate cache to invalidate.
  permissions         jsonb NOT NULL DEFAULT jsonb_build_object(
                         'products', true, 'prices', true, 'stock', true,
                         'orders', false, 'order_status', false,
                         'tracking', false, 'customer_history', false,
                         'coupons', false
                       ),

  health              text NOT NULL DEFAULT 'reconnecting'
                         CHECK (health IN (
                           'connected','degraded','reconnecting',
                           'authentication_error','plugin_outdated',
                           'protocol_mismatch','stale_origin','offline',
                           'disconnected'
                         )),
  catalog_ready       boolean NOT NULL DEFAULT false,
  direct_live_read    boolean NOT NULL DEFAULT true,

  last_seen_at        timestamptz,
  last_success_at     timestamptz,
  last_event_at       timestamptz,
  last_live_read_at   timestamptz,
  last_sync_at        timestamptz,
  last_error_code     text,
  last_error_at       timestamptz,

  revoked_at          timestamptz,
  rotated_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_connections_workspace_idx
  ON public.commerce_connections (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_connections_store_unique
  ON public.commerce_connections (provider_type, store_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.commerce_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_connections FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_connections TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_connections;
CREATE POLICY "service role only" ON public.commerce_connections FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Pairing (authorization-code + PKCE state) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_pairing_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state              text NOT NULL UNIQUE,
  code_challenge     text NOT NULL,
  redirect_uri       text NOT NULL,
  provider_type      text NOT NULL DEFAULT 'woocommerce',
  requested_origin   text NOT NULL,
  workspace_id       uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  authorized_by      uuid,
  authorization_code_hash text,
  expires_at         timestamptz NOT NULL,
  authorized_at      timestamptz,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_pairing_requests_expiry_idx
  ON public.commerce_pairing_requests (expires_at) WHERE consumed_at IS NULL;
-- A single-use authorization code: at most one unconsumed row per hash.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_pairing_requests_code_unique
  ON public.commerce_pairing_requests (authorization_code_hash) WHERE consumed_at IS NULL;

ALTER TABLE public.commerce_pairing_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_pairing_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_pairing_requests TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_pairing_requests;
CREATE POLICY "service role only" ON public.commerce_pairing_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Signed-request replay guard ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_nonce_cache (
  installation_id uuid NOT NULL REFERENCES public.workspace_plugin_installations(id) ON DELETE CASCADE,
  nonce           text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound')),
  seen_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, direction, nonce)
);
CREATE INDEX IF NOT EXISTS commerce_nonce_cache_seen_idx ON public.commerce_nonce_cache (seen_at);

ALTER TABLE public.commerce_nonce_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_nonce_cache FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.commerce_nonce_cache TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_nonce_cache;
CREATE POLICY "service role only" ON public.commerce_nonce_cache FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Canonical product index ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  external_id         text NOT NULL,
  product_type        text NOT NULL DEFAULT 'simple',
  sku                 text,
  title               text NOT NULL,
  short_description   text,
  canonical_url       text,
  image_url           text,
  currency            text NOT NULL,
  regular_price_minor numeric,
  sale_price_minor    numeric,
  effective_price_minor numeric,
  stock_state         text NOT NULL DEFAULT 'unknown'
                         CHECK (stock_state IN ('in_stock','out_of_stock','backorder','unknown')),
  stock_quantity      integer,
  categories          jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags                jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes          jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_virtual          boolean NOT NULL DEFAULT false,
  is_downloadable     boolean NOT NULL DEFAULT false,
  -- WooCommerce's own updated_at (ISO 8601 UTC), used for out-of-order
  -- event/sync protection — an incoming write with an entity_version that
  -- is not strictly newer than the stored one is a no-op.
  entity_version      text NOT NULL,
  search_text         tsvector,
  deleted_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_products_unique
  ON public.commerce_products (connection_id, external_id);
CREATE INDEX IF NOT EXISTS commerce_products_workspace_idx ON public.commerce_products (workspace_id);
CREATE INDEX IF NOT EXISTS commerce_products_sku_idx ON public.commerce_products (connection_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_products_updated_idx ON public.commerce_products (connection_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS commerce_products_stock_idx ON public.commerce_products (connection_id, stock_state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commerce_products_price_idx ON public.commerce_products (connection_id, effective_price_minor) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commerce_products_active_idx ON public.commerce_products (connection_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commerce_products_search_idx ON public.commerce_products USING gin (search_text);

-- 'simple' config (no English stemming) so Persian/Turkish product titles
-- are indexed as literal lexemes rather than mangled by an English
-- stemmer. Structured filters (price/stock/category) are separate columns
-- and are NEVER inferred from this text index — see
-- docs/commerce/ARCHITECTURE.md §23 Product search.
CREATE OR REPLACE FUNCTION public.commerce_products_search_text_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_text := to_tsvector('simple',
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.short_description, '') || ' ' || coalesce(NEW.sku, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_products_search_text ON public.commerce_products;
CREATE TRIGGER commerce_products_search_text
  BEFORE INSERT OR UPDATE ON public.commerce_products
  FOR EACH ROW EXECUTE FUNCTION public.commerce_products_search_text_trigger();

ALTER TABLE public.commerce_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_products FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_products TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_products;
CREATE POLICY "service role only" ON public.commerce_products FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Version-aware, single-statement, race-free upsert. An incoming write
-- whose entity_version is NOT strictly newer than what's stored is a no-op
-- — this is what makes duplicate delivery harmless and out-of-order
-- delivery (an initial-sync page landing after a newer live event) safe,
-- without a separate SELECT-then-UPDATE race window. Returns true when the
-- row was actually written.
CREATE OR REPLACE FUNCTION public.commerce_upsert_product(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_external_id text,
  p_product_type text,
  p_sku text,
  p_title text,
  p_short_description text,
  p_canonical_url text,
  p_image_url text,
  p_currency text,
  p_regular_price_minor numeric,
  p_sale_price_minor numeric,
  p_effective_price_minor numeric,
  p_stock_state text,
  p_stock_quantity integer,
  p_categories jsonb,
  p_tags jsonb,
  p_attributes jsonb,
  p_is_virtual boolean,
  p_is_downloadable boolean,
  p_entity_version text
) RETURNS TABLE(product_id uuid, written boolean) AS $$
DECLARE
  v_id uuid;
  v_written boolean;
BEGIN
  INSERT INTO public.commerce_products (
    workspace_id, connection_id, external_id, product_type, sku, title,
    short_description, canonical_url, image_url, currency,
    regular_price_minor, sale_price_minor, effective_price_minor,
    stock_state, stock_quantity, categories, tags, attributes,
    is_virtual, is_downloadable, entity_version, deleted_at, updated_at
  ) VALUES (
    p_workspace_id, p_connection_id, p_external_id, p_product_type, p_sku, p_title,
    p_short_description, p_canonical_url, p_image_url, p_currency,
    p_regular_price_minor, p_sale_price_minor, p_effective_price_minor,
    p_stock_state, p_stock_quantity, p_categories, p_tags, p_attributes,
    p_is_virtual, p_is_downloadable, p_entity_version, NULL, now()
  )
  ON CONFLICT (connection_id, external_id) DO UPDATE SET
    product_type = EXCLUDED.product_type,
    sku = EXCLUDED.sku,
    title = EXCLUDED.title,
    short_description = EXCLUDED.short_description,
    canonical_url = EXCLUDED.canonical_url,
    image_url = EXCLUDED.image_url,
    currency = EXCLUDED.currency,
    regular_price_minor = EXCLUDED.regular_price_minor,
    sale_price_minor = EXCLUDED.sale_price_minor,
    effective_price_minor = EXCLUDED.effective_price_minor,
    stock_state = EXCLUDED.stock_state,
    stock_quantity = EXCLUDED.stock_quantity,
    categories = EXCLUDED.categories,
    tags = EXCLUDED.tags,
    attributes = EXCLUDED.attributes,
    is_virtual = EXCLUDED.is_virtual,
    is_downloadable = EXCLUDED.is_downloadable,
    entity_version = EXCLUDED.entity_version,
    deleted_at = NULL,
    updated_at = now()
  WHERE EXCLUDED.entity_version > public.commerce_products.entity_version
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.commerce_products WHERE connection_id = p_connection_id AND external_id = p_external_id;
    v_written := false;
  ELSE
    v_written := true;
  END IF;

  RETURN QUERY SELECT v_id, v_written;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_upsert_product FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_upsert_product TO service_role;

-- Tombstone: only applies if the delete event/observation is not itself
-- stale relative to a newer known version.
CREATE OR REPLACE FUNCTION public.commerce_tombstone_product(
  p_connection_id uuid,
  p_external_id text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.commerce_products
  SET deleted_at = now(), entity_version = p_entity_version, updated_at = now()
  WHERE connection_id = p_connection_id AND external_id = p_external_id
    AND p_entity_version > entity_version;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_tombstone_product FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_tombstone_product TO service_role;

-- ── Variants ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_product_variants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES public.commerce_products(id) ON DELETE CASCADE,
  external_id         text NOT NULL,
  sku                 text,
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency            text NOT NULL,
  regular_price_minor numeric,
  sale_price_minor    numeric,
  effective_price_minor numeric,
  stock_state         text NOT NULL DEFAULT 'unknown'
                         CHECK (stock_state IN ('in_stock','out_of_stock','backorder','unknown')),
  stock_quantity      integer,
  image_url           text,
  entity_version      text NOT NULL,
  deleted_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_variants_unique
  ON public.commerce_product_variants (connection_id, external_id);
CREATE INDEX IF NOT EXISTS commerce_variants_product_idx ON public.commerce_product_variants (product_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commerce_variants_workspace_idx ON public.commerce_product_variants (workspace_id);

ALTER TABLE public.commerce_product_variants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_product_variants FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_product_variants TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_product_variants;
CREATE POLICY "service role only" ON public.commerce_product_variants FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Same version-aware race-free upsert pattern as commerce_upsert_product.
-- Variant stock is NEVER assumed equal to parent-product stock (spec §13) —
-- this is why variants have their own version-guarded row, not a jsonb
-- blob on the parent.
CREATE OR REPLACE FUNCTION public.commerce_upsert_variant(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_product_id uuid,
  p_external_id text,
  p_sku text,
  p_attributes jsonb,
  p_currency text,
  p_regular_price_minor numeric,
  p_sale_price_minor numeric,
  p_effective_price_minor numeric,
  p_stock_state text,
  p_stock_quantity integer,
  p_image_url text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.commerce_product_variants (
    workspace_id, connection_id, product_id, external_id, sku, attributes,
    currency, regular_price_minor, sale_price_minor, effective_price_minor,
    stock_state, stock_quantity, image_url, entity_version, deleted_at, updated_at
  ) VALUES (
    p_workspace_id, p_connection_id, p_product_id, p_external_id, p_sku, p_attributes,
    p_currency, p_regular_price_minor, p_sale_price_minor, p_effective_price_minor,
    p_stock_state, p_stock_quantity, p_image_url, p_entity_version, NULL, now()
  )
  ON CONFLICT (connection_id, external_id) DO UPDATE SET
    product_id = EXCLUDED.product_id,
    sku = EXCLUDED.sku,
    attributes = EXCLUDED.attributes,
    currency = EXCLUDED.currency,
    regular_price_minor = EXCLUDED.regular_price_minor,
    sale_price_minor = EXCLUDED.sale_price_minor,
    effective_price_minor = EXCLUDED.effective_price_minor,
    stock_state = EXCLUDED.stock_state,
    stock_quantity = EXCLUDED.stock_quantity,
    image_url = EXCLUDED.image_url,
    entity_version = EXCLUDED.entity_version,
    deleted_at = NULL,
    updated_at = now()
  WHERE EXCLUDED.entity_version > public.commerce_product_variants.entity_version
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_upsert_variant FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_upsert_variant TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_tombstone_variant(
  p_connection_id uuid,
  p_external_id text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.commerce_product_variants
  SET deleted_at = now(), entity_version = p_entity_version, updated_at = now()
  WHERE connection_id = p_connection_id AND external_id = p_external_id
    AND p_entity_version > entity_version;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_tombstone_variant FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_tombstone_variant TO service_role;

-- ── Sync jobs (lease-based, prevents concurrent full syncs) ────────────
CREATE TABLE IF NOT EXISTS public.commerce_sync_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  job_type       text NOT NULL CHECK (job_type IN ('initial_sync','incremental_sync','reconciliation','manual_resync')),
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','succeeded','failed','dead_letter')),
  attempts       integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  leased_by      text,
  leased_until   timestamptz,
  last_error_code text,
  last_error_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_sync_jobs_claim_idx
  ON public.commerce_sync_jobs (status, leased_until);
CREATE INDEX IF NOT EXISTS commerce_sync_jobs_connection_idx
  ON public.commerce_sync_jobs (connection_id, status);
-- At most one active (queued/running) sync job per connection — the
-- application-level lease is backed by this constraint, not just discipline.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_sync_jobs_one_active
  ON public.commerce_sync_jobs (connection_id) WHERE status IN ('queued','running');

ALTER TABLE public.commerce_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_sync_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_sync_jobs TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_sync_jobs;
CREATE POLICY "service role only" ON public.commerce_sync_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Atomic lease claim: FOR UPDATE SKIP LOCKED means two worker processes
-- polling concurrently can never claim the same job, and a job whose lease
-- expired (worker crashed mid-sync) becomes reclaimable automatically —
-- no separate reaper process needed.
CREATE OR REPLACE FUNCTION public.commerce_claim_sync_job(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300
) RETURNS SETOF public.commerce_sync_jobs AS $$
DECLARE
  v_job_id uuid;
BEGIN
  SELECT id INTO v_job_id
  FROM public.commerce_sync_jobs
  WHERE (status = 'queued') OR (status = 'running' AND leased_until < now())
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.commerce_sync_jobs
  SET status = 'running',
      leased_by = p_worker_id,
      leased_until = now() + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1,
      updated_at = now()
  WHERE id = v_job_id
  RETURNING *;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_claim_sync_job FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_sync_job TO service_role;

-- ── Sync cursors (resumable pagination checkpoint) ─────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_sync_cursors (
  connection_id  uuid NOT NULL REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  cursor_type    text NOT NULL CHECK (cursor_type IN ('products','orders')),
  page           integer NOT NULL DEFAULT 1,
  after_cursor   text,
  modified_after timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, cursor_type)
);

ALTER TABLE public.commerce_sync_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_sync_cursors FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_sync_cursors TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_sync_cursors;
CREATE POLICY "service role only" ON public.commerce_sync_cursors FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Event idempotency ledger ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_event_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES public.workspace_plugin_installations(id) ON DELETE CASCADE,
  connection_id   uuid REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  event_id        text NOT NULL,
  event_type      text NOT NULL,
  entity_id       text NOT NULL,
  entity_version  text NOT NULL,
  status          text NOT NULL DEFAULT 'processed' CHECK (status IN ('processed','ignored_stale','error')),
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_event_receipts_unique
  ON public.commerce_event_receipts (installation_id, event_id);
CREATE INDEX IF NOT EXISTS commerce_event_receipts_connection_idx
  ON public.commerce_event_receipts (connection_id, received_at DESC);

ALTER TABLE public.commerce_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_event_receipts FROM anon, authenticated;
GRANT SELECT, INSERT ON public.commerce_event_receipts TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_event_receipts;
CREATE POLICY "service role only" ON public.commerce_event_receipts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Customer identity bridge ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_customer_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id         uuid NOT NULL REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  external_customer_id  text NOT NULL,
  visitor_id            uuid,
  verified_at           timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_customer_links_connection_idx
  ON public.commerce_customer_links (connection_id, external_customer_id);
CREATE INDEX IF NOT EXISTS commerce_customer_links_visitor_idx
  ON public.commerce_customer_links (visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_customer_links_expiry_idx
  ON public.commerce_customer_links (expires_at);

ALTER TABLE public.commerce_customer_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_customer_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_customer_links TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_customer_links;
CREATE POLICY "service role only" ON public.commerce_customer_links FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── AI tool execution audit (safe metadata only — see SECURITY.md) ─────
CREATE TABLE IF NOT EXISTS public.commerce_tool_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id     uuid REFERENCES public.commerce_connections(id) ON DELETE SET NULL,
  conversation_id   uuid,
  correlation_id    text,
  tool_name         text NOT NULL,
  duration_ms       integer,
  success           boolean NOT NULL,
  safe_error_code   text,
  cache_hit         boolean NOT NULL DEFAULT false,
  live_revalidated  boolean NOT NULL DEFAULT false,
  result_count      integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commerce_tool_audit_workspace_idx
  ON public.commerce_tool_audit (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commerce_tool_audit_conversation_idx
  ON public.commerce_tool_audit (conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE public.commerce_tool_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_tool_audit FROM anon, authenticated;
GRANT SELECT, INSERT ON public.commerce_tool_audit TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_tool_audit;
CREATE POLICY "service role only" ON public.commerce_tool_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
