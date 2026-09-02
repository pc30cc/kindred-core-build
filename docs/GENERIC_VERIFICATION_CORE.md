# Generic Verification Core v1

**Status: implemented and dormant.** No signup, password-reset, phone-verification,
login-step-up, email-change, phone-change, sensitive-action, or other flow calls
into this subsystem yet. It ships disabled-by-default at every layer (purpose
registry, database rows, provider sends) so its presence changes no
existing user-visible behavior.

## Why this exists

The codebase has two independent, proven OTP/verification implementations:

- **Workspace Invitations v5.1** (`server/services/invitations/`,
  `database/migrations/077-097_workspace_invitations_v51_*.sql`) — invitation
  acceptance OTPs, keyed-HMAC pepper ring, idempotent RPC executor,
  fa/tr/en templates. Its own OTP delivery still goes through a background
  worker (`server/services/invitations/worker.ts`) — unchanged by this
  subsystem.
- **Phone Verification** (`server/services/phoneVerification/`) — signup-time
  phone OTPs. This is the subsystem whose delivery model this core actually
  follows: `issueChallenge()` in `server/services/phoneVerification/index.ts`
  calls an atomic "start" RPC, then `sendSmsVerification()` directly, then an
  atomic "mark_delivery" RPC — no queue, no worker, no polling.

Every future flow that needs "send a code, verify a code, get a one-time
proof" (signup email verification, signup phone verification, password reset,
login step-up, email change, phone change, sensitive-action confirmation,
future workspace/member flows) would otherwise reinvent this a third, fourth,
fifth time. The Generic Verification Core extracts the proven security
patterns from both existing systems into one domain-neutral engine, without
touching either existing system's behavior or data.

## Architecture

```
server/services/verification/
  types.ts        purpose registry, policy clamping, dormancy gate
  crypto.ts        versioned keyed-HMAC pepper ring, OTP derivation/digest,
                   proof-token hashing, IPv4/IPv6-safe rate-limit hashing
  destination.ts   email/phone normalization (reuses phoneVerification's
                   E.164 normalizer)
  locale.ts        effective-locale resolution (explicit -> workspace
                   default -> app fallback; Accept-Language never wins)
  templates.ts     fa/tr/en OTP email + SMS templates
  service.ts       the 6 internal APIs (see below) — also where the
                   Express-direct provider send happens (no worker.ts)

database/migrations/098_generic_verification_core.sql   self-host chain
supabase/migrations/20260902185146_generic_verification_core.sql  hosted mirror
```

Nothing under `server/routes/` calls into `server/services/verification/`.
There is no `server/services/verification/worker.ts` and nothing under
`worker/index.ts`'s `WORKER_KIND` dispatcher references this subsystem —
see §Delivery below for why a worker was never needed. The only callers of
`service.ts` are the test suites listed under Testing below.

## Database objects

Six domain-neutral tables, all RLS-enabled with **zero policies** (deny-all
for `anon`/`authenticated`; `service_role` reaches them via `BYPASSRLS`, not
a policy) and no Data API grants:

| Table | Purpose |
|---|---|
| `verification_challenges` | One row per OTP challenge (generation, code digest, key version, status, attempt/max counters, expiry). Supports pre-account challenges — `user_id`/`workspace_id` are optional. |
| `verification_attempts` | Append-only log of every verification attempt (correct/incorrect), no UPDATE/DELETE grant. |
| `verification_proofs` | One row per issued proof (hash only, never the raw token), single-consume. |
| `verification_delivery_attempts` | Append-only evidence of every Express-side provider submission (outcome, provider name/message id, error code) — not a job queue: no claim/lease/status-transition columns, because there is no worker. |
| `verification_idempotency` | Generic request-idempotency ledger for `request`/`resend`/`revoke`, with a `prepared`/`committed`/`failed` state machine that is also the crash-recovery hinge for the two-phase Express-direct delivery model (see §Delivery). `verify` is excluded — see §Idempotency. |

Eleven RPCs, all `SECURITY DEFINER`, pinned `search_path = public, pg_temp`,
`REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO
service_role` only:

`gv_execute_idempotent` (revoke only), `_gv_do_request`, `_gv_do_resend`,
`gv_prepare_verification_delivery`, `gv_finalize_verification_delivery`,
`_gv_do_verify`, `gv_verify_verification_challenge`, `_gv_do_revoke`,
`gv_consume_verification_proof`, `gv_get_verification_status`,
`gv_purge_expired_idempotency`.

The migration's own build-time `DO $verify$` block asserts every one of these
invariants (RLS enabled, zero policies, correct ACLs, append-only grants) and
**fails the migration** if any invariant is violated — the same
self-verifying-migration convention Workspace Invitations v5.1 established.

## Purpose registry

`server/services/verification/types.ts` defines a typed TypeScript
`Record<VerificationPurpose, PurposePolicy>` — **deliberately not a Postgres
enum**, so adding a ninth purpose someday needs no migration.

Purposes shipped (all `enabled: false`):

`signup_email`, `signup_phone`, `password_reset`, `login_step_up`,
`change_email`, `change_phone`, `sensitive_action`, `workspace_invitation`.

