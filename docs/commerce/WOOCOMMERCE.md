# WooCommerce Connector

## Supported versions (audited baseline)

- PHP >= 7.4 (matches WooCommerce's own current minimum; the plugin avoids
  PHP 8-only syntax so it degrades gracefully rather than fatal-erroring on
  an older host).
- WordPress >= 6.0.
- WooCommerce >= 8.0 (first release cycle with stable HPOS +
  `WC_Order_Query` coverage the plugin depends on).
- The plugin checks all three at activation and on every admin load; if any
  is unmet it deactivates its active behavior (no REST routes registered,
  no Action Scheduler jobs, no widget loader) and shows a single admin
  notice. It never fatals wp-admin or the storefront.

## HPOS

All reads/writes go through `wc_get_order()`, `WC_Order`,
`WC_Order_Query`, `wc_get_product()`, `WC_Product` /
`WC_Product_Variation`, `WC_Customer` — never direct `wp_posts` /
`wp_postmeta` queries. This is what makes the plugin HPOS-compatible by
construction; `FeaturesUtil::declare_compatibility('custom_order_tables',
...)` is declared in the plugin bootstrap. Tested against both HPOS-enabled
and legacy-post-storage environments (`tests/` in the plugin — see below).

## Performance invariant

A normal storefront/product-page request does **zero** synchronous Web Yar
network calls. Reads that the AI needs are served from Web Yar's own
catalog index (kept warm by sync + events); the plugin's REST routes only
answer when Web Yar's Commerce Gateway calls them, which happens off the
customer's request path. Product/order mutations enqueue a bounded
Action-Scheduler job (`WebYar\WooCommerce\Events\EventQueue`) and return
immediately — delivery to Web Yar happens asynchronously, after the
request completes. Checkout performs no Web Yar call, synchronous or
asynchronous, at all: cart/checkout/payment/order-creation are wired to
zero Web Yar hooks.

## Structure

See the plugin at `plugins/webyar-woocommerce/`. Namespace
`WebYar\WooCommerce`, PSR-4 autoloaded from `src/`. No Composer
dependencies beyond the autoloader — native PHP crypto
(`hash_hmac`, `sodium_crypto_secretbox` where available, `openssl`
fallback), WordPress APIs, WooCommerce CRUD, and Action Scheduler (already
a WooCommerce dependency, not a new one).

## Tracking abstraction

`TrackingResolver` checks known common tracking meta keys first (the
WooCommerce Shipment Tracking plugin's convention,
`_wc_shipment_tracking_items`), then exposes:

```php
$tracking = apply_filters( 'webyar_commerce_tracking_payload', $tracking, $order );
```

so any Iranian shipping/tracking plugin can add its own tracking numbers
without a Web Yar core change or a plugin fork.

## Auto widget install

A single settings toggle injects the existing Web Yar loader snippet
(the same one from `src/pages/app/settings/IntegrationsPage.tsx`'s
copy-snippet flow) with this workspace's website id — it does not bundle
a second widget runtime. If a loader script for the same website id is
already present (detected via a DOM/script-tag scan hook the plugin
exposes at `wp_footer` priority 5), the plugin skips injection to avoid a
double-loaded widget.

## Uninstall / disconnect

`uninstall.php` removes plugin-owned options (`autoload=no` group),
scheduled Action Scheduler jobs, transients (including the replay-guard
cache), and the locally stored encrypted installation credential. It never
touches WooCommerce's own product/order data. If the uninstall request
cannot reach Web Yar to revoke server-side (network down during
uninstall), local secret deletion still happens — the server-side
installation is left to go stale via `last_seen_at` and is treated as
`offline` after the heartbeat grace window, then eligible for admin
revocation.

## Staging / clone protection

The plugin records the WordPress `siteurl` it was paired against. On every
signed request it includes that recorded origin; Web Yar's Commerce
Gateway compares it to the approved origin on file
(`commerce_connections.approved_origin`) and to the request's actual
resolved network origin. A mismatch (cloned database, `siteurl` changed,
staging copy) flips the connection to `stale_origin` and refuses live
reads/event ingestion until the owner explicitly reconnects — a
production credential can never silently start acting on behalf of a
staging clone.
