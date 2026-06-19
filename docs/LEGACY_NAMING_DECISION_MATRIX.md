# Legacy Naming Decision Matrix

Authoritative classification for each remaining legacy identifier. Drives
ADR-002 and `docs/LEGACY_MIGRATION_PLAN.md`. See
`docs/LEGACY_IDENTIFIER_INVENTORY.md` for evidence and file references.

Categories:
- **KEEP AS-IS** — no action ever; not worth touching.
- **DOCUMENT ONLY** — leave the identifier; explain it in `NAMING.md`.
- **FUTURE ALIAS MIGRATION** — eligible for Phase 2 dual-emission, then
  Phase 3/4 if telemetry permits.
- **FUTURE HARD MIGRATION** — eligible for Phase 5, only after a full alias
  + sunset cycle and explicit ADR-level approval.
- **NEVER RENAME** — frozen public contract; out of scope of any migration
  plan unless a new ADR supersedes ADR-002.

| Identifier | Where | Recommendation | Why |
|---|---|---|---|
| `vite_react_shadcn_ts` (root pkg name) | `package.json` | KEEP AS-IS | Internal-only; not user-visible. Renaming churns lockfile and any external CI cache key for zero benefit. |
| `growth-suite-server` (server pkg name) | `server/package.json` | FUTURE ALIAS MIGRATION | Internal-only but referenced by Dockerfiles and possibly external CI. Migratable with a one-cycle alias + Docker tag transition. |
| `Growth Suite server running on port …` | `server/index.ts` | DOCUMENT ONLY | Operator-visible grep target. If ever migrated, dual-log in Phase 2; never silently rename. |
| `growth-suite-worker` (example image tag) | `Dockerfile.worker` comments | DOCUMENT ONLY | Comment example; copy-pasted into operator runbooks. Update only as part of an announced worker image rename. |
| `SELF_HOST_GUIDE.md` (filename) | repo root | NEVER RENAME | Filename is externally linked from README and likely from external bookmarks/search. |
| `# Growth Suite — Self-Host Deployment Guide` (H1 only) | `SELF_HOST_GUIDE.md` | DOCUMENT ONLY | Heading text is safe to evolve in a docs-only PR; filename stays. |
| `<gs-widget>` custom element | widget loader/runtime/CSS, `index.html` | NEVER RENAME | Defines the shadow-root host on every embedded customer page. Renaming silently breaks every deployed snippet. |
| `window.__gs_runtime` | `public/widget/runtime.js` | NEVER RENAME | Module identity assumed by loader and cached bundles served from CDN at varying ages. |
| `window.__gs` (embed queue) | `index.html`, `SELF_HOST_GUIDE.md` snippet | NEVER RENAME | Public embed contract baked into customer HTML. |
| `window.__gs_id` (embed workspace id) | embed snippet, loader | NEVER RENAME | Same contract as `window.__gs`. |
| `window.__gs_policy`, `__gs_token`, `__gs_identity`, `__gs_departments`, `__gs_call*` | runtime.js, loader.js | FUTURE ALIAS MIGRATION | Cross-module bundle contract; eligible for dual-emission only with full Phase 2 plan. Default reads stay legacy. |
| `window.__gs_debug` | runtime, docs | KEEP AS-IS | Operator/devtools toggle documented in `docs/REALTIME_REGRESSION_CHECKLIST.md`. |
| `.gs-launcher` CSS class | `public/widget/runtime.css`, runtime.js | FUTURE ALIAS MIGRATION | Customers may target it from host-page CSS. Phase 2 emits both classes. |
| `.shell`, `.panel` shadow-DOM classes | runtime.css, runtime.js | FUTURE ALIAS MIGRATION | Shadow-DOM scoped → low blast radius, but still touch via the same plan to avoid one-off renames. |
| `LOADER_VERSION` constant name | `public/widget/loader.js` | KEEP AS-IS | The *value* rotates by design; the *name* is a stable diagnostic anchor. |
| `[gs-widget]`, `[gs-call]` console log prefixes | runtime.js | DOCUMENT ONLY | Support transcripts grep these. Migrate only with a dual-prefix Phase 2. |
| Asset URLs `/widget/loader.js`, `/widget/runtime.js`, `/widget/runtime.css`, `/widget/runtime-*.js` | server, loader, embed | NEVER RENAME | Public loader contract. Path changes are equivalent to breaking every customer snippet. |
| Widget asset manifest field shape (output of `scripts/widget-hash.js`) | build + loader | NEVER RENAME | Wire format between build output and loader; treat as protocol. |
| Env-var names (`*_URL`, `SUPABASE_*`, `WORKER_KIND`, …) | server, worker, deploy docs | NEVER RENAME (without dual-read) | Persisted in operator `.env` files; renames silently break running deployments. |
| `Adapted from WebYar Growth Suite …` source comments | already removed | n/a | Already cleaned in prior pass. |
| `IRANYekanXILACHAT` font reference | already removed | n/a | Already cleaned in prior pass. |

## Summary

- Frozen forever: `<gs-widget>`, `window.__gs`, `window.__gs_id`,
  `window.__gs_runtime`, asset URL family, manifest field shape, env vars,
  `SELF_HOST_GUIDE.md` filename, `LOADER_VERSION` name, `window.__gs_debug`,
  root `package.json` name.
- Could migrate later (alias-first, telemetry-gated): `growth-suite-server`,
  `__gs_*` global family, `.gs-launcher` / `.shell` / `.panel`, console log
  prefixes, startup log wording, worker example image tag, self-host guide
  H1 text.
- Already done: source-comment brand strings, `IRANYekanXILACHAT` font,
  hardcoded "Growth Suite" UI literal in `ProfilePage.tsx`.