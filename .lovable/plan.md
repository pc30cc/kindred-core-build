# Workspace Invitations — Revised Plan (v2, integrated)

## 0. Current state (traced)

- `server/routes/workspaceMembers.ts` owns invitations: `GET/POST/PATCH/DELETE /invitations` + `POST /accept-invitation`. Create takes only role/email/expiry, sets `max_uses: 0`. `GET /invitations` does `select('*')` → **raw token returned to any workspace member**, listing not manage-gated.
- `database/migrations/042_workspace_invitations.sql` stores the **plaintext token**, has `max_uses`, no names/phone/status/departments/consent.
- `src/pages/auth/InvitePage.tsx` calls `supabase.rpc('get_invitation_info')` from the browser; that RPC reads `auth.uid()` which is always NULL under first-party auth.
- Seat gate `requireLimit('max_agents')` runs as middleware **outside** the accept transaction → concurrent accepts overshoot.
- Invite email HTML is built in the **browser** and posted to `POST /api/email/send` from `TeamDepartmentsPage.tsx:852` and `TeamPage.tsx:200`; that route only checks workspace membership → any member can send arbitrary HTML to any address (mail relay). Third caller: `src/providers/email/api.ts` (admin test send).
- Reusable infrastructure: `server/services/auth-email.ts` (`resolveAppBaseUrl`, SHA-256 token hashing, localized server templates), `server/services/email`, `server/services/sms`, `server/middleware/security.ts` rate limiters, `startAttachmentJanitor` in-process ticker pattern, `audit_logs`.

Auth boundary is unchanged everywhere below: `gs_session` cookie, `profiles` + `user_credentials` + `auth_sessions`, Argon2id, `authorizeWorkspaceAccess`.

## 1. Final schema

Migration chain: self-host `database/migrations/076_workspace_invitations_v2.sql` (authoritative) mirrored into `supabase/migrations`. The two chains are diffed for `workspace_invitations`, `workspace_members`, `workspace_departments` **before** mirroring; drift is reconciled in the same migration rather than assumed away. Number is picked from the real latest file at implementation time (currently 075).

### workspace_invitations (expanded)
Added: `first_name`, `last_name`, `invited_email_normalized`, `invited_phone_e164`, `member_type` (`customer_facing|staff`), `status` (`pending|accepted|revoked|expired`), `accepted_by`, `accepted_at`, `revoked_by`, `revoked_reason`, `archived_at`, `job_title` (opt), `staff_code` (opt), `last_email_status`, `last_sms_status` (denormalized mirrors of the delivery table).
Dropped later (contract phase): `token`, `max_uses`.
Constraints:
- `UNIQUE (id, workspace_id)` (target for composite FKs)
- partial unique on `(workspace_id, invited_email_normalized) WHERE status='pending'` and same for `invited_phone_e164` — safe because expiry really transitions status (§8), so no `now()` in any index predicate
- CHECKs: `btrim(first_name) <> ''`, `btrim(last_name) <> ''`, canonical non-empty email, `invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'`, `member_type IN (...)`, `role <> 'owner'`, role ∈ allowed set for its `member_type`, `expires_at > created_at`, `status='accepted' → accepted_by IS NOT NULL AND accepted_at IS NOT NULL`, `status='revoked' → revoked_at IS NOT NULL`.
- Customer-facing "≥1 department" is enforced by a deferred-constraint trigger at commit (a CHECK cannot see a child table).

### workspace_invitation_tokens (new)
`id, invitation_id, workspace_id, purpose ('email_claim'|'manual_handoff'), token_hash, token_prefix, generation, expires_at, consumed_at, revoked_at, created_at`.
Unique on `token_hash`; partial unique `(invitation_id, purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL`. Raw token never stored.

### workspace_invitation_departments (new)
`invitation_id, workspace_id, department_id` with
`FK (invitation_id, workspace_id) → workspace_invitations(id, workspace_id)` and
`FK (department_id, workspace_id) → workspace_departments(id, workspace_id)`
(both parents get the required `UNIQUE (id, workspace_id)`), PK `(invitation_id, department_id)`.

### workspace_member_details (new) — workspace-scoped employee record
`workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id, joined_at, updated_at, archived_at`, PK `(workspace_id, user_id)`, FK to `workspace_members(workspace_id, user_id)`.
Global `profiles` of an **existing** account are never overwritten by an invitation. For a brand-new user the initial `profiles` row is seeded from the invitation, but the working copy still lives here. Member directory/UI reads this table first and falls back to `profiles`.