Each policy declares: allowed channel(s), OTP length, OTP TTL, delivery retry
window, resend cooldown, max sends per rolling window, max verification
attempts, proof TTL, whether authentication is required to request a
challenge, subject binding (`pending_account` / `user`), tenant binding
(`none` / `optional` / `required`), whether a new generation invalidates the
previous one, and whether successful verification issues a consumable proof.

`PLATFORM_MAXIMUMS` hardcodes server-side ceilings (and one floor — the
resend-cooldown minimum) that `clampPolicy()` enforces unconditionally,
including on the test-only override hook — **no policy, override, or future
tenant setting can exceed a platform maximum, only tighten within it.**

`assertPurposeEnabled` / `assertChannelAllowed` are the dormancy gate. They
are the first call in every `service.ts` entry point, and they throw before
any Supabase client is constructed — a disabled purpose cannot create a
database row or send anything, by construction, not by convention.

## Lifecycle

```
pending_delivery -> provider_accepted -> verified -> (proof consumed)
                  -> delivery_failed (permanent_failure / unconfigured / derivation_key_unavailable)
                                       -> locked (attempt_count >= max_attempts)
                                       -> expired
                                       -> revoked (resend supersedes, or explicit revoke)
```

There is no separate delivery-job state machine — `pending_delivery` exists
only for the instant between the atomic prepare call and the atomic
finalize call inside one Express request; by the time that request
returns, the challenge is already in a terminal delivery status. A
`retryable_failure` or `ambiguous` delivery outcome leaves the challenge
exactly where it was (still `pending_delivery`) rather than moving it to
`delivery_failed` — see §Delivery for why, and for the full crash/
concurrency/replay matrix this implies.

- Only one *active* generation exists per (purpose, channel, subject,
  destination) at a time; a resend revokes the previous live generation and
  starts a new one (`_gv_do_request`, shared by request and resend).
- Verification is single-shot per challenge: once `verified`, no further
  verify attempt succeeds (`already_verified`), and once `locked`/`expired`/
  `revoked`, no attempt can succeed at all.
- A proof, once consumed, cannot be consumed again — `gv_consume_verification_proof`
  does the consume check and the row lock in the same statement.
- Wrong purpose, wrong channel, wrong subject, or wrong workspace binding on
  either verify or consume returns the **same generic failure shape** as a
  wrong code / not-found proof — no signal leaks which check failed.
- Verifying a challenge **never** mutates any `profiles`/`workspaces`/user
  business-data row. It only mutates `verification_challenges`,
  `verification_attempts`, and (on success) inserts a `verification_proofs`
  row. Any future consumer's business mutation is expected to call
  `gv_consume_verification_proof` from *within its own* transaction (see the
  Consumer Guide) so proof consumption and the business effect commit or
  roll back together.

## Idempotency — and why `verify` is not in the ledger

`gv_execute_idempotent` is a generic acquire-then-execute-then-commit
idempotency wrapper (same pattern as Workspace Invitations v5.1's
`wi_execute_idempotent`): insert-or-fetch the ledger row under `FOR UPDATE`,
replay `safe_result` if `result_state = 'committed'`, otherwise dispatch to
the real implementation and commit the result.

`request`, `resend`, and `revoke` go through this ledger — a retried request
with the same idempotency key must return the exact same result without
re-running side effects.

**`verify` deliberately does not.** A verify attempt is a counted, mutating
event against a shared attempt counter: two *different* wrong codes against
the same challenge must both increment the counter and both fail, and a
wrong-workspace attempt must never have its cached failure incorrectly
replayed for a subsequent *correct*-workspace attempt. Request-replay
semantics ("same key -> same result, no re-execution") are the wrong model
for that. `gv_verify_verification_challenge` calls `_gv_do_verify` directly;
concurrency safety comes from `_gv_do_verify`'s own `SELECT ... FOR UPDATE`
row lock on the challenge, not from the idempotency ledger. This is called
out at both the migration and `service.ts` call sites.

## Cryptography

See `docs/GENERIC_VERIFICATION_SECURITY.md` for the full threat-model writeup.
Summary: never store a raw OTP; a versioned keyed-HMAC pepper ring derives
and digests codes with domain separation over purpose, channel, challenge
handle, generation, destination hash, and key version; comparison is
constant-time; the challenge's *own recorded* key version is used for
verification, never the current one, so key rotation never invalidates a
code that was already sent.

## Delivery model — Express calls the provider directly, no worker

This is the canonical OTP architecture on `main` today, matching
`server/services/phoneVerification/index.ts`'s `issueChallenge()`: Express
calls the email/SMS provider abstraction (`server/services/email`,
`server/services/sms`) **synchronously, inside the same HTTP request** that
created or replayed the challenge. There is no `worker.ts`, no delivery-job
table, no claim/lease/heartbeat, no polling. `requestVerificationChallenge`/
`resendVerificationChallenge` in `service.ts` do all three steps:

1. **Prepare** (`gv_prepare_verification_delivery`) — atomically creates the
   challenge (or determines this is a replay/resume of a prior attempt) and
   commits, *before* any provider is contacted.
