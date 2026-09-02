# Workspace Invitations — Final Production-Ready Redesign v5.1

## 0. v5.1 blocker resolution summary

| # | Blocker | Resolution in v5.1 |
| --- | --- | --- |
| 1 | Legacy `token` default silently creates plaintext tokens | Expand keeps the default only for legacy-runtime compatibility; `create_workspace_invitation_v2` **explicitly inserts `token = NULL` and `invitation_flow_version = 2`** (never omits the column); the fence runs `ALTER COLUMN token DROP DEFAULT`, NULLs every remaining legacy value and asserts zero non-null tokens; contract drops `token`/`max_uses`/`use_count`. §4.1, §7.1, §19, §20 |
| 2 | Incomplete version/legacy-status constraints | `CHECK (invitation_flow_version IN (1,2))` added; version-2 invariants written as an `IS NOT NULL`-guarded conjunction that can never evaluate to NULL; deterministic version-1 status backfill from `revoked_at`/`use_count`/`expires_at`; a version-1-only compatibility trigger keeps status in sync until the fence and is dropped at contract; terminal-state metadata constraints are version-aware so legacy history keeps unknown fields NULL and nothing is fabricated. §4.2, §4.3, §19, §20 |
| 3 | Raw token in query strings / URLs | Invitation links carry the token in a **URL fragment**; `GET /preview?token=` is replaced by `POST /preview` with the token in a JSON body; every OTP/accept endpoint takes the token in the body; login round-trips use a short-lived HttpOnly **invitation-context cookie** holding an opaque server handle (DB row stores only a hash reference), never the raw token in a redirect or localStorage. §5.5, §10, §12, §17, §20 |
| 4 | Vague seat-entitlement authority | Traced: hosted authority is `workspace_subscriptions` → `billing_plans.limits->>'max_agents'` (`supabase/migrations/20260413232401`, `20260415214111`); self-host ships **no billing schema at all**. v5.1 picks the **database-authoritative** option: a new service-role-only `workspace_seat_entitlement_mode` singleton persists the deployment seat mode, written by validated server bootstrap from `SELF_HOST_BILLING_MODE`, read inside the acceptance transaction. Postgres never reads an env var. Missing/unreadable state → `ENTITLEMENT_UNAVAILABLE`; unlimited is only an explicit stored enum. §14 |
| 5 | Offboarding deletion order vs real FK actions | Re-traced FK actions per table; new order captures all needed values into local variables first, snapshots history, revokes matching invitations, deletes explicit non-cascading children, then `workspace_member_details`, then `workspace_members`, letting only verified `ON DELETE CASCADE` children go by cascade; global NULL-workspace rows, other workspaces and `role_permissions` are never touched. §16, §20 |

## 1. Verified repository findings (exact files/migrations)

- **Invitation routes today** — `server/routes/workspaceMembers.ts`: `GET/POST/PATCH/DELETE /invitations` + `POST /accept-invitation`. `GET /invitations` uses `select('*')` → the **plaintext token reaches any workspace member**, and it is not manage-gated. Create sets `max_uses: 0`.
- **Schema today** — `database/migrations/042_workspace_invitations.sql` (verified verbatim): `workspace_invitations` = `id, workspace_id, token text NOT NULL DEFAULT encode(gen_random_bytes(32),'hex') UNIQUE, role, max_uses integer NOT NULL DEFAULT 1, use_count integer NOT NULL DEFAULT 0, expires_at timestamptz NULL, created_by uuid NOT NULL, created_at, invited_email text, revoked_at timestamptz`. RLS enabled with **zero policies**. There is **no `status`, `accepted_at` or `accepted_by` column** — hence the deterministic backfill in §4.3. `get_invitation_info(text)` is anon-executable and reads `auth.uid()` (always NULL under first-party auth); `accept_workspace_invitation_as(text, uuid)` is service_role-only and inserts `workspace_members` at line 230.
- **Grant discipline precedent** — `database/migrations/043_service_role_table_grants.sql`: service_role-only grants plus an in-migration `DO $verify$` block asserting anon/authenticated hold **no** privileges. v5.1 copies this style for every new object.
- **Frontend today** — `src/pages/auth/InvitePage.tsx` calls `supabase.rpc('get_invitation_info')`; no password-setup flow exists. `src/integrations/supabase/client.ts` is a database/realtime transport only (`persistSession:false`) — no browser auth session exists.
- **Seat limit today** — `requireLimit('max_agents', usageFnForLimit('max_agents'))` runs as middleware **outside** the accept transaction → concurrent accepts overshoot.
- **Entitlement authority (re-traced for §14)** — `server/middleware/featureGating.ts:445,490` reads `workspace_subscriptions` joined to `billing_plans(*)`; `max_agents` lives in `billing_plans.limits` (`server/services/billing/capabilityRegistry.ts:15`) and is resolved through `check_workspace_entitlement` / `parseEntitlementResponse` (`server/services/billing/entitlementParse.ts`). `workspace_subscriptions` is created by `supabase/migrations/20260413232401` (`status text CHECK (status IN ('trialing','active','past_due','canceled','unpaid','expired','incomplete','paused'))`, `plan_id → billing_plans(id)`, `workspace_id UNIQUE`) and re-declared by `20260415214111` (`plan_id ... ON DELETE SET NULL`). **Self-host has no `billing_plans`, no `workspace_subscriptions` and no `check_workspace_entitlement`** (noted in `039_account_workspace_provisioning.sql` and `entitlementParse.ts:89`); today the only self-host signal is `ServerConfig.selfHostBillingUnlimited` from `SELF_HOST_BILLING_MODE=unlimited` (`server/config.ts:149`) — an Express env var, unreadable from SQL. `app_runtime_config` (hosted `20260413202349:145`) is **anon-readable** and therefore unsuitable as entitlement authority.
- **Mail relay hole** — invitation HTML is composed in the browser and POSTed to `/api/email/send` from `src/pages/app/settings/TeamDepartmentsPage.tsx:852` and `src/pages/app/TeamPage.tsx:200`; `server/routes/email.ts` only checks membership. Third caller: `src/providers/email/api.ts`. `/send-channel` + `sendChannelEmail()` are separately gated (`docs/EMAIL_SURFACE_SPLIT.md`).
- **All seat-creation paths** — `accept_workspace_invitation_as` (`042:230`), `create_workspace_atomic` (`039:145`; hosted `20260415075435`), hosted-only legacy `accept_workspace_invitation` (`20260415100153:120`, `20260622110429:82`) and `20260415081729:79`. `workspace_members` already has `UNIQUE (workspace_id, user_id)` (`001_core_tables.sql:65`).
- **Canonical email verification** — `public.user_credentials.email_verified_at` (`024_user_credentials.sql:33`), written atomically by `030_atomic_auth_token_redemption.sql:124-127`, backfilled by `029`, reset by `035`. There is no `profiles.email_verified*`.
- **Durable outbox precedent** — `048_plugin_platform_and_channels.sql:128` `channel_jobs` + `claim_channel_jobs(...)` at `:213` (`FOR UPDATE SKIP LOCKED`, `SECURITY DEFINER`, `search_path = public`, service_role-only) and `channel_worker_heartbeats`; `worker/index.ts` dispatches on `WORKER_KIND`.
- **Secrets** — `server/config.ts` defines `CORE_INTERNAL_SECRET`, `CHANNELS_WEBHOOK_SIGNING_KEY`, `PLUGIN_SECRETS_MASTER_KEY`, `AI_RUNTIME_INTERNAL_SECRET` with `assertDistinctSigningKey` guards; `PHONE_VERIFICATION_PEPPER` is OTP-specific. None is a general link-derivation key → v5.1 keeps `INVITATION_LINK_SECRET` with a versioned key ring. Redaction: `shared/security/redactSecrets.ts` via `server/lib/redactSecrets.ts`.
- **Chain divergence (verified)** — `workspace_departments` + `workspace_department_members` (hosted `20260423182832`: `department_id → workspace_departments(id) ON DELETE CASCADE`, `workspace_id → workspaces(id) ON DELETE CASCADE`, plain `user_id uuid NOT NULL` with **no FK**, `UNIQUE (department_id, user_id)`), `user_availability_prefs` (`20260421073114`: `user_id → auth.users ON DELETE CASCADE`, **nullable** `workspace_id → workspaces ON DELETE CASCADE`), `user_notification_prefs` (`20260421071651`), `operator_call_availability` (`20260422221658`) and `call_center_department_agents` (`20260511143550`) exist **only in the hosted chain**. `role_permissions` (`20260422211113:95`) is `(workspace_id, role_slug, permission_key, granted)` — shared role definitions, never user data.

