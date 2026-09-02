# Workspace Invitations — Final Production-Ready Redesign v5

## 1. Verified repository findings (exact files/migrations)

- **Invitation routes today** — `server/routes/workspaceMembers.ts`: `GET/POST/PATCH/DELETE /invitations` + `POST /accept-invitation`. `GET /invitations` uses `select('*')` → the **plaintext token reaches any workspace member**, and it is not manage-gated. Create sets `max_uses: 0` (unlimited use) and accepts only role/email/expiry.
- **Schema today** — `database/migrations/042_workspace_invitations.sql`: `workspace_invitations` has `token text NOT NULL DEFAULT encode(gen_random_bytes(32),'hex') UNIQUE` (**NOT NULL — must be made nullable during expand**), `max_uses`, `use_count`, nullable `expires_at`; no names/phone/status/departments/consent. Defines `get_invitation_info(text)` (anon-executable, reads `auth.uid()` → always NULL under first-party auth) and `accept_workspace_invitation_as(text, uuid)` (service_role only; inserts `workspace_members` at line 230).
- **Grant discipline precedent** — `database/migrations/043_service_role_table_grants.sql`: service_role-only grants plus an in-migration `DO $verify$` block asserting anon/authenticated have **no** privileges. v5 copies this exact style for every new object.
- **Frontend today** — `src/pages/auth/InvitePage.tsx` calls `supabase.rpc('get_invitation_info')`; no password-setup flow exists, so an invitee must already have an account. `src/integrations/supabase/client.ts` is explicitly a database/realtime transport only (`persistSession:false`) — no browser auth session exists.
- **Seat limit today** — `requireLimit('max_agents', usageFnForLimit('max_agents'))` runs as middleware **outside** the accept transaction → concurrent accepts overshoot.
- **Mail relay hole** — invitation HTML is composed in the browser and POSTed to `/api/email/send` from `src/pages/app/settings/TeamDepartmentsPage.tsx:852` and `src/pages/app/TeamPage.tsx:200`; `server/routes/email.ts` only checks membership (no `manage`). Third caller: `src/providers/email/api.ts` (admin test send). `/send-channel` + `sendChannelEmail()` are separately gated (`docs/EMAIL_SURFACE_SPLIT.md`).
- **All seat-creation paths** (`INSERT INTO ... workspace_members`): `accept_workspace_invitation_as` (`042:230`), `create_workspace_atomic` (`039_account_workspace_provisioning.sql:145`; hosted `20260415075435`), hosted-only legacy `accept_workspace_invitation` (`20260415100153:120`, `20260622110429:82`) and `20260415081729:79`. No Express route inserts directly. `workspace_members` already has `UNIQUE (workspace_id, user_id)` (`001_core_tables.sql:65`) — verified, no new key needed.
- **Canonical email verification** — `public.user_credentials.email_verified_at` (`024_user_credentials.sql:33`), written atomically by `030_atomic_auth_token_redemption.sql:124-127`, backfilled by `029`, reset by `035`. There is no `profiles.email_verified*`. v5 writes this exact column, only when the credential row is created/updated during acceptance.
- **Durable outbox already exists** — `048_plugin_platform_and_channels.sql:128` `channel_jobs` (`status pending|running|succeeded|failed|cancelled`, `attempt_count`, `max_attempts`, `available_at`, `locked_by`, `locked_at`, `claim_token uuid`, `claim_expires_at`, `last_error`, secret-free payload) with `claim_channel_jobs(...)` at `:213` (`FOR UPDATE SKIP LOCKED`, `SECURITY DEFINER`, `search_path = public`, revoked from PUBLIC/anon/authenticated, granted to service_role) and `channel_worker_heartbeats`. `worker/index.ts` dispatches on `WORKER_KIND`. v5 mirrors this for invitations.
- **Secrets** — `server/config.ts` defines `CORE_INTERNAL_SECRET`, `CHANNELS_WEBHOOK_SIGNING_KEY`, `PLUGIN_SECRETS_MASTER_KEY`, `AI_RUNTIME_INTERNAL_SECRET`, all optional, with `assertDistinctSigningKey` guards forbidding cross-boundary reuse. `PHONE_VERIFICATION_PEPPER` (`server/services/phoneVerification/crypto.ts`) is OTP-specific with a ≥16-char check, peppered HMAC digests and `timingSafeEqual`. No existing secret is a suitable general link-derivation key → v5 keeps the justified `INVITATION_LINK_SECRET` with a versioned key ring. Redaction infrastructure exists: `shared/security/redactSecrets.ts` via `server/lib/redactSecrets.ts`.
- **Chain divergence (verified)** — `workspace_departments`, `workspace_department_members` (hosted `20260423182832`, the latter with `workspace_id` and `UNIQUE (department_id, user_id)`), `user_availability_prefs` (`20260421073114`, **nullable `workspace_id`**), `user_notification_prefs` (`20260421071651`), `operator_call_availability` (`20260422221658`) and `call_center_department_agents` (`20260511143550`) exist **only in the hosted chain**. `role_permissions` (`20260422211113:95`) is `(workspace_id, role_slug, permission_key, granted)` — a shared role-definition table, never user data.

## 2. Final product flow

