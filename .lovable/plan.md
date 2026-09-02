# Workspace Invitations — Secure, Production-Ready Redesign

## Current state (traced in code)

- `server/routes/workspaceMembers.ts` owns invitations today: `GET/POST/PATCH/DELETE /invitations` plus `POST /accept-invitation`. Create accepts only `role`, optional `invitedEmail`, optional `expiresAt`, and sets `max_uses: 0` (unlimited use). `GET /invitations` does `select('*')` — the **raw token is returned to any workspace member**, and listing is not manage-gated.
- `database/migrations/042_workspace_invitations.sql` stores the **raw token in plaintext** (`token text ... DEFAULT encode(gen_random_bytes(32),'hex')`), has `max_uses`/`use_count`, no first/last name, no phone, no status column, no revoked_by/accepted_by, no department link.
- `src/pages/auth/InvitePage.tsx` calls `supabase.rpc('get_invitation_info')` directly from the browser; that RPC reads `auth.uid()`, which is always NULL under first-party auth, so `email_match`/`already_member` are degraded. It also requires the invitee to already have an account and log in first — there is no "set password and join" flow.
- Seat limit is enforced by `requireLimit('max_agents')` middleware *outside* the acceptance transaction → concurrent accepts can exceed `max_agents`.
- Email goes through `server/services/email` (`sendEmail`), SMS through `server/services/sms` (platform-level provider, currently used only by phone verification). `server/services/auth-email.ts` already has the correct pattern: `resolveAppBaseUrl(config)`, SHA-256 token hashing, server-rendered localized templates. Invitations will reuse both.
- Rate limiting exists in `server/middleware/security.ts` (`express-rate-limit`, per-IP and per-workspace key generators).

Auth stays exactly as it is: `gs_session` cookie, `profiles` + `user_credentials` + `auth_sessions`, Argon2id, `authorizeWorkspaceAccess`. No GoTrue, no `auth.uid()` for identity, no edge functions.

## Data model (new migration, both chains)

New migration `database/migrations/076_workspace_invitations_v2.sql` plus the mirrored `supabase/migrations` file (same SQL, self-host chain is authoritative per `database/README.md`).

`public.workspace_invitations` — additive columns: `first_name`, `last_name`, `invited_email_normalized`, `invited_phone_e164`, `member_type` (`customer_facing|staff`), `status` (`pending|accepted|revoked|expired`), `accepted_by`, `accepted_at`, `revoked_by`, `revoked_reason`, `last_sent_at`, `token_hash`, `token_prefix`, `email_delivery_status`, `sms_delivery_status`, `email_last_error`, `sms_last_error`.

- Backfill `status` from existing `revoked_at`/`expires_at`/`use_count`.
- **Existing plaintext tokens are revoked**, not migrated (they cannot be re-hashed safely and were exposed through `select('*')`). Then `token` column is dropped.
- `max_uses` dropped; single-use enforced by `status = 'pending'` + row lock.
- `expires_at` becomes `NOT NULL` (default now() + 7 days).
- Partial unique indexes: one pending invite per `(workspace_id, invited_email_normalized)` and per `(workspace_id, invited_phone_e164)`; unique index on `token_hash`.

New table `public.workspace_invitation_departments (invitation_id, workspace_id, department_id)` with FKs and a composite FK guaranteeing the department belongs to the same workspace.

New table `public.workspace_invitation_consents (user_id, invitation_id, terms_version, privacy_version, accepted_at, ip, user_agent, locale)`.

RLS enabled, zero client policies (service_role only) — matching the existing convention. `get_invitation_info` is dropped (browser no longer calls PostgREST).

New SECURITY DEFINER RPC `public.accept_workspace_invitation_v2(...)`, `search_path = public, pg_temp`, `EXECUTE` granted **only** to `service_role`, which in one transaction: locks the invitation row `FOR UPDATE`, re-checks pending/expiry/revocation, counts current members against the passed `max_agents` and fails on overflow, creates `profiles` + `user_credentials` (hash passed in from the server) for new users, inserts `workspace_members`, inserts department assignments, records consent, and flips the invitation to `accepted`. The old `accept_workspace_invitation_as` and `accept_workspace_invitation` are dropped.

New RPC `public.offboard_workspace_member(...)` (service_role only): deletes membership, deletes department assignments for that workspace, revokes pending invitations matching the member's email/phone — atomically.

## Backend