### workspace_invitation_consents (new)
`id, user_id, workspace_id, invitation_id UNIQUE, terms_version, privacy_version, accepted_at (DB default now()), ip, user_agent, locale`. FK to invitation is `ON DELETE RESTRICT` — consent survives archive and can never be cascade-deleted. Versions come from server config/`platform_settings`, never from the request body. IP is taken from the existing trusted-proxy helper (`server/utils/clientIp.ts`), User-Agent from the request header. Marketing consent is a separate concept and is not stored here.

### workspace_invitation_deliveries (new)
`id, invitation_id, workspace_id, channel ('email'|'sms'), attempt_number, purpose, provider_name, provider_message_id, status ('queued'|'accepted'|'sent'|'failed'|'delivered'|'unconfigured'), error_code, safe_error_message, created_at, accepted_at, sent_at, delivered_at, failed_at, metadata`. Append-only; every resend is a new attempt. `delivered` is written **only** by a verified provider webhook. Stub/unconfigured provider ⇒ `unconfigured`, never success. No raw token, no full email body, no secrets.

All new tables: RLS enabled, zero client policies (service_role only), matching the existing self-host convention.

## 2. Atomic acceptance RPC

`public.accept_workspace_invitation_v2(...)`, SECURITY DEFINER, `SET search_path = public, pg_temp`, `EXECUTE` granted **only** to `service_role` from the moment of creation (no PUBLIC/anon/authenticated window). Exact order inside one transaction:

1. Resolve the token row by hash, resolve its invitation, validate purpose/consumed/revoked/expiry.
2. Read `workspace_id` **from the invitation** (never from the request).
3. `SELECT id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE` — workspace-level lock, so two different invitations of the same workspace serialize.
4. `SELECT ... FROM workspace_invitations WHERE id = ... FOR UPDATE`.
5. Re-check `status='pending'`, not expired, not revoked, token unconsumed (single-use).
6. Use the `_max_agents` argument, which the server passes from the server-side entitlement resolution only; the RPC validates it is `-1` or a non-negative integer and rejects anything else.
7. Count current `workspace_members` for the workspace.
8. Enforce the seat limit; overflow raises a typed error.
9. Resolve or create the account (see §4) — `profiles` insert relies on the existing unique email index, and a unique violation is caught and retried as "resolve existing".
10. Insert `workspace_members`, `workspace_member_details`, department assignments.
11. Insert consent.
12. Flip invitation to `accepted` (+ `accepted_by`, `accepted_at`), mark the used token `consumed_at`, revoke every other token of that invitation.

Entitlement read failure in the server layer returns **503 retryable** — never "unlimited". Self-host unlimited comes only from the existing server-side setting.

Session creation happens after commit; if it fails the user is told to log in with the password they just set — the account and membership stay valid and consistent.

## 3. Two token purposes

- **email_claim** — created by the backend, embedded only in the invitation email, never displayed to the owner and never returned by any API. Clicking it proves possession of the invited mailbox; on successful acceptance the address is marked verified with source `workspace_invitation_email_claim`.
- **manual_handoff** — the link shown once to the owner for manual delivery. A **new** user arriving through this link must first pass an email OTP sent to the invited address before credentials are created; then only password + consent.
- Consuming either purpose accepts the invitation and revokes all remaining tokens of that invitation.
- Resend issues a fresh `email_claim` (old one revoked). Rotate-link issues a fresh `manual_handoff` only.
- 32 random bytes, base64url; only `sha256` hash + 8-char prefix stored; constant-time comparison on lookup.
- SMS is notification only: workspace name, inviter, "the link was sent to your work email", validity window. No link. Receiving SMS never changes phone-verification state.

## 4. Three existing-account states

1. **No profile** — new user: password + confirm + consent (after email_claim, or after OTP on manual_handoff).
2. **Profile with password** — no new account, no password prompt; redirect to login preserving the full invite redirect; after login the `gs_session` email is compared with the invitation; match → accept, mismatch → dedicated Wrong Account screen with logout/switch.
3. **Profile with `password_hash IS NULL`** (migrated identity) — no duplicate profile, no login dead-end: the flow runs a proof-of-ownership password setup (email_claim already proves it; manual_handoff requires the OTP first), then links the same profile to the invitation.

A `disabled`/blocked account (`user_credentials.status`) can never accept. Concurrent profile creation for the same email resolves to one account via the DB unique constraint and a safe, understandable result.

## 5. Canonical API — `server/routes/workspaceInvitations.ts`

`POST /`, `GET /?workspaceId=`, `GET /:id`, `PATCH /:id`, `POST /:id/resend`, `POST /:id/rotate-link`, `POST /:id/revoke`, `DELETE /:id` (archive for accepted), `GET /preview?token=`, `POST /accept-new`, `POST /accept-existing`, `POST /otp/request` + `POST /otp/verify` (manual_handoff only).