Owner/admin invites one specific employee. Required for every v5 invitation: first name, last name, normalized work email, E.164 work phone, member type, role, department assignments where applicable, expiration. The invitation is single-person, expiring, single-acceptance. The backend atomically creates it and queues email + SMS. The email carries the secure `email_claim` link; the SMS is notification-only with no link; the owner receives a separate `manual_handoff` link exactly once. The email link proves mailbox possession; the manual link requires an email OTP for a new or password-null account. A genuinely new user sees only preview, password, confirmation and explicit legal consent (unchecked by default, submit disabled until checked) — never the public multi-step signup. Existing password-protected users log in through the existing self-hosted login. Successful acceptance creates membership and enters the workspace; a post-commit session failure never rolls back membership and routes to login. Pending invitations reserve no seats; creation is blocked when the workspace is full; expired/revoked invitations are never revived ("invite again" creates a new invitation); staff invitations have exactly zero departments; customer-facing invitations require at least one same-workspace department.

## 3. Authentication and identity boundary

Identity = `profiles` + `user_credentials` + `auth_sessions` + Argon2id + `gs_session`, resolved by Express through `server/lib/workspaceAuth.ts`. No GoTrue, no Supabase Auth identity, no `auth.uid()` for application identity, no edge functions, no browser-authorized service-role RPC, no client-provided identity, authority, entitlement or consent version. Public invitation routes derive authority from a valid scoped invitation token plus rate limits; a present session may change UX but never replaces token validation.

## 4. Final version-aware data model

Migrations: self-host `database/migrations/0NN_*` (numbered from the real latest, currently `075`) and the hosted mirror, each with `DO $verify$` privilege proofs in the `043` style. Every new table: RLS on, zero client policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, minimal service_role grants, no DELETE grant on immutable retention tables.

**Prerequisite (self-host only, minimal):** port `workspace_departments` and `workspace_department_members` verbatim from hosted `20260423182832`, plus only the minimal coherent dependency set they need. **No** Calls/Availability/Notification tables are ported.

**workspace_invitations (expanded).** New: `invitation_flow_version smallint NOT NULL DEFAULT 1`, `first_name`, `last_name`, `invited_email_normalized`, `invited_phone_e164`, `member_type`, `status ('pending'|'accepted'|'revoked'|'expired')`, `accepted_by`, `accepted_at`, `revoked_by`, `revoked_at`, `revoked_reason`, `expired_at`, `archived_at`, `notification_generation int NOT NULL DEFAULT 1`, `job_title`, `staff_code`, `last_email_status`, `last_sms_status`. `token` is made **nullable** during expand (it is currently NOT NULL) and set to NULL for every legacy row at the fence; `max_uses`/`use_count`/`token` are dropped in contract.
Constraints: `UNIQUE (id, workspace_id)`; partial unique `(workspace_id, invited_email_normalized) WHERE status='pending'` and the same for `invited_phone_e164` (no `now()` in any predicate); version-aware CHECK
`invitation_flow_version <> 2 OR (first_name IS NOT NULL AND btrim(first_name) <> '' AND last_name IS NOT NULL AND btrim(last_name) <> '' AND invited_email_normalized IS NOT NULL AND invited_email_normalized = lower(btrim(invited_email_normalized)) AND invited_phone_e164 IS NOT NULL AND invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$' AND member_type IS NOT NULL AND role IS NOT NULL AND role <> 'owner' AND expires_at IS NOT NULL AND expires_at > created_at AND notification_generation >= 1 AND created_by IS NOT NULL AND workspace_id IS NOT NULL)` — every clause explicitly `IS NOT NULL` so a SQL NULL cannot silently pass; plus role/member-type pairing, mutually exclusive state timestamps (`pending` ⇒ none of accepted/revoked/expired set; `accepted` ⇒ `accepted_by` + `accepted_at`; `revoked` ⇒ `revoked_by` + `revoked_at` + non-empty `revoked_reason`; `expired` ⇒ `expired_at`). `archived_at` is orthogonal to status. Only the secure create RPC may write `invitation_flow_version = 2`.

**workspace_invitation_tokens** — `id, invitation_id, workspace_id, purpose ('email_claim'|'manual_handoff'), token_hash UNIQUE, token_prefix, token_generation, notification_generation, derivation_key_version (email only), expires_at, consumed_at, revoked_at, created_at`; partial unique `(invitation_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL`.

**workspace_invitation_otps** — `id, invitation_id, workspace_id, email_normalized, manual_token_id, manual_token_generation, notification_generation, purpose, code_digest, attempts, max_attempts, expires_at, consumed_at, revoked_at, ip_hash, created_at`.

**workspace_invitation_proofs** — `id, otp_id, invitation_id, workspace_id, email_normalized, manual_token_id, manual_token_generation, notification_generation, purpose, proof_hash UNIQUE, expires_at, consumed_at, revoked_at, created_at`.

**workspace_invitation_departments** — `(invitation_id, workspace_id, department_id)`, PK `(invitation_id, department_id)`, `FK (invitation_id, workspace_id) → workspace_invitations(id, workspace_id) ON DELETE CASCADE`, `FK (department_id, workspace_id) → workspace_departments(id, workspace_id) ON DELETE RESTRICT` (both parents gain `UNIQUE (id, workspace_id)`).

