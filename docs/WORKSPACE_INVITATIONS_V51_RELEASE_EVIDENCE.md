# Workspace Invitations v5.1 — Release evidence (Section I)

Status: **Sections G–I complete — D.2 remains blocked — NOT PRODUCTION READY.**

## 1. Commit

- Final commit SHA at evidence time: `6814de1799d0fc1a067ebb2de1cc59fbb911f444`

## 2. Migration chains

| Chain | Location | Count | Invitation tail |
| --- | --- | --- | --- |
| Self-host (numeric) | `database/migrations/*.sql` | 92 files | `076` … `094_workspace_invitations_v51_preview_context.sql` |
| Hosted (timestamped mirror) | `supabase/migrations/*.sql` | 258 files | tail mirror `20260902161824_bddd59bc-c326-443e-bcbe-6982fdc3f8ad.sql` (= 094) |

Mirror registration is asserted in `src/test/integration/migrationMirrorParity.test.ts`;
the parity suite fails on any unregistered or drifting pair.

## 3. Clean self-host replay evidence

`scripts/ci/selfhost-clean-replay.sh` applies every numeric migration in order
against a brand-new empty PostgreSQL with `ON_ERROR_STOP=1`, printing per-file
duration and exit code. Wired as the mandatory `database` job in
`.github/workflows/invitations.yml`. Locally executed against PostgreSQL 17.9:
all migrations exit `0`, followed by the invitation PostgreSQL suites (green).

## 4. Hosted runtime parity

- Migration 094 applied successfully to the connected hosted project.
- Hosted RPC signature and schema fingerprints: `scripts/ci/internal-rpc-signatures.sql`,
  `scripts/ci/schema-parity-fingerprint.sql` (run in CI against the replayed chain).
- Structural verification: `scripts/ci/verify-hosted-chain.sql`, `scripts/ci/verify-selfhost-chain.sql`.

## 5. D.2 blocker (explicit)

D.2 requires a **clean replay of the hosted chain on a disposable hosted
Supabase environment**. No disposable hosted project exists, and the production
project must never be reset. D.2 is therefore **NOT PERFORMED** and the release
cannot be declared production-ready.

## 6. Schema parity result

Self-host and hosted chains carry the same invitation object set for
migrations 076–094 (parity registration green, fingerprint scripts wired in
CI). Hosted-only objects outside the invitation scope (AI-KB) are intentionally
excluded, as documented in the CI comments.

## 7. Test totals

| Suite | Result |
| --- | --- |
| Frontend typecheck (`npm run typecheck`) | exit 0 |
| Server/worker typecheck (`npm run typecheck:server`) | exit 0 |
| Production build (`npm run build`) | exit 0 |
| Invitation guards (translations, request-ids, mirror parity) | 42 passed |
| Section G worker lifecycle (`invitationWorkerLifecycle.test.ts`) | 10 passed |
| Section H source/security guards (`invitationSecurityGuards.test.ts`) | 13 passed |
| Section C PostgreSQL suites | green on self-host PostgreSQL 17.9 |
| Playwright invitation E2E | 10 passed (Chromium) |

## 8. Browser E2E — fa / tr / en

`e2e/invitations.spec.ts` (real Chromium, no mocks):

- configured site default language is active on first render, for each of fa, tr, en
- Persian renders `dir="rtl"`; Turkish and English render `dir="ltr"`
- invalid/unknown invitation shows a localized message in each locale, never a raw key
- fragment token hygiene: fragment is stripped, no raw token in URL, localStorage,
  sessionStorage or DOM after bootstrap
- unauthenticated access to the invitation-management surface is redirected

Seeded flows (happy path, OTP, existing user, revoke/expiry, resend/rotate,
provider failure, offboarding, role denial) are implemented behind
`E2E_INVITE_SEED=1` gating and are **untested** until a disposable backend is
available — the same blocker as D.2.

## 9. Default-language and RTL/LTR evidence

- Resolver: `src/i18n/index.tsx` → `getSiteDefaultLocale()` reads
  `window.__APP_RUNTIME_CONFIG__.defaultLocale` (`public/runtime-config.js`).
- Precedence: explicit user selection (persisted `app-locale`) → configured site
  default → `DEFAULT_LOCALE`. The browser language is never consulted.
- Direction: `src/i18n/config.ts` (`fa: rtl`, `tr: ltr`, `en: ltr`), applied via
  `document.documentElement.dir` and Radix `DirectionProvider`.
- Guarded by `src/test/invitationSecurityGuards.test.ts` and the E2E direction assertions.

## 10. Worker failure semantics (Section G)

`server/services/invitations/worker.ts`:

- lifecycle phases `stopped | running | draining`, readiness at
  `GET /api/health/invitation-worker` (200 running, 503 draining/stopped)
- `SIGTERM`/`SIGINT` installed once, idempotent; `startInvitationWorker` and
  `stopInvitationWorker` are idempotent
- shutdown clears the poll timer, refuses **all** new claims immediately, and
  awaits the active drain under a bounded timeout
  (`INVITATION_WORKER_SHUTDOWN_MS`, default 25s); anything still in flight is
  safely abandoned and recovered by another worker through
  `reclaim_expired_invitation_jobs` (lease-based recovery)
- heartbeat failures/`false` results disarm the heartbeat and mark the claim
  lost; every later completion attempt is refused locally and in the database
  (claim-token guard)
