# Workspace Invitations — Final Production-Ready Redesign v4

## 1. Verified repository findings (re-traced for v4)

- **Invitation code today** — `server/routes/workspaceMembers.ts`: `GET/POST/PATCH/DELETE /invitations` + `POST /accept-invitation`. `GET /invitations` uses `select('*')`, so the **plaintext token reaches any workspace member**, and it is not manage-gated. Create sets `max_uses: 0` (unlimited use) and accepts only role/email/expiry.
- **Schema today** — `database/migrations/042_workspace_invitations.sql`: `workspace_invitations` stores the raw `token`, `max_uses`, `use_count`, nullable `expires_at`; no names, phone, status, departments, consent. Defines `get_invitation_info(text)` (anon-executable, reads `auth.uid()` → always NULL under first-party auth) and `accept_workspace_invitation_as(text, uuid)` (service_role only, inserts `workspace_members` at line 230). `043_service_role_table_grants.sql` shows the required grant discipline (service_role only; anon/authenticated explicitly asserted *absent*) and its in-migration `DO $verify$` proof style — v4 follows both.
- **Frontend today** — `src/pages/auth/InvitePage.tsx` calls `supabase.rpc('get_invitation_info')` directly; there is no password-setup flow, so an invitee must already have an account.
- **Seat limit today** — `requireLimit('max_agents', usageFnForLimit('max_agents'))` middleware runs *outside* the accept transaction → concurrent accepts overshoot.
- **Mail relay hole** — invitation HTML is built in the browser and POSTed to `/api/email/send` from `src/pages/app/settings/TeamDepartmentsPage.tsx:852` and `src/pages/app/TeamPage.tsx:200`; `server/routes/email.ts` only checks membership (`authorizeWorkspaceAccess` without `manage`). Third caller: `src/providers/email/api.ts` (admin test send). `/send-channel` + `sendChannelEmail()` are separately gated (`docs/EMAIL_SURFACE_SPLIT.md`).
- **Seat-creation paths** (complete trace of `INSERT INTO ... workspace_members`): `accept_workspace_invitation_as` (`042:230`), `create_workspace_atomic` (`039_account_workspace_provisioning.sql:145` self-host / `supabase/migrations/20260415075435` hosted), hosted-only legacy `accept_workspace_invitation` (`20260415100153:120`, `20260622110429:82`), and `20260415081729:79`. No Express route inserts directly. `workspace_members` already has `UNIQUE (workspace_id, user_id)` (`001_core_tables.sql:65`) — confirmed, no new unique key needed.
- **Canonical email verification field** — `public.user_credentials.email_verified_at` (`024_user_credentials.sql:33`), written atomically by `030_atomic_auth_token_redemption.sql:124-127` (INSERT … ON CONFLICT UPDATE), backfilled by `029`, reset by `035`. There is **no** `profiles.email_verified*` column. v4 writes this exact field, and only when a credential row is created/updated during acceptance.
- **Durable outbox already exists** — `database/migrations/048_plugin_platform_and_channels.sql:128` `channel_jobs` (`status pending|running|succeeded|failed|cancelled`, `attempt_count`, `max_attempts`, `available_at`, `locked_by`, `locked_at`, `claim_token uuid`, `claim_expires_at`, `last_error`, secret-free `payload`), claimed by `claim_channel_jobs(_worker_id,_limit,_lease_seconds,_job_types)` (`:213`, `SECURITY DEFINER`, `search_path = public`, revoked from PUBLIC/anon/authenticated, granted to service_role), plus `channel_worker_heartbeats`. `worker/index.ts` dispatches by `WORKER_KIND` (`intelligence|source-sync|file-ingest|regression-runner|channels|all`). v4 reuses this exact pattern for a new `workspace_invitation_jobs` table + `claim_invitation_jobs` RPC and a new `WORKER_KIND=invitations`.
- **Server secrets** — `server/config.ts` has `CORE_INTERNAL_SECRET`, `CHANNELS_WEBHOOK_SIGNING_KEY`, `PLUGIN_SECRETS_MASTER_KEY`, `AI_RUNTIME_INTERNAL_SECRET` (all optional), plus startup guards forbidding reuse between boundaries; `SESSION_SECRET`/`JWT_SECRET` are only referenced in those guards. `PHONE_VERIFICATION_PEPPER` (`server/services/phoneVerification/crypto.ts`) is a required-for-OTP pepper with a ≥16-char strength check, peppered HMAC digests bound to challenge/user/phone, `timingSafeEqual`, and IP hashing. **No existing secret is a suitable general-purpose link-derivation key**, and reusing the phone pepper across boundaries would violate the codebase's own distinct-secret rule → v4 introduces `INVITATION_LINK_SECRET` (required when invitations are enabled) with a startup strength + distinctness check and a `current/previous` key ring.
- **Chain divergence (critical)** — `workspace_departments`, `workspace_department_members`, `user_availability_prefs`, `operator_call_availability`, `user_notification_prefs`, `call_center_department_agents` exist **only in `supabase/migrations` (hosted)**; `database/migrations` (self-host) has none of them. Departments are mandatory for `customer_facing` invitations, so v4 **must** first port `workspace_departments` + `workspace_department_members` into the self-host chain (verbatim from `20260423182832`, which already has `UNIQUE (department_id, user_id)` and a `workspace_id` column). The other four are ported in the same migration or the offboarding RPC is emitted per chain — decided explicitly in §17, not left to `to_regclass`.
- `user_availability_prefs.workspace_id` is **nullable** (`20260421073114:5`) — a global row exists per user. Offboarding must delete only `workspace_id = <target>`, never `NULL`.
- `role_permissions` (`20260422211113:95`) is `(workspace_id, role_slug, permission_key, granted)` — a **shared role definition table, not user data**. Offboarding never touches it.

