=== Web Yar Connector for WooCommerce ===
Contributors: webyar
Tags: woocommerce, ai, chat, customer support, commerce
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
WC requires at least: 8.0
WC tested up to: 9.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A lightweight, secure bridge between your WooCommerce store and the Web Yar AI Assistant.

== Description ==

This plugin does NOT run an AI model, does NOT build a prompt, does NOT create embeddings or a vector index, and does NOT run background AI processing. All of that lives on Web Yar's own infrastructure. This plugin's job is narrow and secure:

* Answer signed, authenticated requests from Web Yar about your products, stock, orders, and tracking
* Push bounded product/order change events to Web Yar in the background via WooCommerce's own Action Scheduler
* Pair with your Web Yar workspace using a one-click, OAuth-style authorization flow (no API keys to copy/paste)

Your storefront and checkout are never slowed down by Web Yar: connecting this plugin adds zero synchronous network calls to a normal page load, and checkout never waits on Web Yar. If Web Yar is unreachable, your store keeps working exactly as before — cart, checkout, payment, and order creation are completely unaffected.

= Requirements =

* PHP 7.4+
* WordPress 6.0+
* WooCommerce 8.0+ (active)
* HPOS (High-Performance Order Storage) compatible — tested with HPOS enabled and with legacy post-based order storage

= Security =

* No Consumer Key/Secret copy-paste — pairing uses an OAuth-style authorization-code flow with PKCE
* All machine requests are HMAC-SHA256 signed, with replay protection and bounded clock skew
* Installation credentials are encrypted at rest and never returned through any REST response, logged, or embedded in HTML/JS
* Order and customer data are never exposed without verified identity — an order number alone is never sufficient

See docs/commerce/ in the Web Yar repository for the full architecture and security documentation.

== Installation ==

1. Install and activate the plugin.
2. Go to WooCommerce → Web Yar (or the "Web Yar" menu item).
3. Click "Connect to Web Yar" and follow the authorization flow.
4. Choose your Web Yar workspace and approve the permissions you want to grant.

== Changelog ==

= 1.0.0 =
* Initial release — WooCommerce connector for the Web Yar Commerce Integration Platform.