## 2. Final product flow

Owner/admin invites one specific employee. Required for every v5.1 invitation: first name, last name, normalized work email, E.164 work phone, member type, role, department assignments where applicable, expiration. The invitation is single-person, expiring, single-acceptance. The backend atomically creates it and queues email + SMS. The email carries the secure `email_claim` link; the SMS is notification-only with no link; the owner receives a separate `manual_handoff` link exactly once. The email link proves mailbox possession; the manual link requires an email OTP for a new or password-null account. A genuinely new user sees only preview, password, confirmation and explicit legal consent (unchecked by default, submit disabled until checked) — never the public multi-step signup. Existing password-protected users log in through the existing self-hosted login. Successful acceptance creates membership and enters the workspace; a post-commit session failure never rolls back membership and routes to login. Pending invitations reserve no seats; creation is blocked when the workspace is full; expired/revoked invitations are never revived ("invite again" creates a new invitation); staff invitations have exactly zero departments; customer-facing invitations require at least one same-workspace department.

## 3. Authentication and identity boundary

Identity = `profiles` + `user_credentials` + `auth_sessions` + Argon2id + `gs_session`, resolved by Express through `server/lib/workspaceAuth.ts`. No GoTrue, no Supabase Auth identity, no `auth.uid()` for application identity, no edge functions, no browser-authorized service-role RPC, no client-provided identity, authority, entitlement or consent version. Public invitation routes derive authority from a valid scoped invitation token plus rate limits; a present session may change UX but never replaces token validation.

## 4. Final version-aware data model

Migrations: self-host `database/migrations/0NN_*` (numbered from the real latest, currently `075`) and the hosted mirror, each with `DO $verify$` privilege proofs in the `043` style. Every new table: RLS on, zero client policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, minimal service_role grants, no DELETE grant on immutable retention tables.

**Prerequisite (self-host only, minimal):** port `workspace_departments` and `workspace_department_members` verbatim from hosted `20260423182832`, plus only the minimal coherent dependency set. **No** Calls/Availability/Notification tables are ported.

### 4.1 Legacy token column lifecycle (blocker 1)

Because `token` carries `DEFAULT encode(gen_random_bytes(32),'hex')`, making it nullable does **not** stop plaintext generation — omitting the column in an INSERT still fires the default.

**Expand migration**
```sql
ALTER TABLE public.workspace_invitations ALTER COLUMN token DROP NOT NULL;
-- DEFAULT deliberately RETAINED here: the legacy runtime (workspaceMembers.ts,
-- accept_workspace_invitation_as) is still live until the fence and relies on it.
```
**Every secure creation path must write both columns explicitly** — omission is forbidden by code review, by test and by the trigger below:
```sql
INSERT INTO public.workspace_invitations (..., invitation_flow_version, token, ...)
VALUES (..., 2, NULL, ...);
```
A `BEFORE INSERT OR UPDATE` guard trigger enforces it defensively: `IF NEW.invitation_flow_version = 2 AND NEW.token IS NOT NULL THEN RAISE EXCEPTION 'v2 invitation must not carry a plaintext token'`. Only `create_workspace_invitation_v2` may write `invitation_flow_version = 2`; the trigger rejects any other writer (checked via a session-local marker set inside the RPC).

**Fence migration** (step 9 of §19)
```sql
ALTER TABLE public.workspace_invitations ALTER COLUMN token DROP DEFAULT;
-- block version-1 creation and legacy acceptance (guard trigger + RPC fences)
UPDATE public.workspace_invitations SET status = 'revoked', revoked_at = now(), revoked_reason = 'legacy_fence'
  WHERE invitation_flow_version = 1 AND status = 'pending';
UPDATE public.workspace_invitations SET token = NULL WHERE token IS NOT NULL; -- incl. accepted/revoked/expired v1 history
DO $verify$ BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_invitations WHERE token IS NOT NULL)
    THEN RAISE EXCEPTION 'plaintext invitation tokens remain'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
             WHERE d.adrelid='public.workspace_invitations'::regclass AND a.attname='token')
    THEN RAISE EXCEPTION 'legacy token default still present'; END IF;
END $verify$;
```
**Contract migration** (step 12): `ALTER TABLE public.workspace_invitations DROP COLUMN token, DROP COLUMN max_uses, DROP COLUMN use_count;` plus dropping `get_invitation_info`, both legacy accept RPCs and the version-1 compatibility trigger.

### 4.2 workspace_invitations (expanded)

New columns: `invitation_flow_version smallint NOT NULL DEFAULT 1`, `first_name`, `last_name`, `invited_email_normalized`, `invited_phone_e164`, `member_type`, `status`, `accepted_by`, `accepted_at`, `revoked_by`, `revoked_at` (exists), `revoked_reason`, `expired_at`, `archived_at`, `notification_generation int NOT NULL DEFAULT 1`, `job_title`, `staff_code`, `last_email_status`, `last_sms_status`.

Constraints:
```sql
CHECK (invitation_flow_version IN (1, 2))
CHECK (status IN ('pending','accepted','revoked','expired'))
UNIQUE (id, workspace_id)
CREATE UNIQUE INDEX ... ON workspace_invitations (workspace_id, invited_email_normalized) WHERE status = 'pending';
CREATE UNIQUE INDEX ... ON workspace_invitations (workspace_id, invited_phone_e164)      WHERE status = 'pending';
-- no now() in any index predicate

-- version-2 required fields: a conjunction that can never evaluate to NULL,
-- because every leaf is an IS NOT NULL / IS TRUE-shaped test.
CHECK (
  invitation_flow_version <> 2 OR (
        first_name IS NOT NULL AND btrim(first_name) <> ''
    AND last_name  IS NOT NULL AND btrim(last_name)  <> ''
    AND invited_email_normalized IS NOT NULL
    AND invited_email_normalized = lower(btrim(invited_email_normalized))
    AND invited_phone_e164 IS NOT NULL
    AND invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
    AND member_type IS NOT NULL
    AND role IS NOT NULL AND role <> 'owner'
    AND workspace_id IS NOT NULL
    AND created_by   IS NOT NULL
    AND created_at   IS NOT NULL
    AND expires_at   IS NOT NULL AND expires_at > created_at
    AND notification_generation IS NOT NULL AND notification_generation >= 1
    AND token IS NULL
  )
)
-- role / member-type pairing (version-2 only, same shape)
CHECK (invitation_flow_version <> 2 OR (
     (member_type = 'staff'            AND role IN (<staff role set>))
  OR (member_type = 'customer_facing'  AND role IN ('agent','support_agent','sales_agent','team_lead'))
))
-- version-aware terminal-state metadata: strict for v2, tolerant for retained v1 history
CHECK (invitation_flow_version <> 2 OR (
     (status = 'pending'  AND accepted_at IS NULL AND accepted_by IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND revoked_at IS NULL)
  OR (status = 'revoked'  AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL
                          AND revoked_reason IS NOT NULL AND btrim(revoked_reason) <> '')
  OR (status = 'expired'  AND expired_at IS NOT NULL)
))
CHECK (invitation_flow_version <> 1 OR status IN ('pending','accepted','revoked','expired'))
```
Version-1 rows may keep `accepted_by`, `accepted_at`, names, email and phone NULL forever — **no identity, timestamp or contact value is ever fabricated**. `archived_at` is orthogonal to status.