## 2. Final product behavior

Owner/admin creates a single-person invitation with required first name, last name, work email, E.164 work phone, member type, role, and department(s) where required; backend normalizes and validates email/phone; the invitation has an expiry and exactly one acceptance. The backend atomically creates the invitation, queues the email job and the SMS job, and returns the **manual link exactly once** to the manager. The email carries the secure acceptance link; the SMS is notification-only with no link. The email link proves mailbox control; the manual link does not and therefore requires an email OTP before password setup. A genuinely new user sees only: preview → (OTP if manual) → password → confirm → unchecked consent checkbox → submit (disabled until consent). No public three-step signup. On success a self-hosted `gs_session` is issued and the user lands in the workspace; if session creation fails the membership stays valid and the user is sent to normal login. Existing password-protected accounts always authenticate through the normal self-hosted login. No GoTrue, Supabase Auth identity, `auth.uid()` or edge functions anywhere in the flow.

## 3. Authentication and identity boundary

Identity is `profiles` + `user_credentials` + `auth_sessions` + Argon2id + `gs_session`, resolved by Express via `server/lib/workspaceAuth.ts`. The browser never supplies user id, profile id, workspace authority, role authority, verification state, seat limit, entitlement, consent version, inviter identity or account status. Express may pass internally resolved values to service-role RPCs, and **every RPC revalidates** membership, invitation state and tenant relationship.

Correction to v3: public routes (`GET /preview`, `POST /otp/request`, `POST /otp/verify`, `POST /accept-new`) derive authority from **possession of a valid scoped token plus rate limits**, not from `gs_session`. A present `gs_session` on those routes is used only for account-state UX (e.g. "you are signed in as X"), never as authorization. Only `accept-existing` and all management routes take authority from `gs_session`.

## 4. Final database model

New self-host migration (numbered from the real latest file, currently `075`) + mirrored hosted migration, each with an in-migration `DO $verify$` proof in the `043` style. Every new table: RLS enabled, zero client policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, minimum grants to `service_role`, `DELETE` granted only where retention allows.

**0. Self-host prerequisite port** — `workspace_departments`, `workspace_department_members` (verbatim from hosted `20260423182832`), and the four member-scoped tables named in §1, so both chains share the schema the invitation and offboarding logic needs.

**workspace_invitations (expanded).** Adds `first_name`, `last_name`, `invited_email_normalized`, `invited_phone_e164`, `member_type ('customer_facing'|'staff')`, `status ('pending'|'accepted'|'revoked'|'expired')`, `accepted_by`, `accepted_at`, `revoked_by`, `revoked_at`, `revoked_reason`, `expired_at`, `archived_at`, `notification_generation int NOT NULL DEFAULT 1`, `job_title`, `staff_code`, `last_email_status`, `last_sms_status`. Contract phase drops `token`, `max_uses`, `use_count`.
Constraints: `UNIQUE (id, workspace_id)`; partial unique `(workspace_id, invited_email_normalized) WHERE status='pending'` and the same for `invited_phone_e164` (no `now()` in any predicate — status really transitions); CHECKs for non-empty trimmed names, canonical email, `invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'`, `member_type` domain, `role <> 'owner'`, role ∈ the set allowed for its `member_type`, `expires_at > created_at`, and full state invariants — `pending` ⇒ no `accepted_at`/`revoked_at`/`expired_at`; `accepted` ⇒ `accepted_by` + `accepted_at` and no revoked fields; `revoked` ⇒ `revoked_by` + `revoked_at` + `revoked_reason`; `expired` ⇒ `expired_at`. `archived_at` is orthogonal to status.