2. **Send** — Express derives the OTP deterministically from the committed
   challenge's own handle/destination-hash/key-version and calls
   `sendEmail`/`sendSms` directly.
3. **Finalize** (`gv_finalize_verification_delivery`) — atomically records
   what the provider actually did and moves the idempotency ledger to
   `committed`.

Provider success is recorded as `provider_accepted` — never `delivered` —
because this system has no delivery receipt channel from the provider.

### The crash/concurrency/replay matrix this implies

Because step 2 is a real network call sitting between two separate database
transactions, exactly-once delivery is not claimable, and this design does
not pretend otherwise. Each case below is directly exercised in
`src/test/integration/genericVerificationCore.pg.test.ts`:

| Scenario | What happens |
|---|---|
| DB commit (prepare) then connection loss | Ledger row left in `prepared` with `prepared_at` recorded. A retry with the same idempotency key within 30s (`IN_FLIGHT_STALE_SECONDS`) is rejected as `VERIFICATION_ALREADY_IN_FLIGHT` (test P2); after 30s it **resumes** — reuses the SAME committed challenge/handle and re-derives the identical code (test P1). |
| Provider accepted but Express lost the response | Recorded as `outcome: 'ambiguous'`, not success or failure — the challenge status is left unchanged. A resend is required to try again with a fresh code. |
| Provider accepted but `gv_finalize_verification_delivery` itself failed (RPC/transport loss) | The `request`/`resend` call throws; the ledger stays `prepared`. A caller retry within 30s is rejected as in-flight (safe); after that, it resumes and calls the provider AGAIN — genuine at-least-once delivery — then finalizes for real. The **database** state is never duplicated: `gv_finalize_verification_delivery` is itself idempotent on an already-`committed` key, and exactly one `verification_delivery_attempts` row is written per logical send even across a resumed retry (test P3). |
| Express crashed before ever calling the provider | Same as "DB commit then connection loss" above — the challenge exists but nothing was sent; a resumed retry sends for the first time. |
| Express crashed after calling the provider (response pending) | Same as "provider accepted but Express lost the response" — recorded `ambiguous`, resend required. |
| Same `requestId` replayed after the original committed | Returns the cached committed result; the provider is never called again (test B/C). |
| Concurrent identical requests | One does the real work; the other(s) either replay the committed result or, if they land while the first is still mid-flight, are rejected outright rather than double-sending (test B/C, P2). |
| Same idempotency key, different payload | Rejected with `IDEMPOTENCY_KEY_REUSED` / `VerificationIdempotencyConflictError` — never silently reinterpreted as the new payload. |

**Why not a stable provider idempotency key?** That would close the
at-least-once gap above, but neither of this codebase's provider
abstractions (`server/services/email`, `server/services/sms`) accepts a
caller-supplied idempotency key today — extending them is out of scope for
this pass. What this design DOES guarantee without one: the database never
ends up with two challenges, two proofs, or two delivery-evidence rows for
one logical send; only the external provider call itself can happen twice,
and only in the crash windows above.

Because every purpose ships disabled, and the dormancy gate stops a
challenge from ever being created, none of this delivery machinery runs at
all in production today.

## Localization

`server/services/verification/locale.ts` reuses the same effective-locale
resolution order already proven by Workspace Invitations v5.1: explicit
selection on the request wins; otherwise the workspace's configured default;
otherwise the app-wide fallback. **`Accept-Language` never overrides the
configured default.** The resolved locale is frozen onto the challenge row
at creation time and is not re-resolved on delivery or verification.
`templates.ts` ships complete fa (RTL), tr, and en templates for both email
and SMS.

## Abuse prevention

Rate limiting is enforced **in the database**, inside the same transaction
that would create a challenge — not only at the Express middleware layer.
`_gv_do_request` checks a rolling-window send cap and a resend cooldown
against `verification_challenges.created_at` for the (destination hash,
purpose, channel) tuple before any row is written. IPs are hashed with
IPv6 /64-prefix collapsing (`collapseIpForRateLimit`/`hashIpForRateLimit`) —
a deliberate improvement over both reference systems, neither of which
collapses IPv6 prefixes, so a single actor rotating within one /64 cannot
evade the bucket. Verification failures increment a per-challenge attempt
counter that locks the challenge at the policy's `maxVerificationAttempts`.
All identifiers (destination, subject reference, IP) are hashed before
storage or comparison; no raw OTP, proof token, or pepper is ever logged,
audited, or stored in the idempotency ledger's `safe_result`.

## What this pass does NOT do

- No new consumer is wired: signup, password reset, and phone verification
  are unchanged and do not import this module.
- No new public HTTP endpoint exposes any of this.
- No existing invitation OTP record is migrated into these tables.
- No generic OTP is ever sent in production, because every purpose is
  disabled and the dormancy gate is unconditional.
- No Supabase Auth / GoTrue / `auth.uid()` / Edge Function is introduced.

See `docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md` for how a future consumer
would integrate, and `docs/GENERIC_VERIFICATION_SECURITY.md` for the full
security/cryptography/rate-limit/key-rotation writeup.