**workspace_invitation_jobs** — `id, invitation_id, workspace_id, channel, notification_generation, email_token_generation, derivation_key_version, destination_hash, idempotency_key UNIQUE, status ('queued'|'claimed'|'provider_accepted'|'completed'|'retrying'|'permanently_failed'|'cancelled'|'unconfigured'|'derivation_key_unavailable'), attempt_count, max_attempts, available_at, locked_by, locked_at, claim_token uuid, claim_expires_at, last_error, created_at, updated_at`. Payload is secret-free and never contains a raw token.

**workspace_invitation_deliveries (append-only)** — `id, invitation_id, workspace_id, job_id, channel, notification_generation, attempt_number, provider_name, provider_message_id, status, error_code, safe_error_message, created_at, provider_accepted_at, sent_at, delivered_at, failed_at, metadata`. `delivered` only from a signature-verified webhook. No DELETE grant.

**workspace_member_details** — `workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id, joined_at, updated_at`; PK `(workspace_id, user_id)`; `FK (workspace_id, user_id) → workspace_members(workspace_id, user_id) ON DELETE RESTRICT`; `FK invitation_id → workspace_invitations(id) ON DELETE RESTRICT`.

**workspace_member_details_history** — same descriptive columns + `offboarded_at`, `offboarded_by`, `reason`; `workspace_id NOT NULL → workspaces(id) ON DELETE CASCADE`; `user_id NULL → profiles(id) ON DELETE SET NULL`; `invitation_id NULL → workspace_invitations(id) ON DELETE SET NULL`; **no FK to `workspace_members`**. Readable by workspace owner/admin and platform admin through a server route. Retained indefinitely unless anonymized by the existing `privacy_jobs` process.

**legal_policy_versions** — `id, policy_type, version, locale, content_hash, document_url, published_at, effective_from, is_active`, unique `(policy_type, version, locale)`; trigger rejects edits to `version`/`content_hash`/`published_at` and any delete once referenced by consent.

**workspace_invitation_consents** — `id, user_id, workspace_id, invitation_id UNIQUE, terms_version_id, terms_content_hash, privacy_version_id, privacy_content_hash, accepted_at DEFAULT now(), ip, user_agent, locale, acceptance_method ('email_claim'|'manual_handoff_otp'|'existing_account')`; FKs `ON DELETE RESTRICT`; no DELETE grant.

**workspace_invitation_idempotency** — `key UNIQUE, scope_kind, operation, workspace_id, invitation_id, result_state, response_digest, created_at, expires_at (24h)`. Never stores raw tokens, proofs, OTPs or passwords.

## 5. Token, key-version, generation, OTP and proof model

- **Manual handoff token** — Express-generated, ≥256-bit CSPRNG, base64url. Only `sha256` + prefix + expiry enter the create/rotate RPC. Returned to the authorized manager exactly once; never stored, logged or audited.
- **Email claim token** — does not exist at creation. On the **first successful preparation** of a logical email job (after exclusive claim), the worker persists `derivation_key_version` on the job if absent, then derives
  `raw = base64url(HMAC-SHA-256(K_v, canonical_input))` where `K_v = HKDF(INVITATION_LINK_SECRET[v], info="workspace-invitation-email-token-v1")` and `canonical_input` is a **versioned binary encoding** with fixed field order and length-prefixed variable fields: `format_version(u8) || purpose(len-prefixed) || invitation_id(16B) || job_id(16B) || notification_generation(u32 BE) || email_token_generation(u32 BE) || derivation_key_version(u16 BE)`. No ambiguous string concatenation. Only `sha256(raw)` + prefix are persisted.
- **Key ring** — each configured key has a non-secret version id. Every retry reads the job's persisted `derivation_key_version` and uses exactly that key, so the identical raw token is reconstructed; a retry never silently switches to the current key. If that key is unavailable the job fails closed as `derivation_key_unavailable` — never a different link. A previous key may be removed only when no retryable/in-flight job references it. **Incoming links are always validated by stored token hash**, not by the key ring; the key ring exists solely for retry reconstruction.
- **Generations** — `notification_generation` is the invitation-level master counter; `email_token_generation` distinguishes explicit resends within a generation. Every token, OTP, proof, job and delivery row carries its generation. Resend ⇒ new job + new `email_token_generation`, previous email tokens revoked, manual link untouched. Rotate ⇒ new manual token only, no email/SMS resend unless explicitly requested. Email/phone change ⇒ full generation bump (§7).
- **OTP** — CSPRNG 6 digits, peppered-HMAC digest only, 10-minute expiry, single use, max 5 attempts, 60 s resend cooldown, capped sends per invitation/window, previous OTP invalidated on resend, uniform responses that never reveal account existence, rate limits by IP + invitation + destination-email hash (+ workspace only after the token resolves). Bound to invitation, workspace, normalized email, manual token id, manual token generation, notification generation and purpose.
- **Proof transport (single model)** — successful OTP verification creates a random proof value, stores only its hash bound to all the fields above plus `otp_id`, consumes the OTP, and returns **no proof material in the JSON body**. The raw proof travels only in a cookie: `HttpOnly; Secure` (production); `SameSite=Strict`; `Path=/api/workspace-invitations/accept-new`; `Max-Age ≤ proof expiry`; no `Domain` attribute. It never appears in JSON, URLs, JavaScript memory, localStorage, sessionStorage, logs, audit, analytics or error tracking. `POST /accept-new` reads the cookie, hashes it, resolves the proof row and validates every binding, under strict Origin validation, the existing CSRF controls, JSON-only content type, no permissive CORS and rate limits. The cookie is cleared after success, expiry, terminal invalidation, logout or cancel. **One active manual-invitation proof per browser**: obtaining a new proof replaces the cookie; DB-side proofs remain individually bound and are not globally valid, so a replaced cookie simply cannot be presented any more.
- Lookup is an indexed equality on the stored SHA-256 hash (not claimed constant-time); safety rests on ≥256-bit entropy, hashing, expiry, rate limits and single use. Application-level secret comparisons use `timingSafeEqual`. Provider delivery is at-least-once; v5 guarantees idempotent logical content and single-use acceptance, never exactly-once email.