Management routes use `authorizeWorkspaceAccess(..., { manage: true })`; nothing ever returns a token or hash — list responses expose `token_prefix` only, via an explicit column list. Wrong-workspace ids return 404, never a fake `ok:true`. Unique conflicts return 409.

### Old routes removed
`GET/POST/PATCH/DELETE /api/workspace-members/invitations` and `POST /api/workspace-members/accept-invitation` are removed (temporarily answering `410 Gone` during the transition window, then deleted). `get_invitation_info` and `accept_workspace_invitation_as` / `accept_workspace_invitation` are dropped in the contract phase. A test asserts the old paths are no longer a seat-creation boundary.

## 6. `/api/email/send` hardening

Traced callers: `TeamDepartmentsPage.tsx:852` (invite), `TeamPage.tsx:200` (invite), `src/providers/email/api.ts` (admin test send). The two invite callers disappear because the backend sends invitation mail itself. The remaining one becomes a purpose-specific endpoint.

- `POST /api/email/send` stops accepting arbitrary `to`/`subject`/`html`. It is replaced by `POST /api/email/test-send`, restricted to workspace owner/admin (and platform admin), which sends a fixed server-rendered test template to a verified workspace address only.
- `POST /api/email/send-channel` and `sendChannelEmail()` keep working unchanged.
- In-process platform mail (`auth-email.ts`, widget notifications) already calls `sendEmail()` directly and is untouched.
- A security test asserts an ordinary member cannot use the email surface as an arbitrary relay.

## 7. Expiration

Real status transitions, no `now()` in index predicates:
- an invitation janitor added to the existing in-process ticker pattern (`startAttachmentJanitor` style, single-flight) flips due `pending` rows to `expired` and revokes their tokens, with an audit event;
- before creating an invitation, matching stale pending rows for the same email/phone are expired first, so the partial unique index never blocks a legitimate re-invite;
- list/preview/resend/accept all re-check expiry fail-safe;
- an expired invitation cannot be accepted or resent — the owner creates a new one (or an explicit renew).

## 8. Notifications and delivery history

The backend creates the invitation, generates the tokens, builds the URL from `resolveAppBaseUrl(config)`, renders escaped fa/en/tr server templates, sends email through the email provider abstraction and SMS through the SMS provider abstraction, and records **one delivery attempt row per channel per send**. Provider acceptance is recorded as `accepted`/`sent`, never `delivered`; `delivered` only from a verified webhook. Failure never deletes the invitation — the owner sees the safe error and can retry. If the existing outbox/worker is used, the raw token is never stored in the job: the worker mints a token at claim time, stores the hash atomically, builds the link in memory, and sends.

## 9. Edit / rotate semantics

Editing email or phone on a pending invitation: revoke all tokens, mint new `email_claim` + `manual_handoff`, reset the denormalized channel statuses, keep old delivery attempts bound to the old contact data, create new attempts, resend (or ask the owner to confirm sending). Old links die immediately. Role/department/name edits are allowed only before acceptance and are audited without raw PII.

## 10. Offboarding RPC

`public.offboard_workspace_member(...)`, service_role only: locks the workspace, resolves the target inside that workspace, checks `workspaces.owner_id` and **refuses to remove or demote the canonical owner regardless of caller**, then within one transaction:

| Data | Action |
| --- | --- |
| `workspace_members` | delete |
| `workspace_member_details` | archive (`archived_at`) |
| `workspace_department_members` | delete |
| `call_center_department_agents` | delete |
| pending `workspace_invitations` matching work email/phone | revoke |
| `workspace_invitation_tokens` for those | revoke |
| `user_availability_prefs`, `operator_call_availability` (this workspace) | delete |
| `role_permissions` / per-workspace overrides | delete |
| `user_notification_prefs` (this workspace) | delete |
| conversations, audit logs, consents | retain |

Nothing outside the workspace is touched; the global account is never deleted. Audit entry written.

## 11. Token leakage prevention

Invite page sets `Referrer-Policy: no-referrer`, strips the token from the URL with `history.replaceState` immediately after reading it, keeps it in memory/sessionStorage only, clears it on accept/expire/revoke/logout, and never puts it in analytics, error tracking, toasts, logs or audit metadata. Backend errors return safe codes only. The invite context survives refresh and the login redirect without re-exposing the token in the URL.

## 12. Rate limiting trust order

Before a token resolves: IP bucket + global ceiling only. After a token resolves successfully: invitation bucket + real workspace bucket + IP bucket. A request with an invalid token can never consume a real workspace's bucket via a spoofed workspaceId/origin/email/phone. Same boundary for accept-new and the OTP endpoints.

## 13. Permission matrix

