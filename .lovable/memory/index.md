# Project Memory

## Core
Self-host-first SaaS platform. No Lovable Cloud dependency.
External Supabase: bdycuenbjztkgnaqonfm.supabase.co
Provider-driven architecture — all business logic via interfaces.
White-label: no hardcoded brand/domain. All branding from admin.
Multilingual: fa (RTL), en (LTR), tr (LTR). Fallback chains.
Service role key: NEVER in frontend.
Primary #3B82F6 (blue), clean professional SaaS design.
Account = billing unit; Workspace = operational unit. Route-based: /app/w/:slug/*.

## Memories
- [Architecture rules](mem://features/architecture) — Self-host, provider-driven, single source of truth
- [Workspace architecture](mem://features/workspace-architecture) — Crisp-like accounts, route-based workspaces, auto-provisioning
- [Widget system](mem://features/widget) — Crisp-style loader, server-validated bootstrap
- [Provider architecture](mem://design/providers) — Full 14-type pluggable registry with resolution, stubs, React context
- [i18n config](mem://features/i18n) — fa/en/tr, RTL support, fallback chains
- [Global Super Admin](mem://features/admin-panel) — /admin/* panel, bootstrap, RequireAdmin guard, 11 pages