## 6. Canonical lock order

**Global order:** `workspace → invitation → token/OTP/proof → invitation job → dependent membership/department rows`. It applies to edit, resend, rotate, revoke, archive, acceptance, expiration and offboarding.

**Resolving from a token or invitation id:** perform an unlocked indexed lookup **only** to obtain candidate invitation/workspace ids, then lock the workspace, then the invitation, then re-read and revalidate every field. Nothing from the pre-lock lookup is trusted beyond locating lock targets. `edit_workspace_invitation_v2` therefore locks the **workspace first** (correcting v4).

**Job claim transaction** — `claim_invitation_jobs` is a separate short transaction that may lock job rows with `FOR UPDATE SKIP LOCKED`, but only to assign `claim_token`/lease. It commits before any worker transaction takes a workspace or invitation lock, and never holds a job-row lock while waiting for a workspace lock.

**Worker processing transaction** — after the claim commits: read candidate ids from the job → lock workspace → lock invitation → lock/re-read the job → verify claim token, lease, generation, destination hash and status → persist token-hash preparation and `derivation_key_version` if needed → **commit before the provider call**. The provider network request never happens inside a transaction or under a workspace lock. Immediately before submission the worker performs a short read-only preflight (invitation still pending/unexpired, generation match, job not cancelled, lease valid) and the unavoidable final external race is acknowledged: a request already in flight cannot be recalled, but its token is already revoked and unusable.

**Completion transaction** — recording provider acceptance/failure verifies the matching `claim_token` and job generation, so a worker that lost its lease can never overwrite a newer worker's state.

Because every long-lived path acquires locks in the same order, and the only place that takes job locks first (`claim_invitation_jobs`) releases them at commit before requesting any higher-level lock, no cycle can form — lock inversion is structurally impossible.

## 7. Atomic RPCs

All are service_role-only, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, fully qualified, no unsafe dynamic SQL, revalidating actor membership and permission from server-resolved ids. No mutation is ever a sequence of independent PostgREST statements.

**`create_workspace_invitation_v2`** — caller: Express (owner/admin from `gs_session`). One transaction: lock workspace → validate inviter membership + permission (including the admin-invite rule) → validate role/member-type pairing, normalized email, E.164 phone → lazily expire stale pending rows for the same email/phone → uniqueness check → advisory capacity check (blocked when full, no waitlist) → insert invitation (`invitation_flow_version = 2`, `notification_generation = 1`) → insert departments → insert **only the manual_handoff token hash** → insert one email job and one SMS job → insert `queued` delivery rows → insert audit. No email token is created here. Returns the safe invitation only; the raw manual link is returned by the route once.

**`edit_workspace_invitation_v2`** — one transaction, canonical order: lock workspace → lock invitation → lazily expire → require `pending` → revalidate caller permission **against the resulting state** (an admin can neither set nor manage `admin`) → replace departments atomically → on email/phone change: cancel all unclaimed jobs of the previous generation, revoke prior email tokens, OTPs and proofs, increment `notification_generation`, update normalized fields, insert new jobs and `queued` deliveries → preserve historical delivery attempts → audit.

**`resend_invitation_email_v2` / `rotate_manual_link_v2` / `revoke_invitation_v2` / `archive_invitation_v2` / `expire_invitations_v2`** — same lock order, same permission revalidation, same audit discipline; resend bumps `email_token_generation` and revokes previous email tokens; rotate replaces only the manual token and revokes its OTPs/proofs.

## 8. Acceptance state machine

**`accept_invitation_new_user_v2`** — allowed only when no profile exists, or a profile whose `user_credentials.password_hash IS NULL`. Requires: current valid invitation token; current OTP proof when the manual link is used; explicit invitation consent; pending unexpired invitation; available seat; Argon2id hash produced by Express. Transaction (canonical lock order): lock workspace → lock invitation → lock/validate token and proof (generations current, unconsumed, unrevoked, unexpired) → resolve authoritative entitlement → count seats → enforce → confirm no active password-protected account (else `ACCOUNT_EXISTS_LOGIN_REQUIRED`, mutating nothing) → create or reuse the allowed profile → insert/update `user_credentials` with the hash → set `user_credentials.email_verified_at = now()` and record verification source (`workspace_invitation_email_claim` / `workspace_invitation_manual_otp`) → create membership → create member details → assign departments → insert consent → accept invitation → consume the used token/proof → revoke siblings. Plaintext passwords never leave Express: never sent to PostgreSQL, logs, audit or analytics.

