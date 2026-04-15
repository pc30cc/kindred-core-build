---
name: Account & Workspace Architecture
description: Crisp-like account-level billing with route-based workspace switching
type: feature
---
## Architecture
- **Account** = billing unit (owns subscriptions, plans define max workspaces/users)
- **Workspace** = operational unit (chat, widget, domains, settings)
- Account → many Workspaces; User → AccountMember → Account
- Signup auto-provisions account + first workspace via `handle_new_user` trigger → `provision_account_on_signup` RPC

## Routing
- Active workspace is **route-based**: `/app/w/:slug/*`
- `/app` redirects to first workspace via `WorkspaceRedirect`
- `useActiveWorkspace()` reads `:slug` from URL params
- `useWorkspacePath()` builds workspace-scoped paths
- `useCurrentWorkspace()` is deprecated, delegates to `useActiveWorkspace()`

## Workspace Creation
- Always via `create_workspace_atomic` RPC (transactional: workspace + member + branding + widget)
- No separate onboarding page — removed

## Key Files
- `src/hooks/useWorkspace.ts` — workspace hooks
- `src/features/workspace/WorkspaceRedirect.tsx` — /app redirect
- DB functions: `provision_account_on_signup`, `create_workspace_atomic`