| Action | Owner | Admin | Agent/Viewer/other | Platform super admin |
| --- | --- | --- | --- | --- |
| Create invitation (non-admin roles) | ✔ | ✔ | ✖ | ✔ |
| Create invitation with `role='admin'` | ✔ | ✖ | ✖ | ✔ |
| Invite `role='owner'` | ✖ | ✖ | ✖ | ✖ |
| List / view invitations | ✔ | ✔ | ✖ | ✔ |
| Edit / resend / rotate / revoke / archive | ✔ | ✔ | ✖ | ✔ |
| Change a member's role to admin | ✔ | ✖ | ✖ | ✔ |
| Remove member | ✔ | ✔ (non-admin targets) | ✖ | ✔ |
| Remove/demote canonical owner | ✖ | ✖ | ✖ | ✖ |

Decision: **only the owner may invite or promote an admin.** Customer-facing invitations may use only customer-facing roles (agent, support_agent, sales_agent, team_lead) and require ≥1 department; staff invitations use staff roles and take no department.

## 14. Frontend

- `InvitePage.tsx` rewritten against the Express preview/accept endpoints (no `supabase.rpc`, no `supabase.from`): shows name, invited email, masked phone, workspace, inviter, role, departments, expiry; new user sees only password + confirm + a consent checkbox (default off, submit disabled until checked, clickable terms/privacy links, versions recorded server-side); existing account is routed to login with the redirect preserved; mismatched session gets the Wrong Account screen. Invited users never enter the 3-step public signup.
- Full invitation management (create dialog with all required fields, pending list, per-channel delivery status and history, expiry, edit/resend/rotate/revoke/archive, copy-link with real clipboard verification) added to `StaffAccessPage.tsx` (staff) and `TeamDepartmentsPage.tsx` (customer-facing), hidden for non-managers — with the backend as final authority. `TeamPage.tsx` keeps only its redirect and is not a second invitation surface.
- fa/en/tr strings for everything, RTL respected.

## 15. Migration & deployment order (Expand → Migrate → Contract)

1. **Expand** — add all new tables/columns/constraints/RPCs; keep `token`, `max_uses` and the old RPCs in place. Revoke every existing plaintext-token invitation in this step so no old link stays usable.
2. **Deploy** the server with the new router; old routes answer 410.
3. **Migrate** the UI to the new router; verify no `supabase.from('workspace_invitations')` / `supabase.rpc('get_invitation_info')` call sites remain.
4. **Contract** — a follow-up migration drops `token`, `max_uses`, `get_invitation_info`, `accept_workspace_invitation_as`, `accept_workspace_invitation`.

Zero-downtime is preserved by this ordering, so no maintenance window is required; the rollback path is "redeploy the previous server image" (valid until the contract migration, which is the point of no return and is documented as such in `docs/DEPLOYMENT.md` and `database/README.md`). Both chains are updated in the same change with no drift.

## 16. Tests (real PostgreSQL, not mocks)

Everything from the previous plan plus: two different invitations of one workspace accepted truly concurrently cannot exceed `max_agents` (workspace lock); entitlement read failure yields 503 not unlimited; old invitation routes and old RPCs are unreachable/non-privileged; an ordinary member cannot use the email surface as a relay; work details stay workspace-scoped and the existing account's global profile is not overwritten; the three account states each behave as specified; disabled account cannot accept; manual handoff without OTP cannot create credentials; email_claim path asks only password + consent; consuming either token revokes the other; expiry transitions to `expired` and does not block re-invites; each resend appends a delivery attempt and never overwrites history; accepted ≠ delivered; accepted invitations are archived not hard-deleted and consent survives; terms version cannot be forged from the client; the offboarding RPC refuses the owner and touches no other workspace; editing email/phone revokes all tokens; composite FKs reject a foreign-workspace department; the token is stripped from the URL and absent from logs/audit/analytics; an invalid preview cannot consume a workspace bucket; concurrent same-email profile creation yields one account; session-creation failure after acceptance leaves a usable account; no new GoTrue/`auth.uid()`/Supabase Auth identity usage; widget runtime and build unchanged.

## 17. Explicit confirmations

- Auth stays fully self-hosted: `profiles` + `user_credentials` + `auth_sessions`, Argon2id, `gs_session` HttpOnly cookie, `server/services/auth/*`, `server/lib/workspaceAuth.ts`.
- No GoTrue, no Supabase Auth, no `auth.uid()` for identity, no browser JWT, no `supabase.auth.*`, no edge functions, no Lovable Cloud functions, no external auth.
- `gs_session` is the only session source.
- All sensitive business logic runs in the Express backend and service-role-only RPCs.
- The browser holds no privileged RPC and no raw email route.
- The embedded widget runtime and build are untouched.