- no unhandled promise rejection on any shutdown path; no job payload, token,
  OTP or provider credential is ever logged

Approved delivery contract, unchanged: external provider submission is
**at-least-once**, database state is idempotent, provider acceptance is
`provider_accepted` and never `delivered`, and an ambiguous provider response
may produce a duplicate external submission.

## 11. Security / ACL evidence

- No `wi_*` invitation RPC is executable by `PUBLIC`, `anon` or `authenticated`
  (hard-failing check inside `scripts/ci/advisor-fingerprints.sql`).
- No `workspace_invitation*` table is reachable by `anon` or `authenticated`.
- No frontend source reads a service-role key (static guard).
- No raw token, OTP, password, proof or pepper is logged (static guard).
- Section C security evidence suite (`wiSectionCSecurityEvidence.pg.test.ts`)
  remains the live database-side proof.

## 12. Advisor inventory

- Human inventory: `docs/WORKSPACE_INVITATIONS_ADVISOR_INVENTORY.md`
- Machine baseline: `security/advisor-baseline.json` (76 fingerprinted findings)
- Summary: 43 RLS-enabled-no-policy (INFO, server-only tables, deny-by-default
  intended), 2 extension-in-public (deferred, separate maintenance window),
  8 anon-executable SECURITY DEFINER (5 scoped helpers deferred-by-design,
  `admin_*` grants marked **actionable**), 22 authenticated-executable
  SECURITY DEFINER (admin functions marked actionable, rest internally scoped),
  1 leaked-password protection (not on any live login path — first-party
  Argon2id auth is authoritative).
- The hosted advisor UI reports 77; the extra entry is a relation the catalog
  enumeration does not classify as a plain table. CI diffs catalog fingerprints.

## 13. CI workflows

| Workflow / job | Purpose |
| --- | --- |
| `CI / validate` | typechecks, lint gates, unit tests, build |
| `CI / integration`, `ai-billing-db`, `hosted-supabase-chain`, `selfhost-chain` | pre-existing database gates |
| `Workspace Invitations v5.1 / guards` | typechecks, translation completeness (fa/tr/en), hardcoded-string guard, locale-default and RTL/LTR guard, service-role and secret-logging guards, advisor-baseline integrity, RPC/mirror parity, production build |
| `Workspace Invitations v5.1 / database` | clean replay on empty PostgreSQL, all invitation suites sequentially with `REQUIRE_WI_DB=1` (never skipped), RPC/schema parity, privileged-RPC ACL gate, advisor fingerprint diff |
| `Workspace Invitations v5.1 / e2e` | real Chromium E2E across fa, tr, en |

Advisor gate contract: fail on any **new** fingerprint; removals allowed; the
total is not pinned to 76.

## 14. Deployment order

1. Apply `database/migrations/076 → 094` (self-host) or the mirrored
   `supabase/migrations` tail (hosted), in order, with `ON_ERROR_STOP=1`.
2. Deploy the Express server (invitation routes + outbox worker).
3. Deploy the frontend build.
4. Update `public/runtime-config.js` (`defaultLocale`, `apiBaseUrl`) for the
   environment — no rebuild required.
5. Verify `GET /api/health` and `GET /api/health/invitation-worker`.

## 15. Rollback / forward-fix

- Application: redeploy the previous server and frontend artifacts. The
  invitation schema is additive and backwards compatible with the previous
  server build, so a code-only rollback is safe.
- Database: **do not** reverse-migrate. Forward-fix with a new numeric
  migration plus its hosted mirror; register the pair in
  `migrationMirrorParity.test.ts`.
- Worker: `SIGTERM` drains gracefully; unfinished jobs are re-leased by the
  next worker. Stopping the worker never loses queued invitations.

## 16. Required environment variables (names only)

`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server only),
`APP_BASE_URL`, `CORS_ORIGINS`, `SESSION_SECRET`,
`INVITATION_TOKEN_DERIVATION_KEY` (+ versioned keys),
`INVITATION_OTP_PEPPER` (+ versioned peppers),
`INVITATION_WORKER_SHUTDOWN_MS` (optional), email/SMS provider credentials.
No values are recorded in this document or in the repository.

## 17. Operational monitoring / runbook

- Readiness: `GET /api/health/invitation-worker` — alert when `phase` stays
  `draining` for more than one deployment window.
- Queue health: rows in `workspace_invitation_jobs` with
  `status IN ('queued','retrying')` older than 15 minutes.
- Delivery health: `workspace_invitation_deliveries` grouped by outcome; a rise
  in `unconfigured` means an unset provider, not a code fault.
- Lease health: repeated `reclaim_expired_invitation_jobs` activity indicates a
  crashing or overloaded worker pod.
- Owner-visible failures: delivery errors are surfaced in the invitation
  management UI and never delete or revoke the invitation.

## 18. Remaining blockers

1. **D.2** — hosted clean replay on a disposable Supabase environment (blocked:
   no disposable project; production must never be reset).
2. Seeded browser E2E flows (happy path, OTP, resend/rotate, offboarding,
   role denial) require the same disposable backend.
3. Advisor findings marked **actionable** (`admin_*` SECURITY DEFINER grants to
   `anon`/`authenticated`) need a dedicated hardening migration, tracked
   outside this release.

Final status: **Sections G–I complete — D.2 remains blocked — NOT PRODUCTION READY.**