### 4.3 Version-1 status backfill and compatibility window (blocker 2)

Repository tracing shows the legacy table has **no acceptance column**; the only acceptance evidence is `use_count` (incremented by `accept_workspace_invitation_as`, `042:230`). Deterministic backfill, applied in the expand migration and again at the fence:
```sql
UPDATE public.workspace_invitations SET status = CASE
  WHEN revoked_at IS NOT NULL                             THEN 'revoked'
  WHEN use_count > 0                                      THEN 'accepted'
  WHEN expires_at IS NOT NULL AND expires_at <= now()     THEN 'expired'
  ELSE 'pending' END,
  expired_at = CASE WHEN revoked_at IS NULL AND use_count = 0
                     AND expires_at IS NOT NULL AND expires_at <= now() THEN expires_at ELSE expired_at END
WHERE invitation_flow_version = 1;
```
`accepted_at`/`accepted_by` stay NULL for legacy accepted rows (unknown, not invented). `expired_at` uses the row's own `expires_at`, an authoritative stored value, not a synthetic timestamp.

**Compatibility trigger** — `AFTER INSERT OR UPDATE OF use_count, revoked_at, expires_at ON workspace_invitations FOR EACH ROW WHEN (NEW.invitation_flow_version = 1)` re-derives `status`/`expired_at` with the same CASE. It never touches version-2 rows, never sets `invitation_flow_version = 2`, and is dropped in the contract migration. A companion guard trigger forbids any UPDATE that raises `invitation_flow_version` from 1 to 2, so a legacy row can never enter the secure flow.

### 4.4 New tables

**workspace_invitation_tokens** — `id, invitation_id, workspace_id, purpose ('email_claim'|'manual_handoff'), token_hash UNIQUE, token_prefix, token_generation, notification_generation, derivation_key_version (email only), expires_at, consumed_at, revoked_at, created_at`; partial unique `(invitation_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL`.

**workspace_invitation_otps** — `id, invitation_id, workspace_id, email_normalized, manual_token_id, manual_token_generation, notification_generation, purpose, code_digest, attempts, max_attempts, expires_at, consumed_at, revoked_at, ip_hash, created_at`.

**workspace_invitation_proofs** — `id, otp_id, invitation_id, workspace_id, email_normalized, manual_token_id, manual_token_generation, notification_generation, purpose, proof_hash UNIQUE, expires_at, consumed_at, revoked_at, created_at`.

**workspace_invitation_contexts** (new in v5.1, blocker 3) — `id, handle_hash UNIQUE, invitation_id, workspace_id, token_id, token_generation, notification_generation, purpose, expires_at (≤15 min), consumed_at, revoked_at, created_at`. Stores only the hash of the opaque handle and a reference to the token row — never a raw invitation token.

**workspace_invitation_departments** — `(invitation_id, workspace_id, department_id)`, PK `(invitation_id, department_id)`, `FK (invitation_id, workspace_id) → workspace_invitations(id, workspace_id) ON DELETE CASCADE`, `FK (department_id, workspace_id) → workspace_departments(id, workspace_id) ON DELETE RESTRICT` (both parents gain `UNIQUE (id, workspace_id)`).

**workspace_invitation_jobs** — `id, invitation_id, workspace_id, channel, notification_generation, email_token_generation, derivation_key_version, destination_hash, idempotency_key UNIQUE, status ('queued'|'claimed'|'provider_accepted'|'completed'|'retrying'|'permanently_failed'|'cancelled'|'unconfigured'|'derivation_key_unavailable'), attempt_count, max_attempts, available_at, locked_by, locked_at, claim_token uuid, claim_expires_at, last_error, created_at, updated_at`. Payload is secret-free and never contains a raw token.

**workspace_invitation_deliveries (append-only)** — `id, invitation_id, workspace_id, job_id, channel, notification_generation, attempt_number, provider_name, provider_message_id, status, error_code, safe_error_message, created_at, provider_accepted_at, sent_at, delivered_at, failed_at, metadata`. `delivered` only from a signature-verified webhook. No DELETE grant.

**workspace_member_details** — `workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id, joined_at, updated_at`; PK `(workspace_id, user_id)`; `FK (workspace_id, user_id) → workspace_members(workspace_id, user_id) ON DELETE RESTRICT`; `FK invitation_id → workspace_invitations(id) ON DELETE RESTRICT`.

**workspace_member_details_history** — same descriptive columns + `offboarded_at`, `offboarded_by`, `reason`; `workspace_id NOT NULL → workspaces(id) ON DELETE CASCADE`; `user_id NULL → profiles(id) ON DELETE SET NULL`; `invitation_id NULL → workspace_invitations(id) ON DELETE SET NULL`; **no FK to `workspace_members`**. Readable by workspace owner/admin and platform admin through a server route; retained indefinitely unless anonymized by `privacy_jobs`.

**legal_policy_versions** — `id, policy_type, version, locale, content_hash, document_url, published_at, effective_from, is_active`, unique `(policy_type, version, locale)`; trigger rejects edits to `version`/`content_hash`/`published_at` and any delete once referenced.

**workspace_invitation_consents** — `id, user_id, workspace_id, invitation_id UNIQUE, terms_version_id, terms_content_hash, privacy_version_id, privacy_content_hash, accepted_at, ip, user_agent, locale, acceptance_method ('email_claim'|'manual_handoff_otp'|'existing_account')`; FKs `ON DELETE RESTRICT`; no DELETE grant.

**workspace_invitation_idempotency** — `key UNIQUE, scope_kind, operation, workspace_id, invitation_id, result_state, response_digest, created_at, expires_at (24h)`. Never stores raw tokens, proofs, OTPs or passwords.

**workspace_seat_entitlement_mode** (new in v5.1, blocker 4) — singleton `id boolean PRIMARY KEY DEFAULT true CHECK (id)`, `mode text NOT NULL CHECK (mode IN ('plan_authoritative','self_host_unlimited'))`, `source text NOT NULL`, `config_version int NOT NULL`, `updated_by`, `updated_at`. RLS on, zero policies, service_role-only grants — deliberately **not** `app_runtime_config`, which is anon-readable (`20260413202349:151`).

## 5. Token, key-version, generation, OTP, proof and URL-transport model

- **Manual handoff token** — Express-generated, ≥256-bit CSPRNG, base64url. Only `sha256` + prefix + expiry enter the create/rotate RPC. Returned to the authorized manager exactly once; never stored, logged or audited.
- **Email claim token** — derived by the worker on the **first successful preparation** of a logical email job (after exclusive claim), which also persists `derivation_key_version` if absent:
  `raw = base64url(HMAC-SHA-256(K_v, canonical_input))`, `K_v = HKDF(INVITATION_LINK_SECRET[v], info="workspace-invitation-email-token-v1")`, with `canonical_input` a versioned binary encoding, fixed field order, length-prefixed variable fields: `format_version(u8) || purpose(len-prefixed) || invitation_id(16B) || job_id(16B) || notification_generation(u32 BE) || email_token_generation(u32 BE) || derivation_key_version(u16 BE)`. Only `sha256(raw)` + prefix are persisted.
