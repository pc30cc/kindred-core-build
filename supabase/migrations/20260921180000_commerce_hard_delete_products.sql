-- ─────────────────────────────────────────────────────────────────────────
-- A deleted product leaves the index for good.
--
-- Until now a delete only set `deleted_at`: the row stayed, with its title,
-- description, URLs, category JSON and full-text vector — roughly 800 bytes
-- and seven index entries per product that no longer exists. Nothing ever
-- removed them, so the table only grew, and `commerce_products` stopped
-- being an answer to "what does this store sell".
--
-- The row is now really deleted. What stays behind is a single line in
-- `commerce_deleted_entities`: the id and the version at which it went. It
-- exists for one reason, and it is not bookkeeping.
--
-- WooCommerce delivers events through Action Scheduler with retries, so a
-- "product updated" queued before a "product deleted" can arrive after it.
-- With the row gone there is nothing for the version check in
-- commerce_upsert_product to compare against, and the upsert would happily
-- INSERT the product back — the assistant would then offer customers a
-- product the store no longer has, which is precisely the failure this
-- whole index is supposed to prevent. The gravestone is what a late write
-- collides with.
--
-- It is ~60 bytes, it expires after 7 days (the plugin's own retry ladder
-- tops out around two hours, so a week is already far past any event that
-- could still be in flight), and it is cleared the moment a genuinely newer
-- version arrives — which is how un-trashing a product in WooCommerce puts
-- it straight back in the catalogue.
-- ─────────────────────────────────────────────────────────────────────────

-- Present in the live database but missing from the migration that created
-- the table; stamped page by page during a full sync and read by the sweep.
-- Added idempotently so the file and the database finally agree.
ALTER TABLE public.commerce_products ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE TABLE IF NOT EXISTS public.commerce_deleted_entities (
  connection_id  uuid NOT NULL REFERENCES public.commerce_connections(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('product','variant')),
  external_id    text NOT NULL,
  -- The store's own version at the moment of the delete. A write that is
  -- not strictly newer than this is a straggler and is dropped.
  entity_version text NOT NULL,
  deleted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, kind, external_id)
);

CREATE INDEX IF NOT EXISTS commerce_deleted_entities_expiry_idx
  ON public.commerce_deleted_entities (deleted_at);

ALTER TABLE public.commerce_deleted_entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_deleted_entities FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_deleted_entities TO service_role;
DROP POLICY IF EXISTS "service role only" ON public.commerce_deleted_entities;
CREATE POLICY "service role only" ON public.commerce_deleted_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Carry the existing gravestones over, then clear the rows ────────────
-- Every row currently carrying a deleted_at becomes one line here and is
-- then removed for real. Variants go with their parent through the FK's
-- ON DELETE CASCADE; the ones deleted on their own are carried the same way.
INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version, deleted_at)
SELECT connection_id, 'product', external_id, entity_version, deleted_at
  FROM public.commerce_products
 WHERE deleted_at IS NOT NULL
ON CONFLICT (connection_id, kind, external_id) DO NOTHING;

INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version, deleted_at)
SELECT v.connection_id, 'variant', v.external_id, v.entity_version, v.deleted_at
  FROM public.commerce_product_variants v
 WHERE v.deleted_at IS NOT NULL
   -- One whose parent is going too needs no line of its own: the parent's
   -- gravestone already stops the product, and with it the variant, coming
   -- back.
   AND NOT EXISTS (
     SELECT 1 FROM public.commerce_products p
      WHERE p.id = v.product_id AND p.deleted_at IS NOT NULL
   )
ON CONFLICT (connection_id, kind, external_id) DO NOTHING;

DELETE FROM public.commerce_product_variants WHERE deleted_at IS NOT NULL;
DELETE FROM public.commerce_products WHERE deleted_at IS NOT NULL;