**workspace_invitation_tokens.** `id, invitation_id, workspace_id, purpose ('email_claim'|'manual_handoff'), token_hash UNIQUE, token_prefix, token_generation int, notification_generation int, expires_at, consumed_at, revoked_at, created_at`. Partial unique `(invitation_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL`. Raw values never stored.

**workspace_invitation_otps.** `id, invitation_id, workspace_id, email_normalized, manual_token_id, manual_token_generation, notification_generation, purpose, code_digest, attempts, max_attempts, expires_at, consumed_at, revoked_at, ip_hash, created_at`. Digest = peppered HMAC bound to `(otp_id, invitation_id, workspace_id, email_normalized, manual_token_id, generations)` — same construction as `phoneVerification/crypto.ts`.

**workspace_invitation_proofs.** `id, otp_id, invitation_id, workspace_id, email_normalized, manual_token_id, manual_token_generation, notification_generation, purpose, proof_hash UNIQUE, expires_at (≤10 min), consumed_at, revoked_at, created_at`.

**workspace_invitation_departments.** `(invitation_id, workspace_id, department_id)`, PK `(invitation_id, department_id)`, `FK (invitation_id, workspace_id) → workspace_invitations(id, workspace_id) ON DELETE CASCADE`, `FK (department_id, workspace_id) → workspace_departments(id, workspace_id) ON DELETE RESTRICT` (both parents gain `UNIQUE (id, workspace_id)`).

**workspace_invitation_jobs (outbox, modelled on `channel_jobs`).** `id, invitation_id, workspace_id, channel ('email'|'sms'), notification_generation, email_token_generation, destination_hash, idempotency_key UNIQUE, status ('queued'|'claimed'|'provider_accepted'|'completed'|'retrying'|'permanently_failed'|'cancelled'|'unconfigured'), attempt_count, max_attempts, available_at, locked_by, locked_at, claim_token uuid, claim_expires_at, last_error, created_at, updated_at`. Payload is secret-free and contains **no raw token**.

**workspace_invitation_deliveries (append-only).** `id, invitation_id, workspace_id, job_id, channel, notification_generation, attempt_number, provider_name, provider_message_id, status, error_code, safe_error_message, created_at, provider_accepted_at, sent_at, delivered_at, failed_at, metadata`. `delivered` written only by a signature-verified provider webhook. Stub/unconfigured ⇒ `unconfigured`. No tokens, bodies or secrets. No UPDATE of historical rows other than webhook-driven terminal timestamps on the same attempt.

**workspace_member_details (active).** `workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id, joined_at, updated_at`. PK `(workspace_id, user_id)`; `FK (workspace_id, user_id) → workspace_members(workspace_id, user_id) ON DELETE RESTRICT`; `FK invitation_id → workspace_invitations(id) ON DELETE RESTRICT`.

**workspace_member_details_history (immutable snapshot).** Same descriptive columns plus `offboarded_at`, `offboarded_by`, `reason`. `workspace_id uuid NOT NULL → workspaces(id) ON DELETE CASCADE`; `user_id uuid NULL → profiles(id) ON DELETE SET NULL`; `invitation_id uuid NULL → workspace_invitations(id) ON DELETE SET NULL`. **No FK to `workspace_members`.** Readable only by owner/admin of that workspace and platform admins, through a server route. Retention: kept indefinitely unless a formal privacy/erasure job (existing `privacy_jobs` machinery) anonymizes it.

**legal_policy_versions (immutable).** `id, policy_type ('terms'|'privacy'), version, locale, content_hash, document_url, published_at, effective_from, is_active`, unique `(policy_type, version, locale)`. A trigger rejects any change to `version`/`content_hash`/`published_at`, and any delete, once referenced by a consent row.

**workspace_invitation_consents.** `id, user_id, workspace_id, invitation_id UNIQUE, terms_version_id, terms_content_hash, privacy_version_id, privacy_content_hash, accepted_at DEFAULT now(), ip, user_agent, locale, acceptance_method ('email_claim'|'manual_handoff_otp'|'existing_account')`. FKs to invitation and legal versions `ON DELETE RESTRICT`; no DELETE grant.

**workspace_invitation_idempotency.** `key UNIQUE (hash of actor_id|workspace_id|invitation_id|operation|client_request_id), operation, invitation_id, response_digest, created_at, expires_at (24h)`. Never stores raw tokens or links.

## 5. Token, generation, OTP and proof model