- **Key ring** — every retry reads the job's persisted `derivation_key_version` and uses exactly that key, reproducing the identical link; if the key is unavailable the job fails closed as `derivation_key_unavailable` — never a different link. A key may be retired only when no retryable/in-flight job references it. **Incoming links are always validated by stored token hash**, never by the key ring.
- **Generations** — `notification_generation` is the invitation-level master counter; `email_token_generation` distinguishes resends within a generation. Every token, OTP, proof, context, job and delivery row carries its generation. Resend ⇒ new job + new `email_token_generation`, previous email tokens revoked, manual link untouched. Rotate ⇒ new manual token only. Email/phone change ⇒ full generation bump (§7).
- **OTP** — CSPRNG 6 digits, peppered-HMAC digest only, 10-minute expiry, single use, max 5 attempts, 60 s resend cooldown, capped sends per invitation/window, previous OTP invalidated on resend, uniform responses that never reveal account existence, rate limits by IP + invitation + destination-email hash (+ workspace after the token resolves). Bound to invitation, workspace, normalized email, manual token id, manual token generation, notification generation and purpose.
- **Proof transport** — successful OTP verification stores only a proof hash bound to all those fields plus `otp_id`, consumes the OTP, and returns **no proof material in the JSON body**. The raw proof travels only in a cookie: `HttpOnly; Secure` (production); `SameSite=Strict`; `Path=/api/workspace-invitations/accept-new`; `Max-Age ≤ proof expiry`; no `Domain`. It never appears in JSON, URLs, JS-visible storage, logs, audit, analytics or error tracking. `POST /accept-new` reads the cookie, hashes it, resolves the proof row and validates every binding under strict Origin validation, existing CSRF controls, JSON-only content type, no permissive CORS and rate limits. The cookie is cleared after success, expiry, terminal invalidation, logout or cancel. Obtaining a new proof replaces the cookie; DB proofs stay individually bound.

### 5.5 URL transport (blocker 3)

- Invitation links are `https://<app-host>/invite#token=<raw-token>`. The token is **never** in a query string, path segment, server-rendered page request or redirect URL. Fragments are not transmitted in HTTP requests, so reverse proxies, Nginx/Apache access logs, CDNs, observability pipelines and error pages never see it.
- Frontend bootstrap reads the fragment, calls `history.replaceState` immediately, holds the value only in module-scope memory for the lifetime of the flow, and never writes it to `localStorage`, `sessionStorage`, analytics, error tracking, third-party scripts or any redirect. If the tab reloads mid-flow the user re-opens the link.
- All invitation APIs (`preview`, OTP request/verify, both accepts) receive the token in a JSON request body over HTTPS with strict Origin validation, JSON-only content type, no permissive CORS, layered rate limits, request-body redaction, no body logging and uniform public errors. Any attempt to pass a token as a query parameter or path segment is rejected with the uniform `INVITATION_NOT_FOUND`.
- **Login round-trip** — before redirecting an existing account to login, Express mints an opaque ≥256-bit handle, stores only its hash in `workspace_invitation_contexts` bound to invitation, token id, token generation and notification generation, and sets it as a cookie: `HttpOnly; Secure; SameSite=Lax` (needed to survive the same-origin login navigation); `Path=/`; `Max-Age ≤ 15 min`. The login redirect URL contains **no token and no invitation secret** — at most the non-secret invitation id for UX copy. After login, `POST /accept-existing` resolves the context server-side, revalidates every binding and consumes it. The context is cleared after acceptance, logout, expiry, wrong-account cancellation or a generation bump, and cannot be used for another invitation.
- Lookup is an indexed equality on a stored SHA-256 hash (not claimed constant-time); safety rests on ≥256-bit entropy, hashing, expiry, rate limits and single use. Application-level secret comparisons use `timingSafeEqual`. Provider delivery is at-least-once; v5.1 guarantees idempotent logical content and single-use acceptance, never exactly-once email.

## 6. Canonical lock order

**Global order:** `workspace → invitation → token/OTP/proof/context → invitation job → dependent membership/department rows`. It applies to edit, resend, rotate, revoke, archive, acceptance, expiration and offboarding.

**Resolving from a token or invitation id:** an unlocked indexed lookup obtains candidate invitation/workspace ids only; then lock the workspace, then the invitation, then re-read and revalidate every field. Nothing from the pre-lock lookup is trusted beyond locating lock targets. `edit_workspace_invitation_v2` therefore locks the **workspace first**.

**Job claim transaction** — `claim_invitation_jobs` is a separate short transaction that may lock job rows with `FOR UPDATE SKIP LOCKED` purely to assign `claim_token`/lease. It commits before any worker transaction takes a workspace or invitation lock, and never holds a job-row lock while waiting for a workspace lock.

**Worker processing transaction** — after the claim commits: read candidate ids from the job → lock workspace → lock invitation → lock/re-read the job → verify claim token, lease, generation, destination hash and status → persist token-hash preparation and `derivation_key_version` if needed → **commit before the provider call**. The provider request never happens inside a transaction or under a lock. A short read-only preflight immediately precedes submission (still pending/unexpired, generation match, job not cancelled, lease valid); a request already in flight cannot be recalled, but its token is already revoked and unusable.

**Completion transaction** — recording provider acceptance/failure verifies the matching `claim_token` and job generation, so a worker that lost its lease can never overwrite newer state.

Because every long-lived path acquires locks in the same order, and the only place taking job locks first releases them at commit before requesting any higher-level lock, no cycle can form.

## 7. Atomic RPCs

All are service_role-only, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, fully qualified, no unsafe dynamic SQL, revalidating actor membership and permission from server-resolved ids. No mutation is ever a sequence of independent PostgREST statements.

### 7.1 `create_workspace_invitation_v2`
Caller: Express (owner/admin from `gs_session`). One transaction: lock workspace → validate inviter membership + permission (including the admin-invite rule) → validate role/member-type pairing, normalized email, E.164 phone → lazily expire stale pending rows for the same email/phone → uniqueness check → advisory capacity check (blocked when full, no waitlist) → **insert invitation with an explicit column list containing `invitation_flow_version = 2` and `token = NULL`** → insert departments → insert **only the manual_handoff token hash** → insert one email job and one SMS job → insert `queued` delivery rows → insert audit. No email token is created here. Returns the safe invitation only; the raw manual link is returned by the route once.

### 7.2 Management RPCs
**`edit_workspace_invitation_v2`** — lock workspace → lock invitation → lazily expire → require `pending` and `invitation_flow_version = 2` → revalidate caller permission **against the resulting state** (an admin can neither set nor manage `admin`) → replace departments atomically → on email/phone change: cancel unclaimed jobs of the previous generation, revoke prior email tokens, OTPs, proofs and contexts, increment `notification_generation`, update normalized fields, insert new jobs and `queued` deliveries → preserve historical delivery attempts → audit.

**`resend_invitation_email_v2` / `rotate_manual_link_v2` / `revoke_invitation_v2` / `archive_invitation_v2` / `expire_invitations_v2`** — same lock order, same permission revalidation, same audit discipline; resend bumps `email_token_generation` and revokes previous email tokens; rotate replaces only the manual token and revokes its OTPs/proofs/contexts. None of them may operate on `invitation_flow_version = 1` after the fence.

## 8. Acceptance state machine

