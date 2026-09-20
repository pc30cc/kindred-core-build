-- 199: Let a full catalogue sync remove products the store no longer has.
--
-- `runSyncJobOnce` only ever upserts. Nothing in the sync path has ever been
-- able to REMOVE a row, so the product index could only grow: deletions were
-- carried exclusively by the `product.deleted` webhook event.
--
-- That makes deletion the one fact in the whole system with a single delivery
-- path and no repair. Every other drift — a price, a stock level, a renamed
-- product — is eventually corrected by the next sync, because the sync
-- rewrites whatever it finds. A deletion that misses its event is permanent.
--
-- Observed on a live store: a product was deleted in WooCommerce while event
-- delivery was down, and a full manual resync afterwards left it in the index
-- as in_stock, with a price, and a canonical URL that now 404s. The assistant
-- would go on recommending it and linking customers to a dead page. The store
-- had 68 products; the index served 69.
--
-- The fix is mark-and-sweep, which needs two pieces of bookkeeping:
--
--   commerce_products.last_seen_at     when a full sync last OBSERVED this row
--                                      in the store's catalogue export — which
--                                      is not the same as `updated_at`, since
--                                      an unchanged row is skipped by
--                                      commerce_upsert_product's version guard
--                                      and keeps its old `updated_at`.
--
--   commerce_sync_cursors.sweep_epoch  when the current full sync began. A
--                                      full sync of a large catalogue spans
--                                      several worker runs (MAX_PAGES_PER_RUN
--                                      bounds one tick), so the epoch has to
--                                      outlive a single run, and the sweep may
--                                      only fire once the last page is in.
--
-- Both columns are nullable and unread until the worker that writes them
-- ships, so applying this ahead of the code is a no-op.
--
-- The first full sync after deploy stamps `last_seen_at` on everything it
-- sees, so rows left NULL at sweep time are genuinely absent from the store —
-- which is exactly what the sweep is looking for. No backfill is needed, and
-- none is done here: guessing a "last seen" for rows nobody has observed yet
-- would defeat the first sweep.
--
-- INCREMENTAL SYNCS MUST NEVER SWEEP. `incremental_sync` and `reconciliation`
-- fetch only what changed since the cursor, so every untouched product would
-- look unseen. The worker gates the sweep on a full sync (no `modified_after`)
-- that reached its last page; this migration only provides the columns.

ALTER TABLE public.commerce_products
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

ALTER TABLE public.commerce_sync_cursors
  ADD COLUMN IF NOT EXISTS sweep_epoch timestamptz;

COMMENT ON COLUMN public.commerce_products.last_seen_at IS
  'When a FULL catalogue sync last observed this product in the store export. Distinct from updated_at, which only moves when the row actually changes. Used by the post-sync sweep to tombstone products the store no longer has.';

COMMENT ON COLUMN public.commerce_sync_cursors.sweep_epoch IS
  'Start of the full sync currently in progress. Products whose last_seen_at predates it are tombstoned when that sync reaches its final page.';

-- The sweep asks for "live rows of this connection not seen since <epoch>".
-- Partial on deleted_at IS NULL because already-tombstoned rows are never
-- candidates, which keeps the index to the working set.
CREATE INDEX IF NOT EXISTS commerce_products_sweep_idx
  ON public.commerce_products (connection_id, last_seen_at)
  WHERE deleted_at IS NULL;
