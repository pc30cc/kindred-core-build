# Commerce Integration Platform — Architecture

Status: Phase 1 (read-only) implemented. WooCommerce is the first (indexed)
connector; OpenCart is the first **direct** connector (see
[OPENCART.md](./OPENCART.md)).

## Why this exists

Web Yar's AI Agent needs to answer real commerce questions ("is this in
stock?", "where's my order?") without becoming coupled to any single
e-commerce platform. This document describes the permanent architecture:
WooCommerce today, Shopify/PrestaShop/OpenCart/EDD/Sazito later, with zero
changes to the AI Agent core or the Widget.

## Trust boundaries (the invariant)

```
Visitor
   │  (widget session cookie — server/services/widget/visitorIdentity.ts)
   ▼
Web Yar Widget
   │
   ▼
Web Yar AI Agent (server/services/ai-agent/**)
   │  commerce.* tool calls only — never a provider-specific call
   ▼
Commerce Tool Registry (server/services/ai-agent/commerce-tools/**)
   │  Zod-validated input/output, permission + identity gates, bounded rounds
   ▼
Commerce Gateway (server/services/commerce/gateway.ts)
   │  tenant resolution, SSRF-guarded HTTP, timeouts/retries, error taxonomy
   ▼
CommerceConnector contract (shared/commerce/types.ts)
   │
   ├── WooCommerce connector (server/services/commerce/connectors/woocommerce.ts)
   ├── Shopify        [future — same contract, new adapter]
   ├── PrestaShop      [future]
   ├── OpenCart connector (server/services/commerce/connectors/opencart.ts) — direct, no index
   ├── EDD             [future]
   └── Sazito          [future]
```

The AI Agent knows `commerce.search_products`, `commerce.get_product`,
`commerce.get_availability`, `commerce.get_store_info`,
`commerce.get_order_status`, `commerce.get_tracking`,
`commerce.get_customer_orders`. It never sees `wc_get_product`,
`/wp-json/wc/v3/...`, `woocommerce_order_id`, or any provider-shaped
payload. All of that lives behind the connector adapter, which normalizes
into `CommerceProduct` / `CommerceOrder` / `TrackingResult` before anything
reaches the tool layer.

## Two deliverables

1. **Web Yar Commerce Platform** (this repo): Commerce Gateway, canonical
   product index, connector contract + WooCommerce adapter, event
   ingestion, sync worker, AI tool registry, admin UX, entitlements.
2. **`webyar-woocommerce` WordPress plugin** (`plugins/webyar-woocommerce/`):
   a lightweight bridge. It has no LLM, no prompt construction, no
   embeddings, no analytics engine. It reads WooCommerce data through
   official CRUD APIs, signs/verifies HMAC requests, and pushes bounded
   events through Action Scheduler. See `docs/commerce/WOOCOMMERCE.md`.

## How this reuses existing canonical infrastructure

This is not a parallel stack. Concretely:

| Need | Reused from | Notes |
|---|---|---|
| Encrypted credential storage | `server/lib/pluginCrypto.ts` (AES-256-GCM) + `plugin_secrets` table | Installation secrets and WooCommerce API credentials use the exact same envelope, `live`/`pending`/`previous` slots, and stage→verify→promote lifecycle as the Telegram connector (`server/services/channels/telegram/setup.ts`). |
| Pairing lifecycle shape | Telegram `setup.ts` connect flow | Same pattern: stage credential → external verification → DB-authoritative ownership claim → atomic promotion → rollback-safe failure. |
| SSRF protection | `shared/net/hostGuard.ts` (`checkOutboundUrl`, `isSafeOutboundUrl`) | Used unmodified by the Commerce Gateway before every live call to a merchant's plugin origin. |
| Tenant/workspace authorization | `server/lib/workspaceAuth.ts` (`authorizeWorkspaceAccess`, `is_workspace_member` RPC) | All commerce admin routes go through this; fails closed on error. |
| Guest order identity verification | `server/services/verification/` (Generic Verification Core v1) | A new purpose (`commerce_order_lookup`) is registered in `types.ts` — this is exactly the "future consumer" the module's own docs anticipate. No second OTP system was built. |
| Billing / entitlement gating | `server/services/billing/capabilityRegistry.ts` + `server/middleware/featureGating.ts` | New `commerce`, `commerce_woocommerce`, `commerce_orders`, `commerce_customer_history`, `commerce_max_connected_stores` capability entries, enforced the same way every other module is. |
| Audit logging | `server/services/privacy/audit.ts` pattern (`audit_logs` table) | `server/services/commerce/audit.ts` mirrors it exactly: best-effort, workspace-scoped, never throws. |
| Widget visitor identity | `server/services/widget/visitorIdentity.ts` | The customer-identity bridge binds a verified WooCommerce customer to the existing signed `dvsid` visitor cookie; no new visitor-identity mechanism. |
| Background jobs | `worker/index.ts` table-polling convention | New `commerce-sync` worker kind, new `commerce_sync_jobs` table, same shape as `ai_source_sync_jobs`. |
| Money/PII minimization philosophy | N/A (new) | See SECURITY.md — no payment data, no full billing payload, no unbounded PII mirroring. |

