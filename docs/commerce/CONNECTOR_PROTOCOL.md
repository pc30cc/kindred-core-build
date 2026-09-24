# Connector Protocol — `webyar-commerce/1`

## Capability handshake

The plugin never assumes Web Yar wants a capability, and Web Yar never
assumes the plugin has one. `GET /wp-json/webyar/v1/health` (signed)
returns:

```json
{
  "protocol_version": "webyar-commerce/1",
  "connector_version": "1.0.0",
  "woocommerce_version": "9.4.1",
  "wordpress_version": "6.7.1",
  "hpos_enabled": true,
  "capabilities": [
    "store.read", "products.read", "catalog.export", "availability.read",
    "orders.read", "tracking.read", "customer_context", "events.push",
    "widget.bootstrap"
  ],
  "catalog_ready": true
}
```

Web Yar stores this on the `commerce_connections` row
(`connector_version`, `protocol_version`, `capabilities`, `last_seen_at`,
plus platform versions). Every gateway call checks the capability is
present before calling the corresponding route; an absent capability
produces `commerce_permission_denied` (or, if genuinely unsupported by
the installed connector version, `connector_outdated`), never a raw 404
surfaced to the AI.

## Plugin REST surface (narrow, schema-defined — no generic proxy)

```
GET  /wp-json/webyar/v1/health
POST /wp-json/webyar/v1/products/search
POST /wp-json/webyar/v1/products/resolve
POST /wp-json/webyar/v1/products/availability
POST /wp-json/webyar/v1/orders/lookup
POST /wp-json/webyar/v1/orders/tracking
POST /wp-json/webyar/v1/orders/verify-contact
GET  /wp-json/webyar/v1/catalog/export
```

Every route: `permission_callback` requires a valid signed request (never
`__return_true`), Zod-equivalent PHP schema validation on input, a fixed
response shape (never a raw WooCommerce object dump), and per-route rate
limiting. `products/resolve` and `products/availability` accept **arrays**
of ids so a 5-product live-revalidation batch is one HTTP round trip, not
five.

## Direct connectors (OpenCart)

A store-family provider without a catalogue index (`usesCatalogIndex:
false` in `server/services/commerce/connectors/registry.ts`, which
`isDirectProvider()` in `providers.ts` reads) has no catalogue export, no
events and no sync. Its extension exposes ONE signed route and a whitelist
of operations. The signature is the same `webyar-commerce/1` HMAC, over the
canonical path `/opencart/v1/<op>`:

```
POST {storeUrl}index.php?route=extension/webyar/module/webyar.api&op=<op>&store_id=<id>   OpenCart 4.1.x
POST {storeUrl}index.php?route=extension/module/webyar/api&op=<op>&store_id=<id>          OpenCart 3.0.5.x

health · products/search · products/get · products/reviews · catalog/categories
orders/list · orders/get · orders/tracking · orders/returns
```

Differences from the indexed (WooCommerce) surface:

- **Capabilities** add `reviews.read`, `returns.read` and `search.direct`.
  They do not include `catalog.export` or `events.push`. There is no
  `catalog_ready`.
- **Store scope**: the body carries `store_id`. The extension refuses a body
  whose store differs from the one OpenCart resolved for the request (one
  installation per OpenCart store; multi-store is several connections).
- **Private operations** carry `customer: { id, session_ref }` in the signed
  body. `session_ref` is opaque: it is encrypted under a key that never
  leaves the store. The extension decrypts it, re-reads that OpenCart
  session (read-only) and checks that the same customer is still signed in,
  active and in scope, on every call. A Web Yar-side link alone grants nothing.
- **Pagination**: `page` / `page_size`, at most 10. Summaries first, details
  for at most 10 ids in one call.
- **Every response** carries `_meta.db` (queries, reads, writes, ms) so the
  store-side cost is observable.
- **Money**: the store returns `{ amount, currency, formatted, tax_included }`
  in the context it actually used: language, currency, customer group and
  tax address. The formatted string is passed through untouched.
- **Errors** map to the same taxonomy below. Identity failures are
  `identity_required` / `identity_expired` / `order_access_denied`. An auth
  or identity error never falls back to cached private data.

Per-turn bounds for direct providers: at most `MAX_COMMERCE_CALLS_PER_TURN`
(3) store calls in one `COMMERCE_TOOL_DEADLINE_MS` (6 s) budget, each call
given only the time left. At most one retry, only for a transient transport
error or a 5xx (re-signed with a new nonce). Evidence given to the model is
capped at 7,000 bytes. See OPENCART.md §4, §6 and §9.

## WHMCS addon surface

WHMCS is addressed through one endpoint,
`<SystemURL>/modules/addons/webyar/api.php`, `POST` with a JSON body
`{ op, params, grant }`. It uses the same `webyar-commerce/1` signature
scheme as the WordPress plugin, computed over the fixed logical path
`/webyar/whmcs/v1` (the physical path depends on where WHMCS is installed).
Operations are a closed list: `health`, `catalog.search`, `catalog.browse`,
`session.check`, and `list` / `get` for `services`, `domains`, `invoices`,
`orders` and `tickets`. There is no write operation. Lists return at most 10
items and `has_more`. Details, grant rules and limits are in
[WHMCS.md](WHMCS.md).

