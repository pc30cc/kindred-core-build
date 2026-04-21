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
- Tabs: Deployment & URLs | Templates | Pre-chat fields | Feature locks | Deployment defaults | Limits
- All changes are platform-wide and cannot be overridden by workspace admins when set to `force_*`

## Three-tier policy resolution (server: server/routes/widget.ts)
1. Platform policy (`force_on` / `force_off` / `default_on` / `default_off`) from `widget_platform_settings`
2. Workspace overrides via `feature_flags` keys: `widget_prechat_name`, `widget_prechat_email`, `widget_prechat_phone`
3. `force_*` modes lock the field — workspace cannot override

## Workspace UI
- Deployment tab REMOVED from `/app/.../widget` — managed centrally in admin panel
- Workspace tabs: Appearance | Behavior | Domains | Install

## Widget Templates registry
- Table: `widget_templates` (slug unique, status, enabled, is_builtin, sort_order, metadata; admin manage / authenticated read)
- Built-in seed: `default` (is_builtin=true, enabled=true) — represents the current production widget. Cannot be disabled (server guard + UI lock).
- Backend service: `server/services/widget/templates.ts` — `listWidgetTemplates`, `getEnabledTemplateSlugs`, `getActiveTemplateSlug(workspaceId?)` (always returns `'default'` for now).
- Admin API (mounted on existing admin router): `GET /api/admin/widget/templates`, `PATCH /api/admin/widget/templates/:id`.
- Admin UI: `WidgetTemplatesSection` rendered in the new "Templates" tab. Shows name/slug/status/enabled with a "Built-in" + "Current" badge for `default`.
- Foundation only — workspace-level template selection NOT implemented yet. Runtime continues to use the default template unchanged. Future workspace selection plugs into `getActiveTemplateSlug` without refactor.
