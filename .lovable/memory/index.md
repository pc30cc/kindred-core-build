# Project Memory

## Core
Self-host-first SaaS platform. No Lovable Cloud dependency.
External Supabase: hmsfdmabjmtbshsqafqu.supabase.co
Provider-driven architecture — all business logic via interfaces.
White-label: no hardcoded brand/domain. All branding from admin.
Multilingual: fa (RTL), en (LTR), tr (LTR). Fallback chains.
Service role key: NEVER in frontend.
Primary #3B82F6 (blue), clean professional SaaS design.
Runtime config resolver: all identity from /api/config/resolve.
No Edge Functions without explicit approval.

## Memories
- [Architecture rules](mem://features/architecture) — Self-host, provider-driven, no dual paths, no cloud dependency
- [Runtime Config](mem://features/runtime-config) — Config resolver, locale-aware identity, site mode, domain management
- [Widget system](mem://features/widget) — Crisp-style loader, server-validated bootstrap
- [Provider interfaces](mem://design/providers) — All 11 provider interfaces defined
- [i18n config](mem://features/i18n) — fa/en/tr, RTL support, fallback chains
- [Admin panel](mem://features/admin-panel) — Super admin user/role management via self-hosted backend
