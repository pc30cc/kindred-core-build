---
name: Global Super Admin Panel
description: Separate /admin/* panel for platform owner, distinct from /app/* workspace admin
type: feature
---

## Routes
- `/admin/bootstrap` — one-time admin claim (RequireAuth only, NOT RequireAdmin)
- `/admin` — dashboard
- `/admin/users` — all users, role assignment
- `/admin/workspaces` — all workspaces
- `/admin/providers` — 13 provider types
- `/admin/system` — health, runtime config
- `/admin/feature-flags` — global toggles
- `/admin/branding` — default branding overview
- `/admin/domains` — all workspace domains
- `/admin/audit-logs` — platform-wide audit trail
- `/admin/billing` — billing management
- `/admin/security` — RLS status, security notes

## Access Control
- `RequireAdmin` guard checks `has_role(auth.uid(), 'admin')` via RPC
- DB functions: `admin_list_profiles`, `admin_list_workspaces`, `admin_count_*` (SECURITY DEFINER)
- `bootstrap_admin()` — only works when zero admins exist
- Workspace owners do NOT auto-get global admin

## Layout
- AdminLayout + AdminSidebar — dark slate theme, visually distinct from workspace
- AppSidebar shows "Super Admin" link only when `isAdmin === true`