## Two search strategies (provider profiles)

`server/services/commerce/providers.ts` declares, per provider, what Web Yar
does in the background for it. Nothing else decides this.

| | WooCommerce (`indexed`) | OpenCart (`direct`) |
|---|---|---|
| Product search | canonical index in Postgres (`commerce_products`), revalidated live | live, on the store, per question |
| Catalogue sync / events / reconcile | yes (`commerce-sync` worker) | **none**: the worker's reconcile query filters by `providersWithBackgroundWork()` |
| Periodic health | yes | **none**: health is recorded from real calls (transitions only) plus a rate-limited manual check |
| `catalog_ready` gate | yes | not applicable; direct calls skip it |
| Guest order OTP | yes | no, sign-in only (`guestOtp: false`) |
| AI stage | `runner.ts` (KB-like stage) | `directRunner.ts`, called from the same `runner.ts` entry point |
| Connector contract | `CommerceConnector` | `DirectCommerceConnector` (extends it; `isDirectConnector()`) |

Connection choice per conversation (`resolveConversationConnection`): the
page URL's store, then the store the visitor is signed in to, then the only
store, then the newest (the previous behaviour). A link or a URL can only
choose among the workspace's own rows.

## Data ownership

- **Knowledge Base** stays about policies/FAQ/company knowledge. It never
  receives product data.
- **Commerce Catalog** (`commerce_products`, `commerce_product_variants`)
  owns product/price/variant/attribute/category data, refreshed by sync +
  events, always subject to live revalidation for volatile fields.
- **Live Commerce** (price/stock/orders/tracking) is queried live from the
  plugin through the Commerce Gateway when freshness matters; the catalog
  is a search index, not a source of truth for money or stock.
- **Direct providers (OpenCart)** have no Commerce Catalog rows at all. Web
  Yar stores connection metadata, identity links, the ids of the last
  listed products/orders in the conversation's metadata (for follow-ups)
  and tool audit rows. See OPENCART.md §7 for the full table.

## AI integration model (important architectural decision)

This repo's AI Agent does **not** use native provider tool-calling in a
multi-round agent loop (see `runInternal`'s `<ai_actions>` text-convention
plan in `server/services/ai-agent/actions/`). Commerce tools are therefore
integrated the same way Knowledge Base retrieval is: as a **new pipeline
stage** (`server/services/ai-agent/engine/commerceStage.ts`), run once,
before generation, alongside `runRetrievalStage`:

```
preflightStage → contextStage → automationStage → runtimeDecisionStage
   → retrievalStage (KB)
   → commerceStage (NEW: detect commerce intent → run bounded commerce.*
                     tools → structured, sanitized results become part of
                     the generation context, never raw HTML)
   → answerStage → generationStage → deliveryStage
```

This keeps the existing "no unbounded agent loop, no model-invented
authorization" invariant for free — the tool calls are deterministic
function calls driven by intent detection + structured filter extraction,
not model-issued HTTP requests. See `docs/commerce/CONNECTOR_PROTOCOL.md`
§AI Tool Architecture for the bounded-round/deadline model and how a
future native-tool-calling provider would still be constrained by the same
gates.

## Extending to a second connector (e.g. Shopify)

1. Implement `CommerceConnector` (`shared/commerce/types.ts`) for Shopify.
2. Declare its capability set in `server/services/commerce/capabilities.ts`.
3. Register it in `server/services/commerce/connectors/registry.ts`.
4. Add its own auth strategy (Shopify uses real OAuth2 — reuse the shape in
   `server/services/seo/gsc/oauthConfig.ts`, not WooCommerce's pairing flow).
5. Normalize Shopify's product/order shapes into `CommerceProduct` /
   `CommerceOrder` inside the adapter — never leak Shopify GraphQL shapes
   past the adapter boundary.
6. Run the connector contract tests in `src/test/commerce/connectorContract.test.ts`
   against the new adapter.

No AI prompt, tool schema, or generation-stage code changes are required.
