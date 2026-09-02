# Generic Verification Core v1

**Status: implemented and dormant.** No signup, password-reset, phone-verification,
login-step-up, email-change, phone-change, sensitive-action, or other flow calls
into this subsystem yet. It ships disabled-by-default at every layer (purpose
registry, database rows, delivery jobs) so its presence changes no existing
user-visible behavior.

## Why this exists

The codebase has two independent, proven OTP/verification implementations:

- **Workspace Invitations v5.1** (`server/services/invitations/`,
  `database/migrations/077-097_workspace_invitations_v51_*.sql`) — invitation
  acceptance OTPs, keyed-HMAC pepper ring, idempotent RPC executor, worker
  lease/claim/heartbeat, fa/tr/en templates.
- **Phone Verification** (`server/services/phoneVerification/`) — signup-time
  phone OTPs, its own crypto/policy module.

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
  service.ts       the 6 internal APIs (see below)
  worker.ts        delivery worker: claim/heartbeat/complete/reclaim

database/migrations/098_generic_verification_core.sql   self-host chain
supabase/migrations/20260902185146_generic_verification_core.sql  hosted mirror
```

Nothing under `server/routes/` calls into `server/services/verification/`.
Nothing under `worker/index.ts`'s `WORKER_KIND` dispatcher registers
`server/services/verification/worker.ts`. The only callers are the test
suites listed under Testing below.

## Database objects

Six domain-neutral tables, all RLS-enabled with **zero policies** (deny-all
for `anon`/`authenticated`; `service_role` reaches them via `BYPASSRLS`, not
a policy) and no Data API grants:

| Table | Purpose |
|---|---|
| `verification_challenges` | One row per OTP challenge (generation, code digest, key version, status, attempt/max counters, expiry). Supports pre-account challenges — `user_id`/`workspace_id` are optional. |
| `verification_attempts` | Append-only log of every verification attempt (correct/incorrect), no UPDATE/DELETE grant. |
| `verification_proofs` | One row per issued proof (hash only, never the raw token), single-consume. |
| `verification_delivery_jobs` | Outbox row per send attempt: claim token, worker id, lease, attempt count, terminal states. |
| `verification_deliveries` | Append-only delivery evidence (provider name, provider message id, outcome) — never `delivered`, only `provider_accepted`. |
| `verification_idempotency` | Generic request-idempotency ledger for `request`/`resend`/`revoke` (see Idempotency below for why `verify` is excluded). |

Thirteen RPCs, all `SECURITY DEFINER`, pinned `search_path = public, pg_temp`,
`REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO
service_role` only:

`gv_execute_idempotent`, `_gv_do_request`, `_gv_do_resend`, `_gv_do_verify`,
`gv_verify_verification_challenge`, `_gv_do_revoke`,
`gv_consume_verification_proof`, `gv_get_verification_status`,
`gv_claim_verification_jobs`, `gv_heartbeat_verification_job`,
`gv_complete_verification_job`, `gv_reclaim_expired_verification_jobs`,
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
database row, a delivery job, or send anything, by construction, not by
convention.

## Lifecycle

```
pending_delivery -> provider_accepted -> verified -> (proof consumed)
                                       -> locked (attempt_count >= max_attempts)
                                       -> expired
                                       -> revoked (resend supersedes, or explicit revoke)
delivery job:  queued -> claimed -> provider_accepted | permanently_failed
```

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

## Delivery worker

`server/services/verification/worker.ts` reuses the existing email/SMS
provider abstractions (`server/services/email`, `server/services/sms`).
Claim/heartbeat/complete/reclaim mirror the Workspace Invitations v5.1
worker's lease pattern: `SELECT ... FOR UPDATE SKIP LOCKED` claiming, a claim
token that must match on heartbeat/complete (stale-claim rejection), bounded
batch claims, retry with backoff up to a max attempt count, and a distinct
`permanently_failed` terminal state. Provider success is recorded as
`provider_accepted` — never `delivered` — because this system has no delivery
receipt channel from the provider.

**Not registered in `worker/index.ts`'s `WORKER_KIND` dispatcher.** Because
every purpose ships disabled, and the dormancy gate stops a challenge/job
from ever being created, this worker has nothing to process in production
even if it were registered — but it is not registered, as a second layer of
dormancy.

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