-- ── The column itself goes ──────────────────────────────────────────────
-- Postgres drops an index whose predicate names a dropped column, so the
-- partial ones are rebuilt. `commerce_products_active_idx` is NOT rebuilt:
-- without the predicate it is a plain index on connection_id, which the
-- (connection_id, external_id) unique index already answers.
ALTER TABLE public.commerce_products DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE public.commerce_product_variants DROP COLUMN IF EXISTS deleted_at;

CREATE INDEX IF NOT EXISTS commerce_products_stock_idx
  ON public.commerce_products (connection_id, stock_state);
CREATE INDEX IF NOT EXISTS commerce_products_price_idx
  ON public.commerce_products (connection_id, effective_price_minor);
CREATE INDEX IF NOT EXISTS commerce_variants_product_idx
  ON public.commerce_product_variants (product_id);

-- ── Deletes ─────────────────────────────────────────────────────────────

/**
 * Expired gravestones, cleared opportunistically.
 *
 * Called from the delete paths themselves rather than from a scheduled job:
 * the work only needs doing when deletes are happening, and an indexed
 * range delete over a table this small costs nothing.
 */
CREATE OR REPLACE FUNCTION public.commerce_purge_expired_deletions() RETURNS void AS $$
BEGIN
  DELETE FROM public.commerce_deleted_entities
   WHERE deleted_at < now() - interval '7 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_purge_expired_deletions FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_purge_expired_deletions TO service_role;

/**
 * Remove a product, unless the delete is older than what we already hold.
 *
 * Returns true when a row was actually removed. A delete for something the
 * index never had still records a gravestone — that is the case where a
 * product is created and deleted between two syncs, and the create is still
 * somewhere in the queue.
 */
CREATE OR REPLACE FUNCTION public.commerce_tombstone_product(
  p_connection_id uuid,
  p_external_id text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_live_version text;
  v_deleted integer := 0;
BEGIN
  SELECT entity_version INTO v_live_version
    FROM public.commerce_products
   WHERE connection_id = p_connection_id AND external_id = p_external_id;

  IF v_live_version IS NOT NULL AND p_entity_version <= v_live_version THEN
    RETURN false; -- a straggler; what we hold is newer than this delete
  END IF;

  DELETE FROM public.commerce_products
   WHERE connection_id = p_connection_id AND external_id = p_external_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
  VALUES (p_connection_id, 'product', p_external_id, p_entity_version)
  ON CONFLICT (connection_id, kind, external_id) DO UPDATE
    SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version),
        deleted_at     = now();

  PERFORM public.commerce_purge_expired_deletions();
  RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_tombstone_product FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_tombstone_product TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_tombstone_variant(
  p_connection_id uuid,
  p_external_id text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_live_version text;
  v_deleted integer := 0;
BEGIN
  SELECT entity_version INTO v_live_version
    FROM public.commerce_product_variants
   WHERE connection_id = p_connection_id AND external_id = p_external_id;

  IF v_live_version IS NOT NULL AND p_entity_version <= v_live_version THEN
    RETURN false;
  END IF;

  DELETE FROM public.commerce_product_variants
   WHERE connection_id = p_connection_id AND external_id = p_external_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
  VALUES (p_connection_id, 'variant', p_external_id, p_entity_version)
  ON CONFLICT (connection_id, kind, external_id) DO UPDATE
    SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version),
        deleted_at     = now();

  PERFORM public.commerce_purge_expired_deletions();
  RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_tombstone_variant FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_tombstone_variant TO service_role;

/**
 * Everything a completed FULL sync never met.
 *
 * `last_seen_at` is stamped page by page during the run, so "older than the
 * epoch, or never stamped at all" is exactly "absent from the store's
 * catalogue". One statement instead of a read followed by two writes, so a
 * sweep of a large catalogue is a single round trip and cannot half-apply.
 *
 * The sweep is an observation about right now, so `now()` is the version it
 * records — newer than any updated_at the store could have given us, which
 * is what makes it win over anything still in the queue.
 */
