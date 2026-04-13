---
name: Provider architecture
description: Full pluggable provider registry with 14 types, resolution, fallback, stubs, and React context
type: design
---

## Provider Registry (`src/providers/registry.ts`)
- Singleton `providerRegistry` with register/unregister/resolve/setActive
- Resolution order: workspace override → global active → priority fallback
- Health check with 30s cache
- `useSyncExternalStore` for React reactivity

## 14 Provider Types
auth, database, realtime, email, ai, storage, search, notification, cache, feature_flag, widget, billing, captcha, cdn

## Interfaces
- Core 11: `src/types/providers.ts`
- Extended 3 (billing, captcha, cdn): `src/types/providers-extended.ts`

## Implementations
- Supabase: auth, database, realtime (priority 0, active by default)
- Stubs: all 14 types (priority 100, fallback)
- In-memory cache (priority 50)

## Bootstrap (`src/providers/bootstrap.ts`)
Called once at app startup. Registers all defaults.

## React Integration (`src/providers/ProviderContext.tsx`)
- `<ProviderContextProvider>` wraps the app
- `useProvider(type, wsId?)` — resolve active provider
- `useProviderSummary()` — get full registry state
- Typed convenience hooks: `useAuthProvider`, `useEmailProvider`, etc.

## Config Storage
- `provider_configs` table (per-workspace, stored in Supabase)
- Admin UI reads live registry + DB configs
- Workspace settings show overrides vs platform defaults