**`accept_invitation_new_user_v2`** — allowed only when no profile exists, or a profile whose `user_credentials.password_hash IS NULL`. Requires: current valid invitation token; current OTP proof when the manual link is used; explicit invitation consent; pending unexpired version-2 invitation; available seat; Argon2id hash produced by Express. Transaction (canonical lock order): lock workspace → lock invitation → lock/validate token and proof (generations current, unconsumed, unrevoked, unexpired) → resolve authoritative seat entitlement (§14) → count seats → enforce → confirm no active password-protected account (else `ACCOUNT_EXISTS_LOGIN_REQUIRED`, mutating nothing) → create or reuse the allowed profile → insert/update `user_credentials` with the hash → set `user_credentials.email_verified_at = now()` and record verification source (`workspace_invitation_email_claim` / `workspace_invitation_manual_otp`) → create membership → create member details → assign departments → insert consent → accept invitation (`status='accepted'`, `accepted_by`, `accepted_at`) → consume the used token/proof/context → revoke siblings. Plaintext passwords never leave Express.

**`accept_invitation_existing_user_v2`** — requires **both** a valid `gs_session` and a valid current invitation token (`email_claim` or `manual_handoff`, supplied in the request body or resolved from the invitation-context cookie) belonging to that invitation/workspace with a current generation, a pending unexpired version-2 invitation, session email equal to the invited normalized email, an active account, explicit invitation-specific consent and an available seat. A successful authenticated login on the invited address is sufficient mailbox proof, so **no OTP is required for the manual link in this path** — the manual token is still required and consumed. Acceptance by invitation id + session alone is impossible. The raw token exists only in the HTTPS body, is redacted by logging/error middleware, and never reaches logs or audit; Express passes only resolved ids and hashes to the RPC, which revalidates every relationship.

Disabled/suspended/locked accounts fail closed in both paths. Seat exhaustion returns `SEAT_LIMIT_REACHED` **without consuming token, proof, context or consent**.

**Session after commit** — `gs_session` is created only after the acceptance transaction commits. Failure returns `SESSION_CREATE_FAILED_LOGIN_REQUIRED`; membership stays valid, acceptance is not duplicated.

## 9. Durable outbox and crash recovery

`workspace_invitation_jobs` + `claim_invitation_jobs(_worker_id,_limit,_lease_seconds,_channels)` mirroring `claim_channel_jobs` (`FOR UPDATE SKIP LOCKED`, `claim_token` nonce, `claim_expires_at` lease, service_role-only execute), heartbeats via the `channel_worker_heartbeats` pattern. States: `queued → claimed → provider_accepted → completed`, plus `retrying`, `permanently_failed`, `cancelled`, `unconfigured`, `derivation_key_unavailable`. Exponential backoff, `max_attempts` then dead-letter. Lease expiry returns the job to `queued`; every write asserts the matching claim token. Provider timeouts count as possibly-accepted — duplicate submission is harmless because the deterministic token makes the retry link identical. Webhooks are signature-verified before writing `delivered` or provider failure, correlated by `provider_message_id`. Graceful shutdown releases claims. Exactly one execution mode processes jobs: `WORKER_KIND=invitations` or the single-container in-process fallback, chosen by a server setting whose startup validation rejects both as primary; the claim mechanism stays safe even if both run. Provider acceptance is never labelled delivered; stub/unconfigured is never success; email/SMS failure never deletes or revokes the invitation.

## 10. Canonical API, error codes and idempotency

`server/routes/workspaceInvitations.ts`. **No route accepts an invitation token, proof or OTP in a query string or path parameter.**

| Route | Caller & identity | Token transport | Transaction & lock | Idempotency scope | Returns |
| --- | --- | --- | --- | --- | --- |
| `POST /` | owner/admin, `gs_session` | – | create RPC, ws→inv | `actor|workspace|create|req` | safe invitation + manual link **once** |
| `GET /?workspaceId=` | owner/admin | – | read | – | safe list (prefix only) |
| `GET /:id` | owner/admin | – | read | – | safe detail + delivery history |
| `PATCH /:id` | owner/admin (resulting state) | – | edit RPC, ws→inv | `actor|ws|inv|edit|req` | safe invitation |
| `POST /:id/resend` | owner/admin | – | resend RPC, ws→inv | `actor|ws|inv|resend|req` | new generation info |
| `POST /:id/rotate-link` | owner/admin | – | rotate RPC, ws→inv | `actor|ws|inv|rotate|req` | new manual link **once** |
| `POST /:id/revoke`, `POST /:id/archive` | owner/admin | – | RPC, ws→inv | `actor|ws|inv|op|req` | ok |
| `POST /preview` | token possession + IP/global limits | JSON body | read | – | masked preview |
| `POST /login-context` | token possession | JSON body | insert context, ws→inv→token | `resolved_inv|resolved_token|context|req` | sets HttpOnly context cookie; no token in body/URL |
| `POST /otp/request`, `POST /otp/verify` | token possession + layered limits | JSON body | OTP RPCs, ws→inv | `resolved_inv|resolved_token|op|req` (+ generations) | generic status; verify sets the proof cookie |
| `POST /accept-new` | token (body) + proof cookie | JSON body | accept RPC, ws→inv→token/proof→membership | `resolved_inv|resolved_token|accept_new|req` | session or stable state |
| `POST /accept-existing` | `gs_session` **and** token (body or context cookie) | JSON body / cookie | accept RPC, same order | `session_user|resolved_inv|resolved_token|accept_existing|req` | session state |

Error codes: `INVITATION_NOT_FOUND` (uniform for invalid/expired/revoked/consumed/unknown/wrong-transport on public endpoints), `INVITATION_DUPLICATE` (409), `INVITATION_NOT_PENDING`, `ACCOUNT_EXISTS_LOGIN_REQUIRED`, `ACCOUNT_DISABLED`, `EMAIL_PROOF_REQUIRED`, `OTP_INVALID`, `OTP_RATE_LIMITED`, `CONSENT_REQUIRED`, `SEAT_LIMIT_REACHED`, `ENTITLEMENT_UNAVAILABLE` (503), `SESSION_CREATE_FAILED_LOGIN_REQUIRED`, `FORBIDDEN_ROLE_ESCALATION`, `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE`, `DERIVATION_KEY_UNAVAILABLE`.

**Idempotency rules.** Keys are server-derived; raw token values never enter a key (only server-resolved ids). Actor id comes only from `gs_session`, so public routes use resolved invitation/token ids. The create key omits `invitation_id`; its transaction guarantees one row per request id. Replaying a key returns the same logical result; a new client request id is a new operation. Because raw manual tokens are deliberately not stored, a committed create/rotate whose response was lost returns `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE` with the safe invitation id/state only. Recovery: for a lost create, email/SMS jobs remain queued exactly once and the owner obtains a new manual link via rotate with a **new** request id; for a lost rotate, another rotation with a new request id. Records hold no raw token/proof/OTP/password, expire after 24 h, and post-expiry replay is still constrained by invitation uniqueness and state checks.

## 11. Permission matrix

| Action | Owner | Admin | Other members | Platform super admin |
| --- | --- | --- | --- | --- |
| Invite non-admin roles | ✔ | ✔ | ✖ | ✔ |
| Invite admin | ✔ | ✖ | ✖ | ✔ |
| Invite owner | ✖ | ✖ | ✖ | ✖ |
| Change a pending invite to admin | ✔ | ✖ | ✖ | ✔ |
| Edit/resend/rotate/revoke/archive a non-admin invite | ✔ | ✔ | ✖ | ✔ |
| Manage an admin invitation | ✔ | ✖ | ✖ | ✔ |
| Remove non-admin member | ✔ | ✔ | ✖ | ✔ |
| Remove/demote admin | ✔ | ✖ | ✖ | ✔ |
| Remove/demote canonical owner | ✖ | ✖ | ✖ | ✖ |