- **Manual handoff token** — generated by Express with ≥256-bit CSPRNG, base64url. Only `sha256(raw)` + prefix + expiry enter `create_workspace_invitation_v2`. Returned to the authorized manager exactly once in the create/rotate response; never stored, logged or audited.
- **Email claim token** — **does not exist at creation time.** It is derived by the invitation worker only after it exclusively claims the email job, as
  `HMAC-SHA-256(K, "workspace-invitation-email-token-v1" || invitation_id || job_id || notification_generation || email_token_generation || purpose)`, base64url, where `K = HKDF(INVITATION_LINK_SECRET, info="workspace-invitation-email-token-v1")`. Only `sha256(raw)` + prefix are persisted, at claim time. The raw value lives only in worker memory while rendering the email. Because the inputs and `K` are stable, **every retry of the same logical job reconstructs the identical token**, so a crash after provider acceptance never invalidates the already-delivered link and no plaintext storage is needed. `INVITATION_LINK_SECRET` is validated at startup (length/entropy, distinct from every other secret per the existing `assertDistinctSigningKey` pattern) and supports a `current/previous` key ring so a controlled rotation does not break already-sent, unexpired links; generation, deployment and rotation are documented in `SELF_HOST_GUIDE.md`.
- **Generations** — `notification_generation` on the invitation is the master counter; every token, OTP, proof, job and delivery row carries the generation it belongs to. `email_token_generation` distinguishes explicit resends within a generation.
- **Rotation rules** — email resend ⇒ new email job + new `email_token_generation`, previous email tokens revoked; it does **not** touch the manual link. Manual rotation ⇒ new manual token only; it does **not** resend email/SMS unless explicitly requested. Invited-email change ⇒ full generation bump (see §6). Accepting any token consumes it and revokes all sibling tokens, OTPs and proofs.
- **OTP** — CSPRNG 6 digits, peppered-HMAC digest only, 10-minute expiry, single use, max 5 attempts, 60 s resend cooldown, capped sends per invitation/window, previous OTP invalidated on resend, uniform responses that never reveal account existence, rate limits by IP + invitation + destination-email hash (+ workspace only after the token resolves). Bound to invitation, workspace, normalized email, manual token id, manual token generation, notification generation and purpose.
- **Proof** — minted only by successful OTP verification, bound to all of the above plus `otp_id`, unique `proof_hash`, short expiry, single use, locked and consumed inside the acceptance transaction. A proof from an older manual-link generation can never accept a newer link. Manual rotation, email change, revocation, expiration, acceptance and archival each revoke all associated OTPs and proofs atomically.
- **Comparison** — lookup is an indexed equality on the stored SHA-256 hash (not claimed to be constant-time); security rests on ≥256-bit entropy, hashing, expiry, rate limits and single-use. Application-level secret comparisons use `timingSafeEqual`.
- Delivery is **at-least-once** at the provider level; v4 guarantees idempotent logical content and single-use acceptance, not exactly-once email.

## 6. Atomic create / edit / resend / rotate RPCs

All are service_role-only, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, fully qualified, no dynamic SQL, revalidating actor membership and permission from the server-resolved actor id. No mutation is ever a sequence of independent PostgREST statements.

**`create_workspace_invitation_v2`** — one transaction: validate inviter membership + permission; validate role/member-type pairing (and the admin-invite rule); validate normalized email + E.164 phone; lazily expire stale pending rows for the same email/phone; check pending uniqueness; advisory capacity validation (blocked when full, no waitlist); insert invitation; insert departments; insert **only the manual_handoff token hash**; insert email + SMS jobs for generation 1; insert `queued` delivery rows; insert audit. Returns the safe invitation representation only. **No email token is created here.**

**`edit_workspace_invitation_v2`** — one transaction: lock invitation `FOR UPDATE`; confirm `pending` (lazily expire first); revalidate caller permission **against the resulting state** (an admin can neither create nor edit an invitation into `admin`, nor manage an existing admin invitation); replace departments atomically; when email and/or phone change: cancel all unclaimed jobs of the previous generation, revoke all prior email tokens, OTPs and proofs, increment `notification_generation`, update the normalized fields, insert new jobs and `queued` delivery rows; preserve historical delivery attempts; insert audit.

**Resend / rotate** — resend creates a new logical email job (new `email_token_generation`) and revokes the previous email generation; rotate mints a new manual token hash and revokes the previous manual token, its OTPs and proofs.

**Lock order everywhere:** workspace row → invitation row → token/OTP/proof rows → job rows. The worker uses the same order (it never locks an invitation before its workspace), so claiming and editing cannot deadlock.

**In-flight honesty:** a request already submitted to a provider cannot be recalled. In that rare race the old token is already revoked and unusable, no further retry goes to the old destination, and the event is audited without the address or token.

## 7. Department rules (database-enforced)

