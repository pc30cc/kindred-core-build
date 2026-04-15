---
name: Dynamic Plan & Feature Gating System
description: Fully dynamic plan management with backend enforcement, workspace subscriptions, and admin CRUD
type: feature
---

## Database
- `billing_plans` — dynamic plans with entitlements (jsonb), limits (jsonb), prices (jsonb per currency)
- `workspace_subscriptions` — links workspace to plan (unique per workspace)
- `check_workspace_entitlement()` — DB function for plan-based feature checking

## Backend (Express)
- `server/middleware/featureGating.ts` — `requireFeature()`, `requireLimit()` middleware + 60s cache
- `server/routes/plans.ts` — Full CRUD for plans, workspace assignment, entitlement checks
- Resolution: workspace subscription → plan → entitlements/limits → fallback to free plan

## Frontend
- `src/hooks/usePlans.ts` — `usePlans()`, `useWorkspacePlan()`, `useFeatureCheck()`, admin CRUD hooks
- `src/pages/admin/PlansPage.tsx` — Full plan management UI with pricing, features, limits, assignments

## Feature Gating Flow
1. Backend middleware checks `check_workspace_entitlement(workspace_id, feature)`
2. If no subscription → falls back to `free` plan
3. If no plans exist → everything allowed (fail-open)
4. Entitlements = boolean toggles, Limits = numeric caps
5. Cache invalidated on plan changes

## Admin Capabilities
- Create/edit/delete plans dynamically
- Set per-currency pricing (USD/EUR/TRY/IRR, monthly/yearly)
- Toggle 12 features per plan
- Set 6 numeric limits per plan
- Assign plans to workspaces manually
- View all subscriptions
