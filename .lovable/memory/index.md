# Project Memory

## Core
Self-hosted backend (Express), no cloud dependency. Provider-based architecture, 14 types.
Supabase for DB/auth. Dark theme. No Edge Functions without approval.
Dashboard removed — do not re-add.

## Memories
- [Workspace architecture](mem://features/workspace-architecture) — Multi-tenant workspace system with accounts, members, roles
- [Admin panel](mem://features/admin-panel) — Global super admin at /admin/*, 12 pages, RequireAdmin guard
- [Provider architecture](mem://design/providers) — 14 provider types, registry, resolution, fallback, React context
- [Architecture rules](mem://features/architecture) — Self-host-first, provider-driven, no dual paths
- [Plan & Feature Gating](mem://features/plan-system) — Dynamic plans, backend enforcement, workspace subscriptions, admin CRUD
- [Widget Platform Settings](mem://features/widget-platform-settings) — Super-admin global widget controls, three-tier policy (platform locks → workspace overrides → defaults)