`customer_facing` ⇒ **at least one** department of the same workspace; `staff` ⇒ **exactly zero** departments. Enforced in UI, Express validation, RPC validation, and by an `INITIALLY DEFERRED` constraint trigger that fires from **both** sides — on `workspace_invitations` insert/update of `member_type`, and on insert/update/delete in `workspace_invitation_departments` — so it validates correctly at COMMIT of the single create/edit transaction. Cross-workspace departments are impossible via the composite FK. Acceptance copies the customer-facing assignments into `workspace_department_members` inside the same transaction.

## 8. Acceptance state machine

Two distinct service-role RPCs; no unique-violation fallback ever converts an unauthenticated flow into an existing-account acceptance.

**`accept_invitation_new_user_v2`** — allowed only when there is no profile, or a profile whose `user_credentials.password_hash IS NULL`. Steps: verify + lock invitation (workspace lock first); verify the presented token (`email_claim` or current `manual_handoff`); for manual, lock and verify the OTP proof; confirm token/proof generations are current; check expiry/revocation; enforce seat entitlement (§13); confirm no active password-protected account exists (else `ACCOUNT_EXISTS_LOGIN_REQUIRED`, changing nothing); create or reuse the allowed profile; insert/update `user_credentials` with the Argon2id hash produced by Express; set `user_credentials.email_verified_at = now()` **here** (the only place — a new user has no credential row at OTP time) and record the verification source (`workspace_invitation_email_claim` / `workspace_invitation_manual_otp`); create membership, member details, department assignments; record consent; mark the invitation accepted; consume the used token/proof; revoke all siblings. Plaintext passwords never leave Express — never sent to PostgreSQL, logs, audit or analytics.

**`accept_invitation_existing_user_v2`** — requires a valid `gs_session`-resolved user id, active account, session email equal to the invited normalized email, explicit current-version consent (never inferred from login), pending unexpired invitation and an available seat. The RPC re-checks that the passed actor really is the invited account and that the workspace operation matches.

Disabled/suspended/locked accounts fail closed in both paths.

## 9. Durable outbox and crash recovery

`workspace_invitation_jobs` + `claim_invitation_jobs(_worker_id,_limit,_lease_seconds,_channels)` mirroring `claim_channel_jobs` (`FOR UPDATE SKIP LOCKED`, `claim_token` nonce, `claim_expires_at` lease, service_role-only execute). States: `queued → claimed → provider_accepted → completed`, with `retrying`, `permanently_failed`, `cancelled`, `unconfigured`. Heartbeats reuse the `channel_worker_heartbeats` pattern; lease expiry returns a job to `queued`; every write asserts the worker still holds the matching `claim_token`. Exponential backoff, `max_attempts` then dead-letter `permanently_failed`. Immediately **before provider submission** the worker re-checks: invitation still pending, not expired, `job.notification_generation = invitation.notification_generation`, job not cancelled, destination hash matches the current generation, and its lease/claim token is still valid. Provider timeouts are treated as possibly-accepted (duplicate submission is possible; the deterministic token makes the duplicate harmless). Webhooks are signature-verified before writing `delivered` or provider failure, correlated by `provider_message_id`. Graceful shutdown releases claims. Exactly one execution mode processes jobs: `WORKER_KIND=invitations`, or the single-container in-process fallback, selected by a server setting whose startup validation rejects both being configured as primary; the claim mechanism stays safe even if both accidentally run. Provider acceptance is never labelled delivered; stub/unconfigured is never success; email/SMS failure never deletes or revokes the invitation, and the owner sees the true state and can retry.

## 10. Canonical API and error codes

`server/routes/workspaceInvitations.ts`:

| Route | Caller / authority | Transaction | Idempotency | Returns |
| --- | --- | --- | --- | --- |
| `POST /` | owner/admin via `gs_session` + `manage:true` | create RPC | operation key | safe invitation + manual link **once** |
| `GET /?workspaceId=` | owner/admin | read | – | safe list (prefix only, no hashes) |
| `GET /:id` | owner/admin | read | – | safe detail + delivery history |
| `PATCH /:id` | owner/admin (resulting-state check) | edit RPC | operation key | safe invitation |
| `POST /:id/resend` | owner/admin | edit-family RPC | operation key | new generation info |
| `POST /:id/rotate-link` | owner/admin | rotate RPC | operation key | new manual link **once** |
| `POST /:id/revoke` | owner/admin | revoke RPC | operation key | ok |
| `POST /:id/archive` | owner/admin | archive RPC | operation key | ok |
| `GET /preview?token=` | token possession + IP/global rate limit | read | – | masked preview |
| `POST /otp/request`, `POST /otp/verify` | token possession + layered limits | OTP RPCs | operation key | generic status / proof handle |
| `POST /accept-new` | token (+proof) possession | accept RPC | operation key | session or login-required |
| `POST /accept-existing` | `gs_session` | accept RPC | operation key | session state |