CREATE OR REPLACE FUNCTION public.commerce_sweep_absent_products(
  p_connection_id uuid,
  p_sweep_epoch timestamptz
) RETURNS integer AS $$
DECLARE
  v_count integer;
  v_now text := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
  WITH gone AS (
    DELETE FROM public.commerce_products
     WHERE connection_id = p_connection_id
       AND (last_seen_at IS NULL OR last_seen_at < p_sweep_epoch)
    RETURNING external_id
  ), recorded AS (
    INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
    SELECT p_connection_id, 'product', external_id, v_now FROM gone
    ON CONFLICT (connection_id, kind, external_id) DO UPDATE
      SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version),
          deleted_at     = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM recorded;

  PERFORM public.commerce_purge_expired_deletions();
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_sweep_absent_products FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_sweep_absent_products TO service_role;

-- ── Writes now have to get past the gravestone ──────────────────────────

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
  v_deleted_version text;
BEGIN
  SELECT entity_version INTO v_deleted_version
    FROM public.commerce_deleted_entities
   WHERE connection_id = p_connection_id AND kind = 'product' AND external_id = p_external_id;

  IF v_deleted_version IS NOT NULL AND p_entity_version <= v_deleted_version THEN
    -- A write that left the store before the delete did. Letting it through
    -- would put a product the store no longer sells back in front of
    -- customers.
    RETURN QUERY SELECT NULL::uuid, false;
    RETURN;
  END IF;

  -- Strictly newer than the delete means the store has it again (an
  -- un-trashed product keeps its id), so the gravestone has served its turn.
  IF v_deleted_version IS NOT NULL THEN
    DELETE FROM public.commerce_deleted_entities
     WHERE connection_id = p_connection_id AND kind = 'product' AND external_id = p_external_id;
  END IF;

  INSERT INTO public.commerce_products (
    workspace_id, connection_id, external_id, product_type, sku, title,
    short_description, canonical_url, image_url, currency,
    regular_price_minor, sale_price_minor, effective_price_minor,
    stock_state, stock_quantity, categories, tags, attributes,
    is_virtual, is_downloadable, entity_version, updated_at
  ) VALUES (
    p_workspace_id, p_connection_id, p_external_id, p_product_type, p_sku, p_title,
    p_short_description, p_canonical_url, p_image_url, p_currency,
    p_regular_price_minor, p_sale_price_minor, p_effective_price_minor,
    p_stock_state, p_stock_quantity, p_categories, p_tags, p_attributes,
    p_is_virtual, p_is_downloadable, p_entity_version, now()
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
  v_deleted_version text;
BEGIN
  SELECT entity_version INTO v_deleted_version
    FROM public.commerce_deleted_entities
   WHERE connection_id = p_connection_id AND kind = 'variant' AND external_id = p_external_id;

  IF v_deleted_version IS NOT NULL AND p_entity_version <= v_deleted_version THEN
    RETURN false;
  END IF;

  IF v_deleted_version IS NOT NULL THEN
    DELETE FROM public.commerce_deleted_entities
     WHERE connection_id = p_connection_id AND kind = 'variant' AND external_id = p_external_id;
  END IF;

  INSERT INTO public.commerce_product_variants (
    workspace_id, connection_id, product_id, external_id, sku, attributes,
    currency, regular_price_minor, sale_price_minor, effective_price_minor,
    stock_state, stock_quantity, image_url, entity_version, updated_at
  ) VALUES (
    p_workspace_id, p_connection_id, p_product_id, p_external_id, p_sku, p_attributes,
    p_currency, p_regular_price_minor, p_sale_price_minor, p_effective_price_minor,
    p_stock_state, p_stock_quantity, p_image_url, p_entity_version, now()
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
    updated_at = now()
  WHERE EXCLUDED.entity_version > public.commerce_product_variants.entity_version
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.commerce_upsert_variant FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_upsert_variant TO service_role;
