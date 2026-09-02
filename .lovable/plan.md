# Workspace Invitations — Final Production-Ready Redesign v3

## 1. Verified current-state findings (re-traced)

- `server/routes/workspaceMembers.ts` — invitation CRUD (`GET/POST/PATCH/DELETE /invitations`) + `POST /accept-invitation`. `GET /invitations` uses `select('*')`, so the **plaintext token is returned to any workspace member**; listing is not manage-gated. Create sets `max_uses: 0` (unlimited use), takes only role/email/expiry.
- `database/migrations/042_workspace_invitations.sql` — `workspace_invitations` stores the **raw token** (`token text DEFAULT encode(gen_random_bytes(32),'hex')`), plus `max_uses`, `use_count`, nullable `expires_at`; no names, phone, status, departments or consent. Defines `get_invitation_info(text)` (anon-executable, reads `auth.uid()` → always NULL under first-party auth) and `accept_workspace_invitation_as(text, uuid)` (service_role only).
- `src/pages/auth/InvitePage.tsx` — calls `supabase.rpc('get_invitation_info')` from the browser; accept goes to the Express route. No password-setup flow: the invitee must already have an account.
- Seat limit: `requireLimit('max_agents', usageFnForLimit('max_agents'))` runs as **middleware outside** the accept transaction → concurrent accepts overshoot.
- **Mail relay hole:** invitation email HTML is built in the browser and POSTed to `/api/email/send` from `src/pages/app/settings/TeamDepartmentsPage.tsx:852` and `src/pages/app/TeamPage.tsx:200`; `server/routes/email.ts` only checks workspace membership (`authorizeWorkspaceAccess` without `manage`). Third caller: `src/providers/email/api.ts` (admin test send). `send-channel` + `sendChannelEmail()` are separately gated (`docs/EMAIL_SURFACE_SPLIT.md`).
- **Seat-creation paths found** (all must share one lock): `accept_workspace_invitation_as` (042:230), `create_workspace_atomic` (039:145 self-host / `20260415075435` hosted, workspace bootstrap), and the hosted-only legacy `accept_workspace_invitation` (`20260415100153`, `20260622110429`). No server route inserts `workspace_members` directly; `workspace_members` already has `UNIQUE (workspace_id, user_id)` (001:65).
- **Worker infra exists:** `worker/index.ts` dispatches by `WORKER_KIND` (`intelligence|source-sync|file-ingest|regression-runner|channels|all`); `database/migrations/048_plugin_platform_and_channels.sql` already implements a durable outbox with `FOR UPDATE SKIP LOCKED` claim RPCs (`claim_channel_jobs`) and heartbeats. This is the model v3 reuses — a durable outbox is available, so the conditional wording is removed.
- `role_permissions` (hosted `20260422211113`) is `(workspace_id, role_slug, permission_key, granted)` — a **shared role definition table, not user data**. v2's plan to delete from it during offboarding was wrong and is removed.
- Reusable primitives: `server/services/auth-email.ts` (`resolveAppBaseUrl`, SHA-256 token hashing, localized server templates), `auth_verify_tokens`/`auth_reset_tokens` (hash-only, `used_at`/`revoked_at` — the exact shape v3's token table copies), `server/services/phoneVerification/crypto.ts` (peppered HMAC OTP digests, `timingSafeEqual`, attempt caps — the OTP model v3 reuses), `server/middleware/security.ts` rate limiters, `server/utils/clientIp.ts`, `audit_logs`.

## 2. Final data model

New self-host migration (number chosen from the real latest file, currently `075`) mirrored into `supabase/migrations` **after diffing both chains** for `workspace_invitations`, `workspace_members`, `workspace_departments`, `role_permissions`; drift reconciled in the same migration.

### workspace_invitations (expanded)
Adds `first_name`, `last_name`, `invited_email_normalized`, `invited_phone_e164`, `member_type ('customer_facing'|'staff')`, `status ('pending'|'accepted'|'revoked'|'expired')`, `accepted_by`, `accepted_at`, `revoked_by`, `revoked_at`, `revoked_reason`, `expired_at`, `archived_at`, `job_title`, `staff_code`, `last_email_status`, `last_sms_status`. Contract phase drops `token`, `max_uses`.
- `UNIQUE (id, workspace_id)` (composite-FK target).
- Partial unique `(workspace_id, invited_email_normalized) WHERE status='pending'`, same for `invited_phone_e164`. No `now()` in any predicate — expiry really transitions status.
- CHECKs: non-empty trimmed names; canonical email; `invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'`; `member_type` domain; `role <> 'owner'`; role ∈ set allowed for its `member_type`; `expires_at > created_at`; state invariants — `pending` ⇒ no `accepted_at`/`revoked_at`/`expired_at`; `accepted` ⇒ `accepted_by` + `accepted_at`, no revoked fields; `revoked` ⇒ `revoked_by` + `revoked_at` + reason; `expired` ⇒ `expired_at`. `archived_at` is orthogonal to status.
- Department minimum for `customer_facing` is enforced by an **INITIALLY DEFERRED** constraint trigger, which is correct because creation is a single RPC transaction (§3).

### workspace_invitation_tokens
`id, invitation_id, workspace_id, purpose ('email_claim'|'manual_handoff'), token_hash, token_prefix, generation, expires_at, consumed_at, revoked_at, created_at`. Unique `token_hash`; partial unique `(invitation_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL`. Raw token never stored.

### workspace_invitation_otps
`id, invitation_id, workspace_id, email_normalized, code_digest, attempts, max_attempts, expires_at, consumed_at, revoked_at, created_at, ip_hash`. Digest = peppered HMAC bound to `(otp_id, invitation_id, email)`, same construction as `phoneVerification/crypto.ts`.

### workspace_invitation_proofs
Short-lived single-use server-side proof minted by a successful OTP verification (`id, invitation_id, proof_hash, expires_at, consumed_at`), verified inside the acceptance RPC.

### workspace_invitation_departments
`(invitation_id, workspace_id, department_id)`, PK `(invitation_id, department_id)`,
`FK (invitation_id, workspace_id) → workspace_invitations(id, workspace_id) ON DELETE CASCADE`,
`FK (department_id, workspace_id) → workspace_departments(id, workspace_id) ON DELETE RESTRICT`
(both parents gain `UNIQUE (id, workspace_id)`).

### workspace_member_details (active employment, workspace-scoped)
`workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id, joined_at, updated_at`. PK `(workspace_id, user_id)`; `FK (workspace_id, user_id) → workspace_members(workspace_id, user_id) ON DELETE RESTRICT`; `FK invitation_id → workspace_invitations(id) ON DELETE RESTRICT`. Global `profiles` of an existing account are never overwritten.

### workspace_member_details_history (resolves the v2 FK contradiction)
On offboarding the active row is **copied here and deleted**, then the membership is deleted. History references `workspace_id → workspaces(id) ON DELETE CASCADE`, `user_id → profiles(id) ON DELETE SET NULL`, `invitation_id → workspace_invitations(id) ON DELETE SET NULL` — never `workspace_members`. Columns add `offboarded_at`, `offboarded_by`, `reason`.

### legal_policy_versions (immutable)
`id, policy_type ('terms'|'privacy'), version, locale, content_hash, document_url, published_at, effective_from, is_active`. Unique `(policy_type, version, locale)`. An UPDATE/DELETE trigger rejects any change to `version`/`content_hash`/`published_at` once referenced by a consent row.

### workspace_invitation_consents
`id, user_id, workspace_id, invitation_id UNIQUE, terms_version_id, terms_content_hash, privacy_version_id, privacy_content_hash, accepted_at DEFAULT now(), ip, user_agent, locale, acceptance_method ('email_claim'|'manual_handoff_otp'|'existing_account')`. FKs to invitation and legal versions are `ON DELETE RESTRICT`. Server picks the effective versions; IP from `server/utils/clientIp.ts` trusted-proxy rules; UA from headers. Marketing consent is not stored here.

### workspace_invitation_deliveries (append-only)
`id, invitation_id, workspace_id, channel ('email'|'sms'), attempt_number, purpose, provider_name, provider_message_id, status ('queued'|'claimed'|'provider_accepted'|'sent'|'retrying'|'failed'|'permanently_failed'|'delivered'|'unconfigured'), error_code, safe_error_message, created_at, accepted_at, sent_at, delivered_at, failed_at, metadata`. `delivered` only from a verified provider webhook. Stub/unconfigured ⇒ `unconfigured`, never success. No tokens, no bodies, no secrets.

### workspace_invitation_outbox
Modelled on `channel_jobs` (048): `id, invitation_id, workspace_id, channel, idempotency_key UNIQUE, attempts, max_attempts, run_after, claimed_at, claimed_by, completed_at, failed_at, last_error, payload` — payload holds **no raw token**; the worker mints the `email_claim` token when it owns the job and stores only the hash.

### Privileges (every new table)
`REVOKE ALL ... FROM PUBLIC, anon, authenticated;` `GRANT SELECT, INSERT, UPDATE ON ... TO service_role;` (DELETE only where the retention matrix allows). RLS enabled with zero client policies **in addition to** the revokes. Every SECURITY DEFINER function: `SET search_path = public, pg_temp`, `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE TO service_role`, fully qualified table references, all tenant/identity/consent/capacity inputs validated internally.

## 3. Atomic creation and edit RPCs

`public.create_workspace_invitation_v2(...)` — service_role only, one transaction: validate workspace + inviter permission (re-checked in SQL, not trusted from the route), validate role/member_type pairing, validate normalized email/phone, lazily expire stale pending rows for the same email/phone, check uniqueness, advisory seat-capacity check (§9), insert invitation, insert departments, insert both token hash rows, insert outbox jobs, insert initial `queued` delivery attempts, insert the audit row. Returns only the safe invitation representation; the raw `manual_handoff` value is generated by the backend CSPRNG (32 bytes, base64url ≥256 bits) and returned once by the route — only its SHA-256 hash + prefix enter the RPC.

`public.edit_workspace_invitation_v2(...)` — same transaction discipline for edits: field updates, full department replacement, and, when email/phone change, revocation of all existing tokens plus insertion of new `email_claim` + `manual_handoff` hashes, new outbox jobs, new delivery attempts, and an audit row. Old delivery attempts stay bound to the old contact data. Unique conflicts surface as `409 INVITATION_DUPLICATE`. Only `pending` invitations can be edited/resent/rotated/accepted. No multi-statement PostgREST sequences anywhere in this flow.

## 4. Acceptance state machine (strictly separated)

Server resolves state before any write; no unique-violation fallback ever converts an unauthenticated flow into an existing-account acceptance.

| State | Path | Behavior |
| --- | --- | --- |
| No profile | `accept-new` | Requires mailbox proof (email_claim token, or manual_handoff + OTP proof), password policy pass, explicit consent → `accept_invitation_new_user_v2` creates profile + Argon2id credentials + membership + details + departments + consent atomically |
| Profile, `password_hash IS NULL` | `accept-new` (setup mode) | Same proof requirement; sets the password on the **existing** profile, never duplicates it |
| Profile with active credential | `accept-new` | Hard stop → `ACCOUNT_EXISTS_LOGIN_REQUIRED`; user must log in |
| Authenticated session | `accept-existing` | `accept_invitation_existing_user_v2`, user id resolved **only** from `gs_session`; session email must equal the invited email, else Wrong Account screen |
| Disabled/suspended/locked (`user_credentials.status`) | any | Fail closed |

`userId`, `profileId`, session identity, verification state, role authority, `max_agents` and consent versions are **never** read from the request body. Two distinct service-role RPCs keep the boundary explicit. A profile appearing concurrently during a new-user accept returns `ACCOUNT_EXISTS_LOGIN_REQUIRED`, not a silent bind. Existing-account acceptance does **not** auto-record consent: if that user has not accepted the currently effective versions, the UI shows an explicit unchecked checkbox first.

## 5. Token and OTP lifecycle

- Tokens: ≥256-bit CSPRNG, base64url, SHA-256 hashed, indexed lookup by hash (an indexed equality lookup is *not* claimed to be constant-time; security rests on entropy, hashing, expiry, rate limits and single use). Application-level secret comparisons use `timingSafeEqual`.
- `email_claim` exists only inside the invitation email and is never returned by any API. `manual_handoff` is shown to the owner exactly once (create/rotate response). Consuming either accepts the invitation and revokes all other tokens of that invitation. Resend rotates `email_claim` only; rotate-link rotates `manual_handoff` only.
- OTP (manual link, new user): CSPRNG 6 digits, peppered-HMAC digest only, 10-minute expiry, single use, max 5 attempts, 60-second resend cooldown, max sends per invitation/window, previous OTP invalidated on resend, generic responses that never reveal account existence, rate limits by IP + invitation + destination email hash (+ workspace only after the token resolves). Success mints a short-lived single-use proof consumed inside the acceptance RPC and updates the project's canonical verification state (`user_credentials.email_verified_at`, source `workspace_invitation_email_claim`) — no second verification system.
- SMS is notification-only, carries no link, and never changes phone-verification state.

## 6. Notification architecture (one model, chosen)

Durable DB-backed outbox reusing the proven `channel_jobs` pattern from 048, run by a new `WORKER_KIND=invitations` loop in `worker/index.ts` (plus an in-process fallback ticker for single-container self-host installs, controlled by one server setting — never both active). Jobs are claimed with `FOR UPDATE SKIP LOCKED` via a service-role RPC, keyed by a stable idempotency key, retried with backoff and a max-attempt cap into `permanently_failed`. The worker mints the raw `email_claim` token at claim time, persists the hash atomically, builds the link in memory from `resolveAppBaseUrl(config)`, and sends via the existing email/SMS provider abstractions; retries revoke the previous generation so multiple valid email links can never coexist. Every attempt appends a delivery row; provider acceptance ≠ sent ≠ delivered. Provider failure never deletes or revokes the invitation; the owner sees the real state and can retry.

## 7. Canonical API + stable error codes

`server/routes/workspaceInvitations.ts` — `POST /`, `GET /?workspaceId=`, `GET /:id`, `PATCH /:id`, `POST /:id/resend`, `POST /:id/rotate-link`, `POST /:id/revoke`, `DELETE /:id` (archive when accepted), `GET /preview?token=`, `POST /otp/request`, `POST /otp/verify`, `POST /accept-new`, `POST /accept-existing`.

For every route: caller = owner/admin (or platform super admin) via `authorizeWorkspaceAccess(..., { manage: true })` for management, public+token for preview/OTP/accept-new, `gs_session` for accept-existing; identity source = `gs_session` only; transaction boundary = one service-role RPC per mutation; idempotency = invitation-scoped keys on accept/resend; returned data excludes tokens, hashes, OTPs and internal user ids; secrets never logged.

Error codes: `INVITATION_NOT_FOUND` (uniform for invalid/expired/revoked/consumed/unknown at preview), `INVITATION_DUPLICATE` (409), `ACCOUNT_EXISTS_LOGIN_REQUIRED`, `ACCOUNT_DISABLED`, `EMAIL_PROOF_REQUIRED`, `OTP_INVALID`, `OTP_RATE_LIMITED`, `CONSENT_REQUIRED`, `SEAT_LIMIT_REACHED`, `ENTITLEMENT_UNAVAILABLE` (503), `SESSION_CREATE_FAILED_LOGIN_REQUIRED`.

Legacy paths (`/api/workspace-members/invitations*`, `/accept-invitation`) return `410 Gone`, then are deleted; `get_invitation_info` and both legacy accept RPCs are dropped in the contract migration.

## 8. `/api/email/send` fix

The two browser invite callers disappear (backend sends invitation mail). `POST /api/email/send` stops accepting arbitrary `to`/`subject`/`html` and is replaced by `POST /api/email/test-send`: owner/admin only, fixed server-rendered template, recipient restricted to a verified workspace address. `send-channel` and `sendChannelEmail()` are untouched; in-process platform mail is untouched. A security test proves an ordinary member cannot relay mail.

## 9. Seat concurrency

One canonical locking discipline: **every** seat-creating path takes `SELECT id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE` before counting and inserting. Paths: the two new acceptance RPCs (new), `create_workspace_atomic` (documented specialized bootstrap — a brand-new workspace with exactly its owner; it gains the lock for uniformity), and the legacy accept RPCs (dropped). A CI guard greps both migration chains for `INSERT INTO ... workspace_members` and fails on any statement that is not inside a function containing the workspace lock. The authoritative `max_agents` is resolved **inside the transaction** from the subscription/entitlement tables; if it cannot be resolved the RPC raises and the route returns `503 ENTITLEMENT_UNAVAILABLE` — never "unlimited". Self-host unlimited comes only from the existing server-side setting (`-1`).

Order inside acceptance: resolve+validate token → read `workspace_id` from the invitation → lock workspace → lock invitation → re-check pending/expiry/revocation/single-use → resolve limit → count members → enforce limit → resolve/create account → membership + details + departments → consent → mark accepted, consume token, revoke siblings.

Seat behavior at creation: advisory capacity check; if the workspace is already at its hard limit, creation is blocked with a clear error (no waitlist). Pending invitations reserve nothing. If capacity fills before acceptance, acceptance returns `SEAT_LIMIT_REACHED` **without consuming the token, OTP proof or consent**, and the same invitation stays valid for a retry once a seat is freed or the plan upgraded (explained in the owner UI).

## 10. Expiration

`expired_at` is set by a real status transition: an idempotent janitor loop (same worker) flips due `pending` rows to `expired` and revokes their tokens with an audit event; lazy expiry also runs **before** every uniqueness check, preview, list, resend and accept. Expired/revoked invitations never return to pending — a new invitation must be created.

## 11. Preview privacy

Before mailbox proof: masked email, masked phone, workspace name, inviter display name, role/member type, department names, expiry. No internal user ids, no token prefixes, no delivery internals. Invalid/expired/revoked/consumed/unknown tokens all return the same public error; the real reason goes only to token-free audit logs. After a valid `email_claim`, the full invited email may be shown.

## 12. Frontend

`InvitePage.tsx` rewritten against the Express endpoints (no `supabase.rpc`/`supabase.from`): preview → (manual link, new user) OTP step → password + confirm + consent checkbox (default off, submit disabled until checked, clickable versioned terms/privacy links) → accept → redirected into the workspace. Existing account → login with the invite redirect preserved; mismatch → Wrong Account screen. Token handling: `Referrer-Policy: no-referrer`, token stripped from the URL via `history.replaceState` immediately after reading, kept in memory/sessionStorage only, cleared on accept/expire/revoke/logout, never in toasts, analytics, error tracking or logs.

Management UI (create dialog with all required fields, pending list, per-channel delivery history, expiry, edit/resend/rotate/revoke/archive, copy-link with real clipboard verification, seat-limit messaging) lands in `StaffAccessPage.tsx` (staff) and `TeamDepartmentsPage.tsx` (customer-facing), hidden for non-managers with the backend as final authority. `TeamPage.tsx` keeps only its redirect. fa/en/tr strings, RTL respected.

## 13. Permission matrix

| Action | Owner | Admin | Agent/Viewer/other | Platform super admin |
| --- | --- | --- | --- | --- |
| Create invitation (non-admin roles) | ✔ | ✔ | ✖ | ✔ |
| Create invitation with `role='admin'` | ✔ | ✖ | ✖ | ✔ |
| Invite `role='owner'` | ✖ | ✖ | ✖ | ✖ |
| List / view / edit / resend / rotate / revoke / archive | ✔ | ✔ | ✖ | ✔ |
| Promote a member to admin | ✔ | ✖ | ✖ | ✔ |
| Remove member | ✔ | ✔ (non-admin targets only) | ✖ | ✔ |
| Remove/demote canonical owner | ✖ | ✖ | ✖ | ✖ |

Customer-facing invitations use only customer-facing roles (agent, support_agent, sales_agent, team_lead) and require ≥1 department; staff invitations use staff roles and take none.

## 14. Offboarding + retention matrix

`public.offboard_workspace_member(...)` — service_role only; locks the workspace, resolves the target **inside** that workspace, reads `workspaces.owner_id` and refuses to remove or demote the canonical owner regardless of caller.

| Data | Action |
| --- | --- |
| `workspace_member_details` | snapshot → `workspace_member_details_history`, then delete |
| `workspace_members` | delete |
| `workspace_department_members` | delete |
| `call_center_department_agents` | delete (verified workspace+user scoped) |
| `operator_call_availability`, `user_availability_prefs` (this workspace) | delete |
| `user_notification_prefs` (this workspace) | delete |
| pending invitations matching the work email/phone + their tokens | revoke |
| `role_permissions` | **untouched** — shared role definitions, not user data |
| accepted invitations, consents, deliveries, audit logs | retained (immutable) |
| global `profiles`/`user_credentials`, other workspaces | untouched |

Only tables present in both authoritative chains are referenced; anything else uses `to_regclass` guards. Removed members immediately lose authorization through the existing server-side membership checks. Audit row written.

## 15. Post-commit session failure

Acceptance commits first; `gs_session` creation is attempted afterwards. On failure nothing is rolled back or duplicated: the route returns `SESSION_CREATE_FAILED_LOGIN_REQUIRED` and the user logs in with the password just set. Retrying a consumed invitation cannot create a second membership (token consumed + `UNIQUE (workspace_id, user_id)`), and acceptance is audited once via an idempotency key, not once per HTTP retry.

## 16. Migration, feature flag, cutover, rollback

1. **Expand** — additive schema, new tables, new RPCs, privileges. Old runtime unaffected. *Verify:* both chains apply cleanly; existing invitations still accept. *Abort:* any failure → drop new objects.
2. **Deploy compatibility backend** with the new canonical routes behind `INVITATIONS_V3` (default off) and the new worker kind. *Verify:* health, worker heartbeat, old flow still green.
3. **Deploy frontend** compatible with both. *Verify:* no console/network regressions.
4. **Enable the flag.** *Verify:* create → email/SMS attempts → accept end-to-end in production; delivery rows correct.
5. **Enable the DB legacy-write fence** — trigger rejecting any insert of a plaintext-token invitation and any legacy accept RPC call. *Verify:* legacy paths error.
6. **410 Gone** on legacy HTTP routes; **revoke all remaining legacy plaintext invitations**. *Verify:* zero usable legacy tokens.
7. **Monitor** the new flow and worker (delivery failures, stuck jobs, seat errors).
8. **Contract migration** — drop `token`, `max_uses`, `get_invitation_info`, `accept_workspace_invitation_as`, `accept_workspace_invitation`.

After step 5, rollback to the insecure backend is **not** supported; recovery is forward-fix or rollback to a compatible build that understands the new schema and cannot mint plaintext tokens. Steps 5–6 may briefly make invitation management unavailable (minutes) while the rest of the app stays up; this is stated as a short invitation-only maintenance window rather than an unqualified zero-downtime claim. Documented in `docs/DEPLOYMENT.md` and `database/README.md`; chains stay drift-free.

## 17. Tests

All v2 tests plus: atomic create with departments; no partial invitation when department/token/outbox/audit insert fails; atomic edit + department replacement; history FK behavior during offboarding; `accept-new` rejects an existing password account; concurrent profile appearance returns login-required; password-null setup path; disabled account rejected; OTP expiry/resend/attempt cap/replay/rate limits; manual-link preview reveals only masked PII; existing user must accept current legal versions; referenced legal versions immutable; anon/authenticated cannot read any new table or execute any new RPC; old backend cannot create plaintext invitations after the fence; compatible rollback build cannot use legacy paths; every seat-creation path takes the workspace lock (plus the CI guard); two different invitations of one workspace accepted concurrently cannot exceed `max_agents`; `SEAT_LIMIT_REACHED` consumes neither token nor consent; entitlement failure → 503 not unlimited; session-creation failure yields login recovery without duplicate membership; outbox double-claim prevention; retry idempotency and no two valid email links; delivery history append-only and `accepted ≠ delivered`; accepted invitations archived not deleted and consent survives; offboarding preserves `role_permissions`, other workspaces, consents and audit; edit revokes all tokens; composite FKs reject foreign-workspace departments; token stripped from URL and absent from DB rows/logs/audit/analytics/API responses; manual raw link only in the authorized create/rotate response and unrecoverable later; ordinary member cannot relay mail; no new GoTrue/Supabase Auth/`auth.uid()` identity usage; widget runtime and build unchanged. Real PostgreSQL integration tests, not mocks.

## 18. Out of scope

Embedded chat widget runtime and build; AI, Calls, Channels, Inbox, Billing beyond the entitlement read; a general ownership-transfer feature; SSO/social login; marketing-consent management; new SaaS dependencies, edge functions or new secrets (except the reuse of the existing verification pepper).

## 19. Remaining assumptions

- `call_center_department_agents`, `operator_call_availability`, `user_availability_prefs`, `user_notification_prefs` are workspace+user scoped in both chains — re-verified column-by-column at implementation before any delete lands.
- `platform_settings` currently holds no legal versions, so `legal_policy_versions` is seeded with an initial published terms/privacy version (content hash of the shipped documents).
- The existing verification pepper (`PHONE_VERIFICATION_PEPPER`) is reused for invitation OTP digests; if the operator prefers isolation, one optional env var is added.

## 20. Unresolved product decisions

1. Should an expired invitation offer a one-click "renew" (new token + new expiry on the same row) or always force a new invitation? Plan currently forces a new one.
2. Should staff invitations be allowed zero departments strictly, or optionally accept them? Plan says none.
3. Waitlisted invitations when at the seat cap are excluded — confirm.

## 21. Readiness verdict

The plan is **safe to implement** as specified: identity stays fully self-hosted (`profiles`, `user_credentials`, `auth_sessions`, Argon2id, `gs_session`, `authorizeWorkspaceAccess`), no GoTrue, no Supabase Auth identity, no `auth.uid()` for application identity, no edge functions; all sensitive logic runs in the Express backend and service-role-only, search_path-pinned RPCs; the browser holds no privileged RPC and no raw email route; no raw token or OTP is ever stored, logged, audited or returned outside the single authorized create/rotate response; and the embedded widget runtime is untouched. Implementation begins only after approval of this v3 plan.