Errors: `INVITATION_NOT_FOUND` (uniform for invalid/expired/revoked/consumed/unknown at public endpoints), `INVITATION_DUPLICATE` (409), `INVITATION_NOT_PENDING`, `ACCOUNT_EXISTS_LOGIN_REQUIRED`, `ACCOUNT_DISABLED`, `EMAIL_PROOF_REQUIRED`, `OTP_INVALID`, `OTP_RATE_LIMITED`, `CONSENT_REQUIRED`, `SEAT_LIMIT_REACHED`, `ENTITLEMENT_UNAVAILABLE` (503), `SESSION_CREATE_FAILED_LOGIN_REQUIRED`, `FORBIDDEN_ROLE_ESCALATION`.

Legacy `/api/workspace-members/invitations*` and `/accept-invitation` return `410 Gone`, then are deleted; `get_invitation_info`, `accept_workspace_invitation_as` and `accept_workspace_invitation` are dropped in the contract migration.

**Idempotency:** every mutation takes/derives `key = hash(actor_id|workspace_id|invitation_id|operation|client_request_id)`. Replaying the same key returns the same logical result; a new client request id is a genuine new operation (so later resends work); double-clicks create no duplicate jobs; network retries never rotate twice. Records store only a response digest, expire after 24 h, and never contain raw tokens — a lost rotate response therefore requires another rotation, which is documented in the UI.

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

Enforced twice: in Express from `gs_session`, and again inside each RPC from the server-resolved actor id against real membership — always against the **resulting** state, never merely the original role. Customer-facing invitations may use only agent/support_agent/sales_agent/team_lead; staff invitations use the staff role set.

## 12. Frontend flows

`InvitePage.tsx` rewritten against the Express endpoints (no `supabase.rpc`/`supabase.from`): masked preview → (manual link, new user) OTP step → password + confirm + unchecked consent with versioned terms/privacy links → accept → workspace. States: loading, invalid/expired/revoked (uniform copy), otp_required, otp_locked, ready, accepting, seat_limit_reached (retry later), account_exists_login_required, wrong_account, session_failed_login_required, accepted. Existing accounts are routed to login with the invite redirect preserved and still see an explicit consent checkbox when their accepted legal versions are stale. Token hygiene: `Referrer-Policy: no-referrer`, `history.replaceState` immediately after reading the token, memory/sessionStorage only, cleared on accept/expire/revoke/logout, never in toasts, analytics, error tracking or logs.

Management UI (create dialog with all required fields, pending/archived filters, delivery history per attempt, expiry, edit/resend/rotate/revoke/archive, copy-link with verified clipboard, seat-limit messaging, "invite again" prefill for expired/revoked rows) lands in `StaffAccessPage.tsx` (staff) and `TeamDepartmentsPage.tsx` (customer-facing); hidden for non-managers with the backend as final authority. `TeamPage.tsx` keeps only its redirect. fa/en/tr strings, RTL respected.

## 13. Seat locking and entitlement

Every seat-creating path locks the same row: `SELECT id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE` before counting and inserting. Paths: the two acceptance RPCs (new), `create_workspace_atomic` (documented bootstrap — brand-new workspace with exactly its owner; gains the lock for uniformity), and the legacy accept RPCs (dropped in contract). A CI guard scans both chains for `INSERT INTO ... workspace_members` and fails any statement not inside a function containing the workspace lock. `max_agents` is resolved **inside the transaction** from the authoritative subscription/entitlement tables (with the server-side `SELF_HOST_BILLING_MODE=unlimited` setting as the only unlimited source); an unresolvable entitlement raises → `503 ENTITLEMENT_UNAVAILABLE`, never unlimited.

Order: identify invitation from token hash → read workspace id from the invitation → lock workspace → lock invitation → re-check token/status/generation/expiry/revocation → resolve entitlement → count seats → enforce → resolve/create allowed account → membership/details/departments → consent → accept → consume token/proof and revoke siblings.

Pending invitations reserve nothing. Creation is blocked when the workspace is already full (no waitlist). If capacity fills later, acceptance returns `SEAT_LIMIT_REACHED` **without consuming the token, proof or consent**, and the same unexpired invitation can be retried once a seat is freed or the plan upgraded.

## 14. Expiration and archival