Enforced twice — in Express from `gs_session`, and again in each RPC from the server-resolved actor against real membership, always against the resulting state.

## 12. Frontend states

`InvitePage.tsx` rewritten against Express (no `supabase.rpc`/`supabase.from`): read token from the URL fragment → `history.replaceState` → `POST /preview` → masked preview → (manual link + new/password-null account) OTP step → password + confirm + **unchecked consent** with links to the effective terms/privacy → accept → workspace. States: loading, invalid/expired/revoked (uniform copy), otp_required, otp_locked, ready, accepting, seat_limit_reached, account_exists_login_required, wrong_account, session_failed_login_required, accepted. Existing accounts call `POST /login-context` and are redirected to login with a **token-free** URL; on return they always see the unchecked invitation consent checkbox before final acceptance. Token hygiene: `Referrer-Policy: no-referrer`, fragment cleared immediately, no analytics/error-tracking capture, no raw token in toasts, errors, redirects or storage.

Management UI (create dialog with all required fields, pending/archived filters, per-attempt delivery history, expiry, edit/resend/rotate/revoke/archive, verified clipboard feedback, seat-limit messaging, lost-link recovery copy, "invite again" prefill) lands in `StaffAccessPage.tsx` (staff) and `TeamDepartmentsPage.tsx` (customer-facing); hidden for non-managers with the backend as final authority. `TeamPage.tsx` keeps only its redirect. fa/en/tr strings, RTL support.

## 13. Consent and legal model

Immutable `legal_policy_versions`; the backend/database selects the authoritative effective versions. **Every** acceptance — new account, password-null account and existing authenticated account alike — shows an explicit unchecked checkbox, disables submit until checked, and records exactly one invitation-specific consent row containing user, workspace, invitation, terms version + content hash, privacy version + content hash, locale, server timestamp, trusted client IP (`server/utils/clientIp.ts` proxy rules), user agent and acceptance method. Login or prior global consent never substitutes. Referenced versions/hashes can never be edited or deleted. Marketing consent stays separate.

## 14. Seat concurrency and authoritative entitlement (blocker 4)

**Chosen model: database-authoritative.** PostgreSQL never reads an environment variable.

**Authority per deployment mode**

| Mode | Authority read inside the acceptance transaction | Evidence |
| --- | --- | --- |
| `plan_authoritative` (hosted, and any self-host that installed the billing schema) | `public.workspace_subscriptions` (row for the locked workspace) → `plan_id` → `public.billing_plans.limits->>'max_agents'` | `supabase/migrations/20260413232401` (create, `status CHECK (...)`, `workspace_id UNIQUE`), `20260415214111` (`plan_id ... ON DELETE SET NULL`), `server/middleware/featureGating.ts:445,490`, `capabilityRegistry.ts:15` |
| `self_host_unlimited` | `public.workspace_seat_entitlement_mode.mode = 'self_host_unlimited'` — an explicit stored enum | new table, §4.4; written by validated server bootstrap from `SELF_HOST_BILLING_MODE` (`server/config.ts:149`) |

**Resolution algorithm inside the transaction, after `SELECT ... FROM public.workspaces WHERE id = _workspace_id FOR UPDATE`:**
1. Read the singleton `workspace_seat_entitlement_mode`. Missing row, unknown mode or read failure → raise → `503 ENTITLEMENT_UNAVAILABLE`.
2. `self_host_unlimited` → seat limit is unlimited; record `entitlement_source = 'self_host_unlimited'` and `config_version` in the audit row.
3. `plan_authoritative` → read the workspace's subscription row. No row, `plan_id IS NULL`, missing plan, `limits->>'max_agents'` absent or non-numeric → raise → `ENTITLEMENT_UNAVAILABLE`. **Missing state is never unlimited**; only `-1` (the registry's explicit unlimited sentinel) means unlimited.
4. Subscription `status` in (`canceled`,`unpaid`,`expired`,`incomplete`,`paused`) → treated as no seat headroom for *new* members: `SEAT_LIMIT_REACHED` with reason `subscription_inactive` (existing members are untouched). `trialing`, `active` and `past_due` resolve normally.
5. Count current `workspace_members` for the workspace **inside the same transaction** and compare before inserting.
6. Audit records `entitlement_source`, `config_version`/`plan_id` and the resolved limit — no secrets.

**Bootstrap synchronization** — on startup the self-host server validates its configuration and upserts the mode row through a service-role-only RPC (`set_workspace_seat_entitlement_mode`) whenever the configured mode differs, bumping `config_version`. Only trusted server/platform administration may call it; the browser cannot. Invitation features stay disabled until the row exists and matches the validated configuration. Documented in `docs/DEPLOYMENT.md`, `SELF_HOST_GUIDE.md`, `database/README.md`.

**Every runtime seat insertion locks `public.workspaces` first** — both acceptance RPCs (new), `create_workspace_atomic` (documented bootstrap: a brand-new workspace with exactly its owner; gains the lock for uniformity), legacy accept RPCs (fenced then dropped). A CI guard scans both chains for `INSERT INTO ... workspace_members` and fails any statement not inside a function containing the workspace lock. Pending invitations reserve nothing; creation is blocked when full; a later shortage yields a retryable `SEAT_LIMIT_REACHED` that consumes nothing.

## 15. Expiration and archival

An idempotent janitor (same worker) flips due `pending` rows to `expired` (setting `expired_at`), revokes their tokens/OTPs/proofs/contexts and cancels queued jobs, with an audit event; lazy expiry also runs before every uniqueness check, list, preview, resend, rotate and accept. Expired/revoked invitations never return to pending — "invite again" creates a new row with a new id, tokens, consent lifecycle and audit trail. Pending invitations are revoked, not deleted; revoked/expired may be archived (hidden by default, visible under an archived filter, tokens permanently unusable); accepted may only be archived. Invitations, consents, deliveries, member history and audit are never hard-deleted by ordinary management; permanent purge exists only inside `privacy_jobs`.

## 16. Offboarding, FK-accurate order and chain-specific retention (blocker 5)

**Traced FK reality**

| Table | Parent FK | ON DELETE | Explicit delete required? | Predicate | Scope |
| --- | --- | --- | --- | --- | --- |
| `workspace_member_details` | `(workspace_id,user_id) → workspace_members` | **RESTRICT** | **Yes — before `workspace_members`** | `workspace_id = _ws AND user_id = _user` | workspace |
| `workspace_member_details` | `invitation_id → workspace_invitations` | RESTRICT | – (parent invitation retained) | – | workspace |
| `workspace_department_members` (hosted; ported to self-host) | `department_id → workspace_departments` CASCADE, `workspace_id → workspaces` CASCADE, `user_id` **no FK** | no cascade from `workspace_members` | **Yes — explicit** | `workspace_id = _ws AND user_id = _user` | workspace |
| `call_center_department_agents` (hosted only) | department/workspace FKs; no FK to `workspace_members` | – | **Yes — explicit** (hosted body only) | `workspace_id = _ws AND user_id = _user` | workspace |
| `operator_call_availability` (hosted only) | workspace-scoped | – | **Yes — explicit** (hosted only) | `workspace_id = _ws AND user_id = _user` | workspace |
| `user_availability_prefs` (hosted only) | `user_id → auth.users` CASCADE, **nullable** `workspace_id → workspaces` CASCADE | not tied to membership | **Yes, but only** `workspace_id = _ws` | `user_id = _user AND workspace_id = _ws` | mixed — global NULL row must survive |
| `user_notification_prefs` (hosted only) | workspace-scoped | – | **Yes — explicit** (hosted only) | `workspace_id = _ws AND user_id = _user` | workspace |
| `workspace_invitation_*` (tokens/OTPs/proofs/contexts/jobs) | `invitation_id → workspace_invitations` CASCADE | cascade from invitation only | revoke/cancel, never delete | matching pending invitation | workspace |
| `role_permissions` | `(workspace_id, role_slug, permission_key)` | – | **Never touched** | – | shared definitions |
| `profiles`, `user_credentials` | global identity | – | **Never touched** | – | global |