**`accept_invitation_existing_user_v2`** — requires **both** a valid `gs_session` and a valid current invitation token (`email_claim` or `manual_handoff`) belonging to that invitation/workspace with a current generation, a pending unexpired invitation, session email equal to the invited normalized email, an active account, explicit invitation-specific consent and an available seat. A successful authenticated login on the invited address is sufficient mailbox proof, so **no OTP is required for the manual link in this path** — but the manual token is still required and is consumed during acceptance. Acceptance by invitation id + session alone is impossible. The raw token travels in the HTTPS request body only, is redacted by logging/error middleware (`shared/security/redactSecrets.ts`), and never reaches logs or audit; Express passes only internally resolved ids and hashes to the RPC, which revalidates every relationship.

Disabled/suspended/locked accounts fail closed in both paths. Seat exhaustion returns `SEAT_LIMIT_REACHED` **without consuming token, proof or consent**.

**Session after commit** — `gs_session` is created only after the acceptance transaction commits. Failure returns `SESSION_CREATE_FAILED_LOGIN_REQUIRED`; membership stays valid, acceptance is not duplicated, and the user logs in with the password just established.

## 9. Durable outbox and crash recovery

`workspace_invitation_jobs` + `claim_invitation_jobs(_worker_id,_limit,_lease_seconds,_channels)` mirroring `claim_channel_jobs` (`FOR UPDATE SKIP LOCKED`, `claim_token` nonce, `claim_expires_at` lease, service_role-only execute), heartbeats via the `channel_worker_heartbeats` pattern. States: `queued → claimed → provider_accepted → completed`, with `retrying`, `permanently_failed`, `cancelled`, `unconfigured`, `derivation_key_unavailable`. Exponential backoff, `max_attempts` then dead-letter. Lease expiry returns the job to `queued`; every write asserts the matching claim token. Provider timeouts count as possibly-accepted — duplicate submission is possible and harmless because the deterministic token makes the retry link identical. Webhooks are signature-verified before writing `delivered` or provider failure, correlated by `provider_message_id`. Graceful shutdown releases claims. Exactly one execution mode processes jobs: `WORKER_KIND=invitations` or the single-container in-process fallback, chosen by a server setting whose startup validation rejects both as primary; the claim mechanism stays safe even if both run. Provider acceptance is never labelled delivered; stub/unconfigured is never success; email/SMS failure never deletes or revokes the invitation.

## 10. Canonical API, error codes and idempotency

`server/routes/workspaceInvitations.ts`. For each route: caller / identity source / token requirement / transaction / lock order / idempotency scope / returns.

| Route | Caller & identity | Token | Transaction & lock | Idempotency scope | Returns |
| --- | --- | --- | --- | --- | --- |
| `POST /` | owner/admin, `gs_session` | – | create RPC, ws→inv | `actor_id|workspace_id|create|client_request_id` | safe invitation + manual link **once** |
| `GET /?workspaceId=` | owner/admin | – | read | – | safe list (prefix only) |
| `GET /:id` | owner/admin | – | read | – | safe detail + delivery history |
| `PATCH /:id` | owner/admin (resulting state) | – | edit RPC, ws→inv | `actor|ws|inv|edit|req` | safe invitation |
| `POST /:id/resend` | owner/admin | – | resend RPC, ws→inv | `actor|ws|inv|resend|req` | new generation info |
| `POST /:id/rotate-link` | owner/admin | – | rotate RPC, ws→inv | `actor|ws|inv|rotate|req` | new manual link **once** |
| `POST /:id/revoke`, `POST /:id/archive` | owner/admin | – | RPC, ws→inv | `actor|ws|inv|op|req` | ok |
| `GET /preview?token=` | token possession + IP/global limits | required | read | – | masked preview |
| `POST /otp/request`, `POST /otp/verify` | token possession + layered limits | required | OTP RPCs, ws→inv | `resolved_invitation_id|resolved_token_id|op|req` (+ current generations) | generic status; verify sets the HttpOnly proof cookie |
| `POST /accept-new` | token + proof cookie | required | accept RPC, ws→inv→token/proof→membership | `resolved_invitation_id|resolved_token_id|accept_new|req` | session or stable state |
| `POST /accept-existing` | `gs_session` **and** token | required | accept RPC, same order | `session_user_id|resolved_invitation_id|resolved_token_id|accept_existing|req` | session state |

Error codes: `INVITATION_NOT_FOUND` (uniform for invalid/expired/revoked/consumed/unknown on public endpoints), `INVITATION_DUPLICATE` (409), `INVITATION_NOT_PENDING`, `ACCOUNT_EXISTS_LOGIN_REQUIRED`, `ACCOUNT_DISABLED`, `EMAIL_PROOF_REQUIRED`, `OTP_INVALID`, `OTP_RATE_LIMITED`, `CONSENT_REQUIRED`, `SEAT_LIMIT_REACHED`, `ENTITLEMENT_UNAVAILABLE` (503), `SESSION_CREATE_FAILED_LOGIN_REQUIRED`, `FORBIDDEN_ROLE_ESCALATION`, `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE`, `DERIVATION_KEY_UNAVAILABLE`.