New `server/routes/workspaceInvitations.ts` mounted at `/api/workspace-invitations`, plus `server/services/invitations/` (token, validation, notification, audit). All management routes use `authorizeWorkspaceAccess(req, res, workspaceId, { manage: true })`; nothing returns a token hash.

| Route | Purpose |
| --- | --- |
| `POST /` | create (validates all required fields), returns invitation + raw link **once** |
| `GET /?workspaceId=` | list — manage-gated, explicit column list, `token_prefix` only |
| `GET /:id?workspaceId=` | detail |
| `PATCH /:id` | edit before acceptance; email/phone change rotates the token |
| `POST /:id/resend` | new token + re-send email/SMS |
| `POST /:id/rotate-link` | new token, invalidates the old link |
| `POST /:id/revoke` | revoke with reason |
| `DELETE /:id` | delete (404 when not in this workspace — never fake `ok:true`) |
| `GET /preview?token=` | public preview, resolves the logged-in user from `gs_session` only |
| `POST /accept-new` | password + consent → atomic accept → creates `gs_session` |
| `POST /accept-existing` | logged-in user whose session email matches → atomic accept |

Validation: first name, last name, email and E.164 phone all required; email lowercased/canonicalized; phone normalized with country code; `role !== 'owner'`; `customer_facing` requires at least one department belonging to this workspace; `staff` requires no department; `expires_at` within 1–30 days, default 7.

Token: 32 random bytes → base64url raw value; only `sha256(token)` and a 8-char prefix stored; lookup by hash with a constant-time comparison. Raw token never logged.

Notifications are sent **by the backend**: server-rendered, HTML-escaped, fa/en/tr email template through the existing email provider abstraction, with the URL built from `resolveAppBaseUrl(config)`; SMS through the SMS provider abstraction (workspace name, inviter, "link sent to your work email", validity) — no link in the SMS, so receiving it never implies phone verification. Email and SMS statuses (`queued|accepted|sent|failed`) are tracked separately, a stub/unconfigured provider is reported as such and never as delivered, and a delivery failure never deletes the invitation.

Audit entries written to `audit_logs` for create/edit/resend/rotate/revoke/delete/preview/accept/expire/member-removed, with email hashed and no tokens or secrets.

Rate limits on create/resend/rotate/accept/preview keyed by IP **and** workspace/invitation.

Member removal (`DELETE /api/workspace-members/:memberId`) is switched to the atomic offboarding RPC.

## Frontend

- `src/pages/auth/InvitePage.tsx` rewritten: preview from `GET /api/workspace-invitations/preview` (no `supabase.rpc`), shows name, invited email, masked phone, workspace, inviter, role, departments, expiry. New user → password + confirm password + a consent checkbox (default off, submit disabled until checked, links to terms/privacy, versions recorded) → "ثبت‌نام و ورود به ورک‌اسپیس". Existing account → redirect to login with the invite redirect preserved; mismatched session → dedicated Wrong Account screen with logout/switch. Invited users never enter the 3-step public signup.
- Invitation management UI (create dialog with all required fields, pending list, email/SMS delivery status, expiry, edit/resend/rotate/revoke/delete, copy-link with real clipboard success check) added to `StaffAccessPage.tsx` (staff) and `TeamDepartmentsPage.tsx` (customer-facing), gated on owner/admin. `TeamPage.tsx` keeps only its redirect — it does not become a second invitation surface.
- fa/en/tr translations for every new string; RTL respected.

## Tests

Vitest + real PostgreSQL integration tests (`TEST_DATABASE_URL`) covering: owner/admin can create, agent/viewer cannot create or list; required-field and normalization rules; open invite and owner-role invites rejected; cross-workspace department rejected; no raw token in DB or in list responses; single-use enforcement; two concurrent accepts → exactly one success; concurrent accepts cannot exceed `max_agents`; expired/revoked/wrong-email rejected; existing account routes to login without duplicating a profile; consent required, default-off, version+timestamp stored; membership + departments created atomically; email/SMS failure does not delete the invitation and surfaces to the owner; provider 500 not treated as success; resend/rotate invalidate the old link; offboarding revokes invites and clears departments and blocks re-entry via the old link; tenant isolation; no browser-reachable seat-creation RPC; no new GoTrue/`auth.uid()` identity usage.

## Out of scope

Embedded widget runtime, AI, Calls, Channels, Inbox and Billing are untouched. No new SaaS dependency, no edge function, no new secret.
