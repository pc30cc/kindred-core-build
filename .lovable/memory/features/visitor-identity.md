---
name: Visitor Identity & Contact Continuity
description: Self-hosted visitor identification using HttpOnly signed cookies, server-side merge, and contact verification — no localStorage
type: feature
---

## Architecture (production-grade, fail-closed)

**Layer 1 — Anonymous visitor**
- HttpOnly signed cookie `dvsid` (HMAC-SHA256, 365d)
- Cookie attributes auto-detect TLS via NODE_ENV, req.secure, X-Forwarded-Proto, or *.lovable.app host → on HTTPS: `SameSite=None; Secure; Partitioned` (CHIPS for third-party-cookie-blocked Chrome). On plain http://localhost: `SameSite=Lax`.
- Issued in `POST /api/widget/bootstrap` via `resolveVisitorIdentity()` (server/services/widget/visitorIdentity.ts)
- Payload: `{ v: visitor_id, w: workspace_id, iat, exp }` — signature validated on every request
- Auto-rotates when <30 days remain. NEVER stored in localStorage.
- Cookie path: `/api`, parsed by `cookie-parser` middleware in server/index.ts

**Layer 2 — Pre-chat → Contact merge**
- `widget_prechat_settings` table (per workspace): ask/require/verify flags for name/email/phone + `history_continue_window_hours`
- `POST /api/widget/identity/prechat` validates required fields, then calls `mergeVisitorIdentity()`
- Merge logic (server/services/widget/identityMerge.ts):
  1. Find contact by visitor_id (sessions or contact metadata)
  2. Fallback: dedupe by email then phone
  3. Otherwise create new contact
  4. NEVER overwrite existing non-null name/email/phone
  5. SQL function `merge_visitor_into_contact()` atomically links sessions + re-links conversations + writes audit row to `identity_merges`

**Layer 3 — Email/phone verification**
- `contact_verifications` table (token_hash, nonce, expires_at, attempts, used_at)
- Single-use, 10min TTL, max 5 attempts, constant-time hash compare
- Routes: `POST /api/widget/identity/verify/{request,confirm}`
- On confirm → auto-merges identity with method=`email`|`phone`

**Layer 4 — Cross-device continuity**
- `user_continuity_tokens` table (HMAC-SHA256 hashed, 90d TTL, revocable)
- Routes: `POST /api/widget/identity/continuity/{attach,use,revoke}`
- Stored hash uses keyed HMAC so DB leak alone can't precompute matches
- Call widget also issues an HttpOnly signed continuity cookie `dvcid` after first contact merge and restores contact from it on bootstrap if `dvsid` is lost/partitioned. This prevents duplicate contacts after refresh/reopen while keeping IDs out of localStorage.

**Smart history continuation**
- `GET /api/widget/identity/history` reads `dvsid` cookie, finds contact, returns conversation only if updated_at within `history_continue_window_hours` (default 24h)
- Otherwise returns null → widget starts fresh conversation

## Secrets (env)
- `WIDGET_VISITOR_SECRET` — visitor cookie signing
- `WIDGET_VERIFICATION_SECRET` — verification token hashing
- `WIDGET_CONTINUITY_SECRET` — continuity token hashing
- All fall back to `WIDGET_SIGNING_SECRET` then `SUPABASE_SERVICE_ROLE_KEY`

## CORS
- Widget routes set `Access-Control-Allow-Credentials: true` + `Vary: Origin`
- Required so HttpOnly `dvsid` cookie is sent cross-site (widget embedded on customer domain)

## Endpoints summary (all require widget HMAC token + matching origin)
- `GET  /api/widget/identity/me`          — current visitor + linked contact + prechat policy
- `GET  /api/widget/identity/prechat`     — field requirements only
- `POST /api/widget/identity/prechat`     — submit name/email/phone → merge
- `GET  /api/widget/identity/history`     — smart conversation continuation
- `POST /api/widget/identity/verify/request|confirm`
- `POST /api/widget/identity/continuity/attach|use|revoke`
- `POST /api/widget/identity/logout`      — clears `dvsid`

## What NOT to do
- ❌ NEVER store visitor_id / session in localStorage
- ❌ NEVER trust client-supplied visitor_id without cookie validation
- ❌ NEVER overwrite verified contact email/phone on merge
- ❌ NEVER skip HMAC signature validation