**Idempotency rules.** Keys are server-derived; raw token values never enter a key (only server-resolved ids do). Actor id comes only from `gs_session`, so public routes use resolved invitation/token ids instead. The create key omits `invitation_id` (it does not exist yet) and its transaction guarantees a single row per request id. Replaying the same key returns the same logical result; a new client request id is a genuinely new operation, so later resends and rotations work. Because raw manual tokens are deliberately not stored, a committed create/rotate whose response was lost returns `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE` with the safe invitation id/state only — never a different link under the same key. Recovery: for a lost create, the email/SMS jobs remain queued exactly once and the owner obtains a new manual link via rotate with a **new** request id; for a lost rotate, the owner issues another rotation with a new request id. The UI explains this without creating a duplicate employee invitation. Records hold no raw token/proof/OTP/password, expire after 24 h, and a post-expiry replay is still constrained by invitation uniqueness and state checks.

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

Enforced twice — in Express from `gs_session`, and again in each RPC from the server-resolved actor against real membership, always against the resulting state. Customer-facing invitations may use only agent/support_agent/sales_agent/team_lead; staff invitations use the staff role set.

## 12. Frontend states

`InvitePage.tsx` rewritten against Express (no `supabase.rpc`/`supabase.from`): masked preview → (manual link + new/password-null account) OTP step → password + confirm + **unchecked consent** with links to the effective terms/privacy → accept → workspace. States: loading, invalid/expired/revoked (uniform copy), otp_required, otp_locked, ready, accepting, seat_limit_reached, account_exists_login_required, wrong_account, session_failed_login_required, accepted. Existing accounts are routed to login with the invite redirect preserved and, on return, **always** see the unchecked invitation consent checkbox before final acceptance. Token hygiene: `Referrer-Policy: no-referrer`, `history.replaceState` immediately after reading the token, no analytics/error-tracking capture, no raw token in toasts or error text.

Management UI (create dialog with all required fields, pending/archived filters, per-attempt delivery history, expiry, edit/resend/rotate/revoke/archive, verified clipboard feedback, seat-limit messaging, lost-link recovery copy, "invite again" prefill) lands in `StaffAccessPage.tsx` (staff) and `TeamDepartmentsPage.tsx` (customer-facing); hidden for non-managers with the backend as final authority. `TeamPage.tsx` keeps only its redirect. fa/en/tr strings, RTL support.

## 13. Consent and legal model

Immutable `legal_policy_versions`; the backend/database selects the authoritative effective versions. **Every** acceptance — new account, password-null account and existing authenticated account alike — shows an explicit unchecked checkbox, disables submit until checked, and records exactly one invitation-specific consent row containing user, workspace, invitation, terms version + content hash, privacy version + content hash, locale, server timestamp, trusted client IP (`server/utils/clientIp.ts` proxy rules), user agent and acceptance method. Login or prior global consent never substitutes. Referenced versions/hashes can never be edited or deleted. Marketing consent stays separate and is never implied.

## 14. Seat concurrency and entitlement

Every runtime seat insertion locks `public.workspaces` for the target row before counting and inserting: both acceptance RPCs (new), `create_workspace_atomic` (documented bootstrap — a brand-new workspace with exactly its owner; gains the lock for uniformity), legacy accept RPCs (fenced then dropped). A CI guard scans both chains for `INSERT INTO ... workspace_members` and fails any statement not inside a function containing the workspace lock. `max_agents` is resolved **inside the transaction** from the authoritative subscription/entitlement source (`SELF_HOST_BILLING_MODE=unlimited` is the only unlimited source); an unresolvable entitlement raises → `503 ENTITLEMENT_UNAVAILABLE`, never unlimited. Pending invitations reserve nothing; creation is blocked when full; a later seat shortage yields a retryable `SEAT_LIMIT_REACHED` that consumes nothing.

## 15. Expiration and archival

An idempotent janitor (same worker) flips due `pending` rows to `expired` (setting `expired_at`), revokes their tokens/OTPs/proofs and cancels queued jobs, with an audit event; lazy expiry also runs before every uniqueness check, list, preview, resend, rotate and accept. Expired/revoked invitations never return to pending — "invite again" creates a new row with a new id, tokens, consent lifecycle and audit trail, optionally prefilled in the UI. Pending invitations are revoked, not deleted; revoked/expired may be archived (hidden by default, visible under an archived filter, tokens permanently unusable); accepted may only be archived. Invitations, consents, deliveries, member history and audit are never hard-deleted by ordinary management; permanent purge exists only inside the formal privacy/retention process (`privacy_jobs`).

## 16. Offboarding and chain-specific retention

`offboard_workspace_member(...)` — service_role only; identical public contract and security behavior on both chains, with **deliberately chain-specific bodies** documented in `database/README.md`, no `to_regclass` guessing and no unsafe dynamic SQL. Steps: lock workspace → resolve target inside that workspace → protect the canonical `workspaces.owner_id` → snapshot `workspace_member_details` into history → delete active details → delete `workspace_members` → delete verified same-workspace assignment rows → revoke matching pending invitations and their tokens/OTPs/proofs/jobs → audit.