**`offboard_workspace_member(...)`** — service_role only, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, identical public contract on both chains with **deliberately chain-specific bodies** documented in `database/README.md`; no `to_regclass` guessing, no unsafe dynamic SQL. One transaction:
1. Lock `public.workspaces` row.
2. Resolve and lock the target `workspace_members` row (`FOR UPDATE`).
3. Protect the canonical `workspaces.owner_id`.
4. **Capture into local variables before any delete**: user id, workspace id, normalized work email, work phone, role, member type, invitation id, joined_at and every other value needed by cleanup and audit (read from `workspace_member_details` while it still exists).
5. Insert the immutable `workspace_member_details_history` snapshot.
6. Revoke matching pending invitations (found by the captured email/phone) and cancel their tokens, OTPs, proofs, contexts and jobs.
7. Delete explicit non-cascading children (per the table above, chain-specific), using only `workspace_id = _ws AND user_id = _user`.
8. Delete `workspace_member_details` (RESTRICT child of membership).
9. Delete `workspace_members`.
10. Allow only verified `ON DELETE CASCADE` children to disappear by cascade.
11. Verify no workspace-scoped authorization row for that user remains.
12. Insert the audit event from the captured local values.

Any failure rolls the whole transaction back. Global NULL-workspace preferences, other workspaces' rows, shared `role_permissions`, accepted invitations, consents, deliveries, history and audit all survive. Removed members lose authorization immediately through the existing server-side membership checks.

## 17. RLS, grants, SECURITY DEFINER and secret handling

Every new table: RLS on, zero client policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, minimal service_role grants, no DELETE on consents/deliveries/history/audit. Every new function: service_role execute only, `SET search_path = public, pg_temp`, fully qualified references, no unsafe dynamic SQL, internal tenant/role validation, and an in-migration `DO $verify$` privilege assertion mirroring `043`.

Never stored or logged: raw manual token, raw email token, OTP code, raw proof, raw invitation-context handle, plaintext password, service-role key, `INVITATION_LINK_SECRET`, `PHONE_VERIFICATION_PEPPER`, any email/SMS body containing an invitation URL, full provider error bodies. Precise transport exceptions: the manual token appears only in the single authorized create/rotate response; the email token only in the server-rendered email link fragment and the incoming JSON body; the OTP only in the OTP email and the user's submission; the proof and context handles only in HttpOnly cookies; the password only in the HTTPS request to Express before Argon2id hashing. All logging/error middleware redacts invitation token, OTP, proof/context cookies and password fields via `shared/security/redactSecrets.ts`. Because tokens ride in fragments and bodies, no reverse proxy, CDN or access log ever receives one.

## 18. Legacy API and mail-relay closure

Legacy invitation HTTP routes return `410 Gone` after cutover and are deleted at contract; legacy DB invitation RPCs are fenced then removed. Browser invitation-email callers are removed. `/api/email/send` loses arbitrary `to`/`subject`/`html` and is replaced by `POST /api/email/test-send`: owner/admin only, fixed server-rendered template, recipient restricted to a verified workspace address. `/send-channel` and `sendChannelEmail()` unchanged. Ordinary members can no longer relay mail.

## 19. Migration, cutover and recovery

1. Trace both chains (done, §1). *Abort if* the hosted department definitions cannot be ported cleanly.
2. Port only `workspace_departments`, `workspace_department_members` (+ minimal dependencies) to self-host. *Verify:* both chains apply; department APIs work on self-host.
3. Expand `workspace_invitations`: add all new columns, `CHECK (invitation_flow_version IN (1,2))`, version-aware constraints, drop `NOT NULL` on `token` (**keep the default for now**), install the v2 no-plaintext guard trigger, the version-1 compatibility trigger and the version-escalation guard, run the deterministic status backfill (§4.3), and add all new tables including `workspace_seat_entitlement_mode`. *Verify:* legacy runtime still works; in-migration proofs pass.
4. Add RPCs, worker job tables, grants and privilege assertions. *Verify:* anon/authenticated denied on every new object.
5. Deploy backend with `INVITATIONS_V5` disabled; bootstrap validates and upserts the seat-entitlement mode row. *Verify:* health, mode row correct, legacy flow green. *Abort:* redeploy previous image.
6. Deploy the compatible frontend. *Verify:* no regressions.
7. Configure and verify the invitation worker and the `INVITATION_LINK_SECRET` key ring (startup strength + distinctness checks, current/previous versions). *Verify:* claim, backoff, heartbeat.
8. Enable v5.1. *Verify* end-to-end: create (asserting `token IS NULL`) → email → SMS → manual OTP → new accept → login-context → existing accept → offboard.
9. **Fence migration** (§4.1): block version-1 creation and legacy acceptance, `ALTER COLUMN token DROP DEFAULT`, final version-1 status synchronization, revoke all remaining version-1 pending rows, `UPDATE ... SET token = NULL` for every remaining row, run the `DO $verify$` assertions. *Verify:* no non-null token, no default, legacy writes rejected.
10. Return `410 Gone` from legacy HTTP routes. *Verify:* version-1 history still readable with NULL tokens and NULL legacy metadata.
11. Monitor delivery failures, stuck jobs, seat/OTP/entitlement errors.
12. Contract migration later: drop `token`, `max_uses`, `use_count`, the version-1 compatibility trigger, `get_invitation_info` and both legacy accept RPCs.

After the fence, rollback to an insecure build is not supported — only a compatible fenced build or forward-fix; with the default dropped, even an old build cannot recreate a plaintext-token invitation (its INSERT would violate `token`'s absence of default plus the v1-creation fence). Not universally zero-downtime: steps 9–10 may briefly make invitation management unavailable. Documented in `docs/DEPLOYMENT.md`, `database/README.md`, `SELF_HOST_GUIDE.md`.

## 20. Exact test plan (real PostgreSQL for constraints, privileges, transactions, locks, concurrency)

**Legacy token default (blocker 1):** a version-2 creation always stores `token IS NULL`; omitting the column in any secure path is caught by the guard trigger; before the fence the legacy runtime still creates and accepts version-1 invitations as documented; after the fence `pg_attrdef` holds no default for `token`; after the fence every row has `token IS NULL`, including accepted/revoked/expired history; a compatible rollback build cannot create a plaintext-token invitation.
**Version/status constraints (blocker 2):** `invitation_flow_version` of 0, 3 or NULL rejected; each version-2 required field individually rejected when NULL or blank; a SQL NULL cannot bypass a version-2 CHECK; role/member-type mismatch rejected; version-2 terminal states require complete metadata; version-1 accepted history with NULL `accepted_by`/`accepted_at`/names remains insertable and readable; backfill maps revoked/use_count/expired/pending exactly; the compatibility trigger re-syncs version-1 status on `use_count`, `revoked_at` and `expires_at` changes and never touches version-2 rows; escalation from version 1 to 2 rejected; no synthetic identity or timestamp is written anywhere; after the fence no version-1 row can be accepted.
**URL/transport (blocker 3):** the generated invitation URL carries the token only in the fragment; the initial `GET /invite` request line and headers contain no token (proxy/access-log fixture asserted); `GET /preview` with a query token is rejected; preview/OTP/accept accept the token only in a JSON body with valid Origin; the login redirect URL contains no token or secret; the invitation-context cookie is HttpOnly/SameSite/short-lived, cannot cross invitations or generations, and is cleared on acceptance/logout/expiry/wrong-account; `history.replaceState` clears the fragment on first render; no analytics/error-tracking payload contains the token; nothing writes the token to localStorage.
**Entitlement (blocker 4):** finite plan limit enforced; `self_host_unlimited` mode allows beyond any finite count; missing mode row → `ENTITLEMENT_UNAVAILABLE`; missing subscription/plan/limit → `ENTITLEMENT_UNAVAILABLE`, never unlimited; `canceled`/`expired`/`paused` subscription → `SEAT_LIMIT_REACHED (subscription_inactive)`; `trialing`/`past_due` resolve normally; a browser-supplied limit is ignored/rejected; two concurrent accepts at the final seat produce exactly one membership; an entitlement change mid-acceptance is observed under the workspace lock; audit records the entitlement source and version.
**Offboarding FK order (blocker 5), per chain:** offboarding succeeds with every child-row type present; deleting `workspace_members` before `workspace_member_details` fails (proving RESTRICT ordering matters) while the implemented order succeeds; CASCADE children behave as documented; the global NULL-workspace `user_availability_prefs` row survives; another workspace's rows survive; `role_permissions` untouched; pending matching invitations are revoked using the captured email/phone after details were snapshotted; accepted history remains; a forced failure in any cleanup step rolls everything back; the self-host body references only tables present in its chain.
**Locking/concurrency:** edit locks workspace before invitation; the claim transaction never seeks a workspace lock while holding a job lock; deadlock stress across edit/resend/revoke/accept/worker; edit vs claim; edit vs worker preflight; revoke vs retry; accept vs expiration; lease expiry while the original worker is alive.
**Key version:** version persisted on first preparation; retries reuse it before and after rotation; missing previous key → `derivation_key_unavailable`; identical inputs → identical token; any change → different token; canonical binary encoding has no ambiguous collisions; incoming links keep validating by stored hash after rotation.
**Token ownership/timing:** create inserts a manual hash and no email token; the worker creates the email token only after claiming; no raw deterministic token is ever persisted; resend bumps generation and revokes the previous email generation; rotate touches only the manual token.
**Crash recovery:** provider accepts → worker crashes → retry sends the same valid link; duplicate submission cannot duplicate membership.
**Proof transport:** verify sets the HttpOnly cookie; proof absent from JSON and JS-visible storage; Origin/CSRF rejection; cookie cleared after use; proof cannot cross invitations, emails, generations or flows; replay fails; seat failure consumes no proof.
**Existing-account acceptance:** session without token rejected; token without session rejected; wrong-session email rejected; foreign-invitation token rejected; rotated/expired/consumed token rejected; correct manual token + matching login accepted without OTP; accepted-token replay rejected.
**Departments:** customer-facing with zero departments fails at commit; staff with any department fails; cross-workspace department rejected; atomic replacement never commits an invalid state.
**Idempotency:** create retry creates one invitation; lost create/rotate → `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE`; public operations work without an actor id; keys cannot collide across workspace/invitation/token; acceptance retry duplicates no membership, consent or audit.
**Consent:** every acceptance shows an unchecked checkbox; existing users cannot skip invitation consent; consent inserted exactly once; referenced legal versions immutable.
**Security:** no raw token/OTP/proof/context/password in rows, logs, audits, analytics or ordinary responses; anon/authenticated cannot read any new table or execute any new RPC; preview leaks only masked PII; an existing password account cannot accept via `accept-new`; session-creation failure yields login recovery without duplicate membership; no GoTrue/Supabase Auth/`auth.uid()`/edge-function dependency introduced; widget runtime and build byte-unchanged.

## 21. Out of scope

Embedded chat widget runtime and build; AI, Calls, Channels, Inbox, Billing beyond the entitlement read; porting hosted-only Calls/Availability/Notification tables to self-host; ownership transfer; SSO/social login; marketing-consent management; new SaaS dependencies or edge functions. One new secret (`INVITATION_LINK_SECRET`) is introduced deliberately and justified in §1/§5.

## 22. Remaining assumptions

- The hosted `workspace_departments`/`workspace_department_members` definitions (`20260423182832`) port cleanly into self-host with a minimal dependency set; re-verified column-by-column when the migration is written.
- Localized terms/privacy documents exist to seed the first `legal_policy_versions` rows (content hashes computed at migration time).
- Hosted-chain offboarding tables beyond those listed in §16 do not exist; the FK table is re-asserted by the per-chain integration tests before the migration ships.

## 23. Final contradiction sweep and readiness verdict

- **`token = NULL` vs legacy default** — the default survives only until the fence and is never relied upon: every secure insert names `token` explicitly with NULL and a trigger rejects a non-null token on a version-2 row (§4.1, §7.1).
- **Legacy compatibility vs dropping the default** — compatibility window ends exactly at step 9, where the default is dropped, version-1 creation/acceptance is fenced and all plaintext values are NULLed; contract then drops the columns (§19).
- **Flow-version values** — constrained to `IN (1,2)` on a `NOT NULL smallint`, with escalation 1→2 blocked (§4.2, §4.3).
- **Strict version-2 checks vs nullable version-1 history** — every strict predicate is prefixed by `invitation_flow_version <> 2 OR (...)` and built from `IS NOT NULL` leaves, so version-1 history stays valid with unknown fields NULL and no CHECK can evaluate to NULL (§4.2).
- **Legacy status backfill** — deterministic from `revoked_at`, `use_count`, `expires_at` (the only signals the traced schema provides), applied at expand, kept in sync by a version-1-only trigger, and finalized at the fence (§4.3, §19).
- **Fragment vs API body transport** — the token exists in the URL only as a fragment (never sent to the server) and in JSON bodies only (never in query strings or paths); both statements coexist without conflict (§5.5, §10).
- **Login redirect** — carries no token; continuity uses an HttpOnly context cookie holding an opaque handle whose DB row stores only a hash reference (§5.5, §4.4).
- **Entitlement authority** — PostgreSQL reads `workspace_subscriptions`/`billing_plans` or the stored `workspace_seat_entitlement_mode` row; it never reads an environment variable, and env configuration reaches the database only through a validated, service-role-only bootstrap upsert (§14).
- **Child vs parent deletion** — all values are captured before deletes, history is snapshotted first, RESTRICT children (`workspace_member_details`) and explicit non-cascading assignment rows are deleted before `workspace_members`, and only verified CASCADE children go by cascade (§16).
- **Hosted vs self-host table availability** — the §16 matrix marks each table's chain; self-host bodies reference only tables present in that chain, and no Calls/Availability/Notification tables are ported (§4, §16).

Authentication stays fully self-hosted — `profiles`, `user_credentials`, `auth_sessions`, Argon2id, `gs_session`, `authorizeWorkspaceAccess` — with no GoTrue, no Supabase Auth identity, no `auth.uid()`, no edge functions, no browser-reachable privileged RPC and no arbitrary mail relay; the embedded widget is untouched. All five v5.1 blockers are resolved, and no raw invitation token can be created, stored, logged or leaked by the v5.1 path. **Safe to implement** upon approval.
