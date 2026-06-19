# Legacy Identifier Inventory

Status: design artifact. No behavior changes.
Scope: compatibility-sensitive legacy strings still present in the repository
after the prior cleanup pass (see `NAMING.md`). Internal canonical name for
docs/team communication is **Kindred Core**; customer-facing branding remains
runtime-driven and white-label.

Visibility legend:
- **B** = browser/runtime contract visible (executes in customer pages)
- **O** = operator/ops visible (logs, dashboards, grep targets)
- **D** = deploy/infra visible (Dockerfiles, image tags, deploy guides)
- **R** = repo-internal only (package.json names, source comments)

Externalization legend:
- **persisted** = baked into deployed customer pages or third-party assets
- **cached** = served via CDN / browser cache with long horizon
- **grep** = ops/runbooks may match on the literal string
- **internal** = no known external dependency

## A. Inventory table

| # | Identifier | Files | Visibility | External? | Risk if renamed | Recommendation |
|---|---|---|---|---|---|---|
| 1 | `vite_react_shadcn_ts` (root `package.json` `name`) | `package.json` | R | internal | Low — local lockfile churn only | KEEP AS-IS / DOCUMENT ONLY |
| 2 | `growth-suite-server` (server `package.json` `name`) | `server/package.json` | R, D | internal (image build args may reference) | Low–Med — Docker image labels, lockfile, any external CI referencing the package name | FUTURE ALIAS MIGRATION |
| 3 | `Growth Suite server running on port ${config.port}` (startup log) | `server/index.ts` | O | grep | Low — but ops dashboards/alerts may grep | DOCUMENT ONLY (dual-log if ever migrated) |
| 4 | `growth-suite-worker` (example image tag in comments) | `Dockerfile.worker` | D | grep, possibly persisted in operator runbooks | Low — comment example only, but copy-pasted into deploys | DOCUMENT ONLY |
| 5 | `SELF_HOST_GUIDE.md` (filename) + `# Growth Suite — Self-Host Deployment Guide` (H1) | `SELF_HOST_GUIDE.md`, README cross-links | D | persisted (external links, bookmarks) | Med — external bookmarks, search index, support links | KEEP filename. Heading: DOCUMENT ONLY |
| 6 | `<gs-widget>` custom element host | `public/widget/loader.js`, `public/widget/runtime.js`, `public/widget/runtime.css`, `index.html` | B | persisted, cached | **High** — baked into every embedded customer page DOM and any customer CSS overrides | NEVER RENAME |
| 7 | `window.__gs_runtime` runtime module global | `public/widget/runtime.js` | B | cached | **High** — runtime-loaded module identity; renaming breaks in-flight loaders cached in browsers | NEVER RENAME |
| 8 | `window.__gs` queue array (embed snippet contract) | `index.html`, `SELF_HOST_GUIDE.md` snippet | B | persisted (in customer HTML) | **Critical** — public embed contract; renaming silently breaks every deployed snippet | NEVER RENAME |
| 9 | `window.__gs_id` (workspace id on embed snippet) | `SELF_HOST_GUIDE.md`, loader | B | persisted | **Critical** — same as #8 | NEVER RENAME |
| 10 | `window.__gs_policy`, `window.__gs_token`, `window.__gs_identity`, `window.__gs_departments`, `window.__gs_call*`, `window.__gs_debug` | `public/widget/runtime.js`, `public/widget/loader.js` | B | cached (cross-module contract within widget bundle) | High — coupled across loader/runtime/call modules; renames must be atomic across all asset versions served from CDN | SAFE TO MIGRATE ONLY WITH PHASED ROLLOUT (dual-write/dual-read) |
| 11 | `.gs-launcher` CSS class (and template-scoped variants) | `public/widget/runtime.css`, `public/widget/runtime.js` | B | persisted (customer CSS overrides may target it) | Med–High — operators sometimes override widget CSS via host-page rules | SAFE TO MIGRATE WITH ALIAS (dual-class) |
| 12 | `.shell`, `.panel` internal class hooks | `public/widget/runtime.css`, `public/widget/runtime.js` | B | cached (internal but inside shadow DOM, low external coupling) | Low — shadow-DOM scoped | FUTURE ALIAS MIGRATION (low priority) |
| 13 | `LOADER_VERSION = "2026-04-22-token-bus-v1"` | `public/widget/loader.js` | B, O | cached, grep | Low — value already changes over time; the *name* is what matters for diagnostics | KEEP AS-IS |
| 14 | `[gs-widget]`, `[gs-call]` console log prefixes | `public/widget/runtime.js` | B, O | grep (browser devtools, support transcripts) | Low — but support workflows grep these | DOCUMENT ONLY |
| 15 | `Adapted from WebYar Growth Suite ...` source comments | already removed | R | internal | n/a | DONE (tracked in `NAMING.md`) |
| 16 | `IRANYekanXILACHAT` font reference | already removed from `runtime.css` | B | n/a | n/a | DONE |
| 17 | `window.__gs_debug` toggle (documented in `docs/REALTIME_REGRESSION_CHECKLIST.md`) | docs + runtime | B, O | grep (runbooks) | Low | KEEP AS-IS |
| 18 | Asset paths: `/widget/loader.js`, `/widget/runtime.js`, `/widget/runtime.css`, `/widget/runtime-*.js` | loader, server, embed snippets | B | persisted, cached | **Critical** — stable URLs are the public loader contract | NEVER RENAME |
| 19 | Manifest field shape (hashed asset map produced by `scripts/widget-hash.js`) | `scripts/widget-hash.js` consumers | B | cached | High — loader expects exact field names | NEVER RENAME (treat as wire format) |
| 20 | Env vars (existing `*_URL`, `SUPABASE_*`, `WORKER_KIND`, etc.) | server, worker, deploy docs | D, O | persisted in operator `.env` files | High — operator break on rename | NEVER RENAME without dual-read window |

## B. Cross-references

- `NAMING.md` — current state of cleaned vs preserved literals.
- `README.md` §“Naming & legacy identifiers”.
- `SELF_HOST_GUIDE.md` — embed snippet contract (items 8, 9, 18).
- `docs/REALTIME_REGRESSION_CHECKLIST.md` — operator debug toggle (item 17).

## C. Notes on “externalization”

The widget loader URL and the `window.__gs*` snippet contract are *the* public
API of the platform from a customer's HTML. Anything reachable from a copied
`<script>` snippet on a customer page is, in practice, frozen — a rename is a
breaking change for every site that has ever installed the widget, regardless
of what the codebase says today.