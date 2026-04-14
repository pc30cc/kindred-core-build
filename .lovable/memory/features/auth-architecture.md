---
name: Self-host auth architecture
description: Backend-mediated auth with DB-backed sessions/tokens, no browser Supabase auth
type: feature
---

## Auth Architecture (Phase 2 — Production-Grade)

- Frontend calls ONLY `/api/auth-email/*` endpoints — never Supabase Auth directly
- `src/providers/supabase/auth.ts` has been **deleted** — no legacy auth provider
- Backend uses Supabase Admin API internally to manage users
- Sessions: DB-backed (`auth_sessions` table), HTTP-only cookies, survives restarts
- Reset tokens: DB-backed (`auth_reset_tokens`), hashed, single-use, 30min TTL
- Verify tokens: DB-backed (`auth_verify_tokens`), hashed, single-use, 24h TTL
- Auth emails (verification, reset): sent via own email service, localized (en/fa/tr)
- No in-memory Maps for auth state — fully persistent, multi-instance safe

## Required Env Vars (Backend)
- `SESSION_SECRET` — required in production
- `APP_URL` — base URL for email links (e.g. https://destekly.tr)
- `APP_NAME` — display name in email templates
- `SYSTEM_FROM_EMAIL` — sender address for auth emails

## Cookie: `gs_session`
- httpOnly, Secure (production), SameSite=Lax, 7-day TTL
- Token is SHA-256 hashed before DB storage
