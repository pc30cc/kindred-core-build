---
name: Widget Platform Settings
description: Super-admin-only global widget controls — pre-chat field policies, feature locks, deployment defaults
type: feature
---

## Storage
- Table: `widget_platform_settings` (singleton row, RLS: admin manage, all read)
- RPC fallback: `loadPlatformPreChatPolicy()` reads new table first, falls back to `app_runtime_config['widget_prechat_fields']`

## Admin UI
- Route: `/admin/widget-settings` (in AdminSidebar between Providers and System)
- Tabs: Pre-chat fields | Feature locks | Deployment defaults | Limits
- All changes are platform-wide and cannot be overridden by workspace admins when set to `force_*`

## Three-tier policy resolution (server: server/routes/widget.ts)
1. Platform policy (`force_on` / `force_off` / `default_on` / `default_off`) from `widget_platform_settings`
2. Workspace overrides via `feature_flags` keys: `widget_prechat_name`, `widget_prechat_email`, `widget_prechat_phone`
3. `force_*` modes lock the field — workspace cannot override

## Workspace UI
- Deployment tab REMOVED from `/app/.../widget` — managed centrally in admin panel
- Workspace tabs: Appearance | Behavior | Domains | Install