An idempotent janitor (same worker) flips due `pending` rows to `expired` (setting `expired_at`), revokes their tokens/OTPs/proofs and cancels their queued jobs, with an audit event; lazy expiry also runs before every uniqueness check, list, preview, resend, rotate and accept. Expired/revoked invitations never return to pending — "invite again" creates a **new** row with a new id, new tokens, new consent lifecycle and new audit history, optionally prefilled in the UI from the old row. Pending invitations are revoked (never hard-deleted by default); revoked/expired ones may be archived (hidden from the default list, visible under an archived filter, tokens permanently unusable); accepted ones may only be archived. Invitations, consents, deliveries, member-history snapshots and audit records are never hard-deleted by ordinary management; a permanent purge exists only inside the formal privacy/retention process (`privacy_jobs`) with its FK consequences documented there.

## 15. Consent and legal versions

Immutable `legal_policy_versions`; the backend/database selects the effective terms and privacy versions. Every acceptance — including existing-account acceptance — shows an explicit unchecked checkbox and records an invitation-specific consent row with user, workspace, invitation, terms version + content hash, privacy version + content hash, locale, server timestamp, trusted client IP (`server/utils/clientIp.ts` proxy rules), user agent and acceptance method. Referenced versions and hashes cannot be edited or deleted. Marketing consent is separate and never implied.

## 16. Offboarding and retention matrix

`offboard_workspace_member(...)`, service_role only: lock workspace → resolve target inside that workspace → protect the canonical `workspaces.owner_id` (never removable or demotable, by anyone) → snapshot `workspace_member_details` into `workspace_member_details_history` → delete active details → delete `workspace_members` → delete only verified workspace-scoped rows → revoke matching pending invitations and their tokens/OTPs/proofs/jobs → audit.

| Data | Action |
| --- | --- |
| `workspace_member_details` | snapshot then delete |
| `workspace_members` | delete |
| `workspace_department_members` | delete (workspace+user scoped, verified) |
| `call_center_department_agents` | delete (workspace+user scoped, verified) |
| `operator_call_availability` | delete (workspace+user scoped, verified) |
| `user_availability_prefs` | delete **only** `workspace_id = target` — the nullable-workspace global row is preserved |
| `user_notification_prefs` | delete rows for this workspace only |
| pending invitations matching work email/phone + tokens/OTPs/proofs/jobs | revoke / cancel |
| `role_permissions` | untouched (shared role definitions) |
| accepted invitations, consents, deliveries, history, audit | retained |
| global `profiles` / `user_credentials`, other workspaces | untouched |

Because four of these tables are hosted-chain-only today, the prerequisite port in §4 lands them in the self-host chain first; the RPC therefore references only tables that exist in **both** chains after the migration — no `to_regclass` guessing. Removed members lose authorization immediately through the existing server-side membership checks.

## 17. RLS, grants, SECURITY DEFINER and secrets

Every new table: RLS on, zero client policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, minimal `service_role` grants, `DELETE` withheld on consents/deliveries/audit/history. Every new function: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, fully qualified references, no dynamic SQL, `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE TO service_role`, internal tenant/identity validation, and an in-migration `DO $verify$` proof asserting the privileges (mirroring `043`). Secrets never returned or logged: `INVITATION_LINK_SECRET`, `PHONE_VERIFICATION_PEPPER`, service-role key, raw manual/email tokens, OTP codes, proof values, Argon2 inputs.

## 18. `/api/email/send` closure

Browser invitation-email callers are removed. `POST /api/email/send` stops accepting arbitrary `to`/`subject`/`html` and is replaced by `POST /api/email/test-send`: owner/admin only, fixed server-rendered template, recipient restricted to a verified workspace address. `/send-channel` and `sendChannelEmail()` remain unchanged. Ordinary members can no longer relay mail.

## 19. Migration, feature flag, cutover, recovery

1. Expand additively (prerequisite port + all new objects + privileges). Verify: both chains apply, in-migration proofs pass, legacy flow unaffected. Abort → drop new objects.
2. Deploy the backend with `INVITATIONS_V4` disabled and the new worker kind available. Verify: health, old flow green.
3. Deploy the compatible frontend. Verify: no regressions.
4. Start and verify the invitation worker (heartbeat, claim, backoff).
5. Enable `INVITATIONS_V4`. Verify end-to-end: create → email → SMS → OTP → accept → offboard.
6. Enable the DB legacy-write/accept fence (triggers rejecting plaintext-token inserts and legacy accept RPC calls).
7. Return `410 Gone` from legacy HTTP routes; revoke all remaining plaintext invitations.
8. Monitor delivery failures, stuck jobs, seat and OTP errors.
9. Run the contract migration (drop `token`, `max_uses`, `use_count`, `get_invitation_info`, both legacy accept RPCs).