| Data | Hosted | Self-host |
| --- | --- | --- |
| `workspace_member_details` → history | snapshot + delete | snapshot + delete |
| `workspace_members` | delete | delete |
| `workspace_department_members` | delete | delete (ported) |
| `call_center_department_agents` | delete | n/a (not in chain, not ported) |
| `operator_call_availability` | delete | n/a |
| `user_availability_prefs` | delete **only** `workspace_id = target` (global NULL row preserved) | n/a |
| `user_notification_prefs` | delete this workspace's rows | n/a |
| pending invitations + tokens/OTPs/proofs/jobs | revoke / cancel | revoke / cancel |
| `role_permissions` | untouched | untouched |
| accepted invitations, consents, deliveries, history, audit | retained | retained |
| global `profiles`/`user_credentials`, other workspaces | untouched | untouched |

Each chain gets its own integration tests. Removed members lose authorization immediately through the existing server-side membership checks.

## 17. RLS, grants, SECURITY DEFINER and secret handling

Every new table: RLS on, zero client policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, minimal service_role grants, no DELETE on consents/deliveries/history/audit. Every new function: service_role execute only, `SET search_path = public, pg_temp`, fully qualified references, no unsafe dynamic SQL, internal tenant and role validation, and an in-migration `DO $verify$` privilege assertion mirroring `043`.

Never stored or logged: raw manual token, raw email token, OTP code, raw proof, plaintext password, service-role key, `INVITATION_LINK_SECRET`, `PHONE_VERIFICATION_PEPPER`, any email/SMS body containing an invitation URL, full provider error bodies that could echo request content. Precise transport exceptions: the manual token appears only in the single authorized create/rotate response; the email token only in the server-rendered email link and the incoming request; the OTP only in the OTP email and the user's submission; the proof only in the HttpOnly cookie; the password only in the HTTPS request to Express before Argon2id hashing. All logging/error middleware redacts invitation token, OTP, proof cookie and password fields via `shared/security/redactSecrets.ts`.

## 18. Legacy API and mail-relay closure

Legacy invitation HTTP routes return `410 Gone` after cutover and are deleted in contract; legacy DB invitation RPCs are fenced then removed. Browser invitation-email callers are removed. `/api/email/send` loses arbitrary `to`/`subject`/`html` and is replaced by `POST /api/email/test-send`: owner/admin only, fixed server-rendered template, recipient restricted to a verified workspace address. `/send-channel` and `sendChannelEmail()` are unchanged. Ordinary members can no longer relay mail.

## 19. Migration, cutover and recovery

1. Trace both chains (done, §1). *Abort if* the hosted department definitions cannot be ported cleanly.
2. Port only `workspace_departments`, `workspace_department_members` (+ minimal dependencies) to self-host. *Verify:* both chains apply; department APIs work on self-host.
3. Add the version-aware invitation schema (including making `token` nullable) and all new tables. *Verify:* in-migration proofs pass; legacy runtime unaffected.
4. Add RPCs, worker job tables, grants and privilege assertions. *Verify:* anon/authenticated denied on every new object.
5. Deploy backend with `INVITATIONS_V5` disabled. *Verify:* health; legacy flow green. *Abort:* redeploy previous image.
6. Deploy the compatible frontend. *Verify:* no regressions.
7. Configure and verify the invitation worker and `INVITATION_LINK_SECRET` key ring (startup strength + distinctness checks, current/previous versions). *Verify:* claim, backoff, heartbeat.
8. Enable v5. *Verify* end-to-end: create → email → SMS → manual OTP → new accept → existing accept → offboard.
9. Enable the DB legacy write/accept fence (no version-1/plaintext writes, no legacy acceptance). *Verify:* legacy writes rejected.
10. Return `410 Gone` from legacy HTTP routes; revoke all still-pending legacy invitations; **set every legacy plaintext token value to NULL immediately**. *Verify:* no usable or recoverable plaintext token remains; version-1 history still readable.
11. Monitor delivery failures, stuck jobs, seat/OTP errors.
12. Contract migration later: drop `token`, `max_uses`, `use_count`, `get_invitation_info` and both legacy accept RPCs.

After the fence, rollback to an insecure build is not supported — only a compatible fenced build or forward-fix. Not universally zero-downtime: steps 9–10 may briefly make invitation management unavailable while the rest of the app stays up. Documented in `docs/DEPLOYMENT.md`, `database/README.md`, `SELF_HOST_GUIDE.md`.

## 20. Exact test plan (real PostgreSQL for constraints, privileges, transactions, locks, concurrency)