| Addon answer | Web Yar error |
|---|---|
| 401 (signature, replay, clock) | `commerce_permission_denied` (health → `authentication_error`) |
| 403 `grant_invalid` | `identity_expired` → binding revoked, visitor asked to sign in |
| 403 `permission_denied` (WHMCS user permission) | `account_permission_denied` |
| 403 `feature_disabled` (section off in the addon) | `commerce_permission_denied` (health unchanged) |
| 404 | `resource_not_found` (another client's id looks the same) |
| 409 `schema_unsupported` | `connector_outdated` |
| 429 | `rate_limited` |
| 5xx / network | `commerce_live_unavailable` (one retry when time allows) |

## Money

```ts
type Money = { amountMinor: string; currency: string };
```

`amountMinor` is a **string-encoded integer** in the currency's minor unit
(e.g. IRR has no minor unit in WooCommerce's usual configuration — the
adapter stores the exact value WooCommerce reports and never invents a
cents-based conversion). No floating-point money anywhere in the pipeline.

## Canonical product / variant contracts

See `shared/commerce/types.ts` for the authoritative TypeScript types
(`CommerceProduct`, `CommerceVariant`, `CommerceTaxonomy`,
`CommerceAttribute`, `StockState`, `Money`). The plugin's PHP
`ProductReader` produces the equivalent JSON shape server-side so Web Yar
never has to guess field names per WooCommerce version.

## Events

```ts
type CommerceEvent = {
  event_id: string;          // UUID, plugin-generated, idempotency key
  installation_id: string;
  type: 'product.created' | 'product.updated' | 'product.deleted'
      | 'variation.created' | 'variation.updated' | 'variation.deleted'
      | 'stock.changed'
      | 'order.created' | 'order.updated' | 'order.status_changed';
  entity_id: string;
  entity_version: string;    // WooCommerce updated_at (ISO 8601 UTC) — used for out-of-order protection
  occurred_at: string;       // ISO 8601 UTC
  protocol_version: 'webyar-commerce/1';
  payload: Record<string, unknown>; // bounded, normalized, never raw postmeta
};
```

Ingestion (`server/routes/commerce/events.ts`) is idempotent on
`(installation_id, event_id)` via a unique constraint on
`commerce_event_receipts` — a duplicate delivery inserts nothing and
returns the original outcome. Product/stock upserts additionally compare
`entity_version` against the stored row's `entity_version`: an event whose
version is not newer than what's stored is accepted (for idempotency) but
produces **no state change** — this is what makes out-of-order delivery
(an older event arriving after a newer one, e.g. after the initial sync
races a live update) safe.

## Sync

- **Initial sync**: paginated (`per_page=50`, bounded), resumable via
  `commerce_sync_cursors` (stores last-seen `after` cursor + page), and
  version-aware on upsert (never overwrites a newer row with an older
  page's stale data — same `entity_version` comparison as events).
- **Incremental sync / reconciliation**: bounded query by
  `modified_after=<last_cursor>`, not a full catalog re-read.
- **Concurrency**: a Postgres advisory-lock-style lease row
  (`commerce_sync_jobs.leased_until`) prevents two sync runs for the same
  connection from running simultaneously; a crashed worker's lease expires
  and is reclaimed rather than blocking forever.
- Before `catalog_ready = true`, `commerce.search_products` returns a
  deterministic `catalog_syncing` result — never an empty-looking "no
  products" answer.

## AI tool registry

Tools: `commerce.search_products`, `commerce.get_product`,
`commerce.get_availability`, `commerce.get_store_info`,
`commerce.get_order_status`, `commerce.get_tracking`,
`commerce.get_customer_orders`. Each has a strict Zod input schema, a
result schema, a timeout, a required billing capability, an identity
requirement (`none` / `verified_customer` / `verified_order`), and bounded
output (result count + serialized byte cap).

Per-turn hard bounds (`server/services/ai-agent/commerce-tools/limits.ts`):
`MAX_COMMERCE_CALLS_PER_TURN = 3`, `MAX_RESULTS_PER_TOOL = 8`,
`MAX_SERIALIZED_BYTES_PER_TOOL = 12_000`, `COMMERCE_TOOL_DEADLINE_MS = 6_000`
(overall budget across every commerce tool call in one turn). These mirror
the existing `MAX_ACTIONS_PER_TURN` bounding philosophy in
`server/services/ai-agent/actions/planner.ts`.

## Error taxonomy

`commerce_not_connected`, `commerce_permission_denied`,
`commerce_live_unavailable`, `commerce_timeout`,
`commerce_invalid_response`, `product_not_found`,
`variation_not_available`, `identity_required`, `identity_expired`,
`order_not_found`, `order_access_denied`, `connector_outdated`,
`protocol_mismatch`, `catalog_syncing` (indexed providers only), and for WHMCS
`resource_not_found`, `account_permission_denied`, `rate_limited`. These are the only strings the AI
tool layer ever sees for a failure; underlying exceptions/stack traces are
logged server-side only, never forwarded.

## Version compatibility

Web Yar defines `minimum_plugin_version` and the current
`protocol_version`. A plugin below the minimum gets `connector_outdated`
on every gated tool call and a health-screen warning; a protocol mismatch
(major version bump) is rejected before any live call is attempted. Within
the `webyar-commerce/1` window, additive-only response fields are the
compatibility rule — no field is ever removed or repurposed without a
protocol version bump.