After step 6, rollback to an insecure build is **not** supported: recovery is forward-fix or rollback to a compatible fenced build. This is not claimed to be universally zero-downtime — steps 6–7 may make invitation management unavailable for a few minutes while the rest of the application stays up. Documented in `docs/DEPLOYMENT.md`, `database/README.md`, `SELF_HOST_GUIDE.md`; both chains stay drift-free.

## 20. Tests (real PostgreSQL for transactions, constraints, locks, concurrency, privileges)

**Token ownership/timing:** create RPC inserts a manual hash and no email token; worker creates the email token only after claiming; same job retry reconstructs the identical token; raw deterministic token never persisted; explicit resend makes a new generation and revokes the previous email generation; manual rotation leaves the email generation untouched and vice versa.
**Crash recovery:** provider accepts → worker crashes → retry sends the same valid link; duplicate provider submission cannot create duplicate membership; lease expiry never yields an incompatible token; current/previous key ring validates already-sent links during rotation.
**OTP/proof:** new-user OTP does not touch nonexistent credentials; `email_verified_at` is written during successful acceptance only; proof bound to invitation/email/manual token/generations; rotation and email edit invalidate old OTPs and proofs; seat failure consumes neither proof nor token; proof replay fails; `proof_hash` uniqueness enforced.
**Edit/jobs:** email edit cancels queued old-generation jobs; worker refuses cancelled/stale-generation jobs; admin cannot edit an invitation into admin nor manage an admin invitation; delivery history immutable; in-flight provider race leaves the old token unusable.
**Departments:** customer-facing with zero departments fails at commit; staff with any department fails at commit; cross-workspace department rejected; atomic replacement never commits an invalid state.
**History/retention:** snapshot survives membership deletion; nullable history FKs behave; accepted invitation cannot be hard-deleted; consent/delivery/audit survive archival and offboarding; shared role definitions and other workspaces untouched.
**Idempotency:** same create/resend/rotate request id does not duplicate; a new request id creates a legitimate new generation; acceptance retry duplicates no membership, consent or audit.
**Seats/entitlement:** two different invitations of one workspace accepted concurrently cannot exceed `max_agents`; every seat path takes the workspace lock (plus CI guard); entitlement failure → 503; `SEAT_LIMIT_REACHED` retryable.
**Security:** no raw token/OTP/proof/password in rows, logs, audits, analytics or ordinary responses; anon/authenticated cannot read any new table or execute any new RPC; preview leaks only masked PII; existing password account cannot accept via `accept-new`; concurrent profile creation fails to login-required; legacy plaintext creation blocked after the fence; ordinary member cannot relay mail; session-creation failure yields login recovery without duplicate membership; no GoTrue/Supabase Auth/`auth.uid()`/edge-function dependency introduced; widget runtime and build byte-unchanged.

## 21. Out of scope

Embedded chat widget runtime and build; AI, Calls, Channels, Inbox and Billing beyond the entitlement read; ownership transfer; SSO/social login; marketing-consent management; new SaaS dependencies or edge functions. One new secret (`INVITATION_LINK_SECRET`) is introduced deliberately and justified in §1/§5.

## 22. Remaining assumptions

- The hosted chain's `workspace_departments`/`workspace_department_members` definitions (`20260423182832`) can be ported verbatim into the self-host chain; the port is re-verified column-by-column when written.
- Localized terms/privacy documents exist to seed the first `legal_policy_versions` rows (content hash taken from the shipped documents at migration time).

The three former product decisions are now resolved: expired/revoked ⇒ always a new invitation; staff ⇒ exactly zero departments; seat-full ⇒ creation blocked, no waitlist.

## 23. Readiness verdict

All v3 contradictions are resolved in this document: the create RPC inserts **only** the manual token and the worker is the sole creator of the email token; retry safety comes from deterministic HMAC derivation with zero raw-token storage; `email_verified_at` is written during acceptance, never at OTP time; OTPs and proofs are bound to exact manual-token and notification generations; edits bump the generation and cancel unclaimed jobs while admitting that in-flight provider requests cannot be recalled; archival and FK actions are mutually consistent (history has no membership FK, consents are RESTRICT, nothing is hard-deleted); the permission matrix is enforced against resulting state on edits; public routes take authority from scoped tokens plus rate limits rather than `gs_session`; and the deployment fence is honest about rollback. Authentication remains fully self-hosted (`profiles`, `user_credentials`, `auth_sessions`, Argon2id, `gs_session`, `authorizeWorkspaceAccess`) with no GoTrue, no Supabase Auth identity, no `auth.uid()`, no edge functions; all privileged logic runs in Express and service-role-only, search_path-pinned RPCs; the browser holds no privileged RPC and no raw email route; and the embedded widget is untouched. **Safe to implement** once this plan is approved.