**Locking/concurrency:** edit locks workspace before invitation; claim transaction never seeks a workspace lock while holding a job lock; worker processing follows the canonical order; deadlock stress across edit/resend/revoke/accept/worker; edit vs claim; edit vs worker preflight; revoke vs retry; accept vs expiration; two accepts in one workspace; lease expiry while the original worker is alive.
**Key version:** version persisted on first preparation; retry uses the persisted version before and after rotation; missing previous key fails closed as `derivation_key_unavailable`; attempted silent version substitution rejected; identical canonical inputs → identical token; any input/version change → different token; canonical binary encoding has no ambiguous collisions; incoming links keep validating by stored hash after rotation.
**Token ownership/timing:** create inserts a manual hash and no email token; the worker creates the email token only after claiming; retry of the same job reconstructs the same token; no raw deterministic token is ever persisted; resend creates a new generation and revokes the previous email generation; manual rotation does not touch email generation and vice versa.
**Crash recovery:** provider accepts → worker crashes → retry sends the same valid link; duplicate provider submission cannot duplicate membership; lease expiry never yields an incompatible token.
**Proof transport:** OTP verify sets the HttpOnly cookie; proof absent from JSON and JS-visible storage; cookie attributes correct; Origin/CSRF rejection; cookie cleared after use; proof cannot cross invitations, emails, token generations or browser flows; proof replay fails; `proof_hash` uniqueness enforced; seat failure consumes no proof.
**Existing-account acceptance:** session without token rejected; token without session rejected; wrong-session email rejected; token from another invitation rejected; rotated/expired/consumed token rejected; correct manual token + matching login accepted without OTP; email token + matching login accepted; accepted-token replay rejected.
**Required fields/legacy:** version-2 NULL fields rejected; a SQL NULL cannot bypass a CHECK; version-1 history readable; version-1 pending rows revoked at the fence; legacy plaintext values NULL after the fence; old/compatible-rollback backends cannot recreate plaintext invitations.
**Chain compatibility:** self-host migration introduces no Calls/Availability/Notification tables; hosted offboarding cleans only verified hosted rows (never the global NULL-workspace availability row); self-host offboarding references only existing self-host tables; both expose the same safe RPC contract.
**Departments:** customer-facing with zero departments fails at commit; staff with any department fails at commit; cross-workspace department rejected; atomic replacement never commits an invalid state; deferred trigger fires from both sides.
**Idempotency:** create retry creates one invitation; lost create and lost rotate responses give `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE`; public operations work without an actor id; keys cannot collide across workspace/invitation/token; a new intentional resend works after an earlier one; expired idempotency records cannot bypass uniqueness or state checks; acceptance retry duplicates no membership, consent or audit.
**Consent:** every acceptance shows an unchecked checkbox; an existing user cannot skip invitation consent because of login or prior global consent; consent inserted exactly once; referenced legal versions immutable.
**Seats/entitlement:** two different invitations of one workspace accepted concurrently cannot exceed `max_agents`; every seat path takes the workspace lock (plus CI guard); entitlement failure → 503; `SEAT_LIMIT_REACHED` retryable and non-consuming.
**History/retention:** snapshot survives membership deletion; nullable history FKs behave; accepted invitations cannot be hard-deleted; consent/delivery/audit survive archival and offboarding; shared role definitions and other workspaces untouched.
**Security:** no raw token/OTP/proof/password in rows, logs, audits, analytics or ordinary responses; anon/authenticated cannot read any new table or execute any new RPC; preview leaks only masked PII; existing password account cannot accept via `accept-new`; concurrent profile creation fails to login-required; ordinary member cannot relay mail; session-creation failure yields login recovery without duplicate membership; no GoTrue/Supabase Auth/`auth.uid()`/edge-function dependency introduced; widget runtime and build byte-unchanged.

## 21. Out of scope

Embedded chat widget runtime and build; AI, Calls, Channels, Inbox, Billing beyond the entitlement read; porting hosted-only Calls/Availability/Notification tables to self-host; ownership transfer; SSO/social login; marketing-consent management; new SaaS dependencies or edge functions. One new secret (`INVITATION_LINK_SECRET`) is introduced deliberately and justified in §1/§5.

## 22. Remaining assumptions

- The hosted `workspace_departments`/`workspace_department_members` definitions (`20260423182832`) port cleanly into self-host with only a minimal dependency set; re-verified column-by-column when the migration is written.
- Localized terms/privacy documents exist to seed the first `legal_policy_versions` rows (content hashes computed from the shipped documents at migration time).

## 23. Readiness verdict

Final contradiction sweep of this document: lock order is workspace-first everywhere including the edit RPC (§6, §7); the job-claim transaction only assigns a lease and commits before any workspace/invitation lock (§6, §9); each email job persists its `derivation_key_version` and every retry reuses exactly that key or fails closed (§5); incoming links are validated only by stored hash while the key ring serves retry reconstruction alone (§5); the OTP proof exists solely as a hashed row transported by an HttpOnly cookie and never in JSON (§5, §10); `accept-existing` requires session **and** a current token, with no OTP for an authenticated invited account (§8, §10); version-2 rows enforce every required field through `IS NOT NULL`-guarded checks while version-1 history stays readable and nullable (§4, §19); legacy plaintext tokens are NULLed at the fence, before contract (§19); offboarding is chain-specific with no unrelated ports and no `to_regclass` (§16); idempotency scopes exist for create (no invitation id) and public routes (no actor id), with `OPERATION_COMMITTED_LINK_NOT_REPLAYABLE` for lost link responses (§10); consent is invitation-specific for every acceptance path including existing users (§12, §13); and no raw token, OTP, proof or password is ever stored (§5, §17). Authentication stays fully self-hosted — `profiles`, `user_credentials`, `auth_sessions`, Argon2id, `gs_session`, `authorizeWorkspaceAccess` — with no GoTrue, no Supabase Auth identity, no `auth.uid()`, no edge functions, no browser-reachable privileged RPC and no arbitrary mail relay; the embedded widget is untouched. **Safe to implement** upon approval.
