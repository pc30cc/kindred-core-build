# Generic Verification Core v1

**Status: implemented and dormant.** No signup, password-reset, phone-verification,
login-step-up, email-change, phone-change, sensitive-action, or other flow calls
into this subsystem yet. It ships disabled-by-default at **two independent
layers** — the TypeScript purpose registry AND the database's own
`gv_is_purpose_enabled` function (see §Dormancy) — so its presence changes no
existing user-visible behavior, and a bug in either layer alone cannot enable
a purpose.

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
  types.ts        purpose registry, policy clamping, dormancy gate,
                   assertPolicyBindings (auth/subject/tenant enforcement)
  crypto.ts        versioned keyed-HMAC pepper ring, OTP derivation/digest,
                   deterministic proof-token derivation + hashing,
                   IPv4/IPv6-safe rate-limit hashing
  destination.ts   email/phone normalization (reuses phoneVerification's
                   E.164 normalizer)
  locale.ts        effective-locale resolution (explicit -> workspace
                   default -> app fallback; Accept-Language never wins)
  templates.ts     fa/tr/en OTP email + SMS templates
  service.ts       the 6 internal APIs (see below) — also where the
                   Express-direct provider send happens (no worker.ts)

server/services/email/index.ts   sendPlatformEmail() — workspace-less
                                  (pre-account) email path, see §Workspace-less email

database/migrations/098_generic_verification_core.sql   self-host chain
supabase/migrations/20260902185146_generic_verification_core.sql  hosted mirror
```

Nothing under `server/routes/` calls into `server/services/verification/`.
There is no `server/services/verification/worker.ts` and nothing under
`worker/index.ts`'s `WORKER_KIND` dispatcher references this subsystem —
see §Delivery below for why a worker was never needed. The only callers of
`service.ts` are the test suites listed under Testing below.

## Database objects

Five domain-neutral tables, all RLS-enabled with **zero policies** (deny-all
for `anon`/`authenticated`; `service_role` reaches them via `BYPASSRLS`, not
a policy) and no Data API grants:

| Table | Purpose |
|---|---|
| `verification_challenges` | One row per OTP challenge (generation, code digest, key version, status, attempt/max counters, expiry). Supports pre-account challenges — `subject_ref`/`workspace_id` are optional. |
| `verification_attempts` | Append-only log of every verification attempt (correct/incorrect), no UPDATE/DELETE grant. |
| `verification_proofs` | One row per issued proof (hash only, never the raw token), single-consume. Carries `proof_key_version` (the OTP/proof key version the token was issued under) and `destination_normalized`/`destination_hash`/`destination_hash_key_version`, copied from the LOCKED challenge at verify time — see §Proofs are bound to their verified destination. |
| `verification_delivery_attempts` | Append-only evidence of every Express-side provider submission (outcome, provider name/message id, error code) — not a job queue: no claim/lease/status-transition columns, because there is no worker. |
| `verification_idempotency` | Generic request-idempotency ledger for `request`/`resend`/`verify`/`revoke`, with a `prepared`/`committed`/`failed` state machine that is also the crash-recovery hinge for the two-phase Express-direct delivery model (see §Delivery) and, since this pass, for crash-safe idempotent `verify` too (see §Idempotency). Carries an `attempt_token uuid` column — the delivery-attempt ownership token (see §Delivery). |

Twelve RPCs, split into two disjoint sets (see §RPC isolation):

- **Internal (6)** — `NEVER` granted to anyone, not even `service_role`:
  `_gv_create_challenge_row`, `_gv_do_request`, `_gv_do_resend`,
  `_gv_do_verify`, `_gv_do_revoke`, `gv_is_purpose_enabled`.
- **Public wrappers (6)** — the ONLY verification RPCs ever executable by
  `service_role`, never by `anon`/`authenticated`/`PUBLIC`:
  `gv_prepare_verification_delivery`, `gv_finalize_verification_delivery`,
  `gv_execute_idempotent`, `gv_consume_verification_proof`,
  `gv_get_verification_status`, `gv_purge_expired_idempotency`.

All twelve are `SECURITY DEFINER`, pinned `search_path = public, pg_temp`.

The migration's own build-time `DO $verify$` block asserts every one of these
invariants (RLS enabled, zero policies, correct ACLs, append-only grants,
internal-function unreachability, database-layer dormancy) and **fails the
migration** if any invariant is violated — the same self-verifying-migration
convention Workspace Invitations v5.1 established.

## RPC isolation — internal vs. public wrapper

Internal functions (`_gv_do_request`, `_gv_do_resend`, `_gv_do_verify`,
`_gv_do_revoke`, `_gv_create_challenge_row`, `gv_is_purpose_enabled`) are
`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` — **nobody**
can execute them directly, including the backend's own `service_role`
connection. They are reachable ONLY as nested calls from within a public
wrapper's own `SECURITY DEFINER` execution: PostgreSQL resolves a
nested-function-call's privilege check against the DEFINING role for the
duration of a `SECURITY DEFINER` function's execution, so a wrapper can
invoke an internal function it has no grant on, while the wrapper's OWN
caller never gains that same ability. `src/test/integration/
genericVerificationCore.pg.test.ts`'s test X2 proves this directly: even
`SET ROLE service_role; SELECT public._gv_do_request(...)` fails with
"permission denied."

## Dormancy — two independent layers

**TypeScript layer.** `assertPurposeEnabled` / `assertChannelAllowed` (and,
since this pass, `assertPolicyBindings` — see §Policy enforcement) are the
first calls in every `service.ts` entry point, and they throw before any
Supabase client is constructed — a disabled purpose cannot create a
database row or send anything, by construction, not by convention.

**Database layer.** `gv_is_purpose_enabled(_purpose text)` ships as a
hardcoded `SELECT _purpose = ANY(ARRAY[]::text[])` — an empty allow-list,
independent of the TypeScript registry. Every public wrapper RPC that can
write (`gv_prepare_verification_delivery`, `gv_execute_idempotent`,
`gv_consume_verification_proof`) checks this FIRST, before any ledger row is
even tentatively inserted. This means a bug that flips a purpose's
TypeScript `enabled` flag to `true` by mistake — or a direct `SET ROLE
service_role` SQL call bypassing `service.ts` entirely — still cannot create
a single database row for that purpose. Test X1 proves this directly against
the migration's own shipped function (not a test override): a direct
service-role RPC call for a disabled purpose produces zero writes to
`verification_challenges` and zero rows in `verification_idempotency` (the
tentative ledger insert rolls back with the rest of the rejected statement).

Enabling a purpose for real use requires editing **both** layers in a
reviewed deploy: (1) flipping `enabled: true` in
`server/services/verification/types.ts`, and (2) a new, additive migration
that adds the purpose's name to `gv_is_purpose_enabled`'s array — a
deliberate two-key change, never a single boolean flip in one layer.

*(The integration test suite needs to exercise a full purpose lifecycle
end-to-end against a real database, so its `beforeAll` installs an
additional, test-only `CREATE OR REPLACE FUNCTION` patch on
`gv_is_purpose_enabled` that allow-lists every purpose — the database-layer
analogue of the TypeScript-layer's own `__setPurposePolicyOverrideForTests`
hook. This is never part of what ships; test X1 explicitly reverts to the
real shipped function to prove the production posture before restoring the
test patch for the rest of the suite.)*

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
challenge, subject binding (`pending_account` / `user` / `anonymous`), tenant
binding (`none` / `optional` / `required`), whether a new generation
invalidates the previous one, and whether successful verification issues a
consumable proof.

`PLATFORM_MAXIMUMS` hardcodes server-side ceilings (and one floor — the
resend-cooldown minimum) that `clampPolicy()` enforces unconditionally,
including on the test-only override hook — **no policy, override, or future
tenant setting can exceed a platform maximum, only tighten within it.**

## Policy binding enforcement

Declaring `requiresAuth`, `subjectBinding`, or `tenantBinding` on a policy is
not enough by itself — `assertPolicyBindings(purpose, policy, ctx)` in
`types.ts` is called immediately after the dormancy gate, on **every**
mutation (`request`, `resend`, `verify`, `consume`), before any database
call:

- `requiresAuth: true` and no `authenticatedUserId` on the requester ->
  `VerificationAuthRequiredError`.
- `subjectBinding: 'user'` and no `subjectRef` supplied -> rejected. If
  `requiresAuth` is also true, `subjectRef` must equal `authenticatedUserId`
  — a caller cannot act on a subject that isn't their own authenticated
  identity.
- `tenantBinding: 'required'` and no `workspaceId` supplied -> rejected.
  `tenantBinding: 'none'` and a `workspaceId` IS supplied -> also rejected
  (a workspace-less purpose must never accidentally acquire a tenant scope).
- A caller-claimed `subjectKind` that doesn't match the policy's
  `subjectBinding` -> rejected.

Every check is a **strict presence/equality test** — there is no "only check
if the caller happened to supply the field" branch. Omitting `subjectRef` or
`workspaceId` can never relax a requirement that exists; it can only ever
make a strict check fail. This is enforced independently again at the
database layer (see the next section) for `verify`/`resend`/`consume`, using
`IS DISTINCT FROM` comparisons that are correctly NULL-safe in the same
direction: an existing challenge's real binding always wins over whatever
the caller did or didn't supply.

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

- Only one *active* generation exists per logical challenge at a time. A
  **resend is handle-based**, never destination-based: `resendVerificationChallenge`
  requires the EXISTING challenge's own `handle` and its claimed scope
  (purpose/channel/subjectKind/subjectRef/workspaceId), which is
  re-validated server-side, under a row lock, against that challenge's own
  recorded scope BEFORE anything is superseded (`_gv_do_resend`). A resend
  that claims the wrong workspace or the wrong subject for an existing
  handle is rejected with a generic `VERIFICATION_SCOPE_MISMATCH` — the same
  response whether the handle doesn't exist or exists under a different
  scope — and the targeted challenge is left completely untouched. This
  closes what would otherwise be a cross-tenant/cross-subject leak: two
  different workspaces (or two different subjects) that happen to share the
  same destination can never have a resend meant for one revoke a live
  challenge belonging to the other (tests Y1, Y2).
- Verification is single-shot per challenge in terms of OUTCOME: once
  `verified`, no further verify attempt succeeds (`already_verified`), and
  once `locked`/`expired`/`revoked`, no attempt can succeed at all. But see
  §Idempotency below — a verify call itself is now idempotent-by-construction
  per `requestId`, which is a separate axis from this outcome state machine.
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

## Idempotency — including crash-safe `verify`

`gv_execute_idempotent` is a generic acquire-then-execute-then-commit
idempotency wrapper (same pattern as Workspace Invitations v5.1's
`wi_execute_idempotent`): insert-or-fetch the ledger row under `FOR UPDATE`,
replay `safe_result` if `result_state = 'committed'`, otherwise dispatch to
the real implementation and commit the result. `request`/`resend` use a
dedicated two-phase variant (`gv_prepare_verification_delivery` /
`gv_finalize_verification_delivery` — see §Delivery) because Express's
provider call sits between two separate database commits; `verify` and
`revoke` dispatch through `gv_execute_idempotent` directly, since neither has
an external call in the middle.

**`verify` is idempotent on a caller-supplied `requestId`** (a required
field on `VerifyChallengeInput` — never optional). The idempotency
fingerprint includes the candidate code digest and the full claimed scope
(purpose, channel, workspace, subject), so:

- the SAME `requestId` with the SAME code/scope replays the committed
  result exactly — no second attempt is counted, no second proof row is
  inserted (test V1);
- the SAME `requestId` with a DIFFERENT code or scope is rejected as
  `IDEMPOTENCY_KEY_REUSED` (`VerificationIdempotencyConflictError`), never
  silently re-interpreted as the new payload (test V2);
- replaying an identical WRONG-code verify under the same `requestId` does
  NOT double-increment the attempt counter (test V3);
- a NEW `requestId` against the same challenge, even with the same wrong
  code, always genuinely re-executes and counts as a new attempt (test V4);
- concurrent identical verify calls (same `requestId`) serialize on the
  ledger row's `FOR UPDATE` lock and produce exactly one attempt and one
  proof (test V5);
- a transport loss AFTER a verify call successfully commits (the database
  committed a `verified` status and a proof row, but the HTTP response never
  reached the caller) is recovered by simply retrying with the SAME
  `requestId` — the replayed result reports the SAME `proofIssued` flag, and
  the raw proof token is **re-derived deterministically** (see §Cryptography)
  rather than replayed from storage, since the raw token is never persisted
  anywhere (test V6).

This replaces an earlier design where `verify` deliberately bypassed the
idempotency ledger and generated a random proof token per call — that design
could not survive a transport-loss-after-commit scenario (the caller would
have no way to recover the already-issued, already-consumable proof) and is
no longer how this subsystem works.

## Cryptography

See `docs/GENERIC_VERIFICATION_SECURITY.md` for the full threat-model writeup.
Summary: never store a raw OTP or a raw proof token; a versioned keyed-HMAC
pepper ring derives and digests OTP codes with domain separation over
purpose, channel, challenge handle, generation, destination hash, and key
version. **Proof tokens are derived the same way** — deterministically, from
`(purpose, channel, handle, requestId)` and an explicit key version, never a
fresh random draw — which is what makes a verify replay able to reproduce
the exact same, still-usable raw token without ever persisting it (only its
hash is stored, in `verification_proofs.proof_hash`). Comparison is
constant-time; the challenge's *own recorded* key version is used for OTP
verification, never the current one, so key rotation never invalidates a
code that was already sent (or a proof that was already issued).

### Two independent rotation domains

`crypto.ts` deliberately separates two kinds of key-versioned material that
must NOT share a "current version" pointer:

1. **Rotating material** — OTP codes and proof tokens. These are keyed by
   the SPECIFIC version recorded on the individual row
   (`verification_challenges.key_version`, `verification_proofs.proof_key_version`)
   — never "whichever version happens to be current when the row is later
   read again." A proof token is now self-describing: it has the shape
   `gvp_v<N>_<base64url-value>`, strictly parsed by a
   `/^gvp_v([1-9][0-9]*)_([A-Za-z0-9_-]{43})$/` pattern (the value MUST be
   exactly 43 characters — the encoded length of a 32-byte digest, never
   truncated or oversized) plus a bounded-version check
   (`parseProofToken`/`InvalidProofTokenFormatError`), so `hashProofToken`
   recovers its key version from the token itself and never needs (or
   accepts) an externally supplied "current" version. This is what makes a
   proof issued under key v1 still consumable after rotation to v2 (test
   KR4), and what makes a verify-replay after rotation still reproduce the
   identical `gvp_v1_...` token rather than a `gvp_v2_...` one (test KR3).
   `_gv_do_verify` re-checks the same invariants (matching key version,
   canonical hash shape, bounded TTL) at the database layer before ever
   inserting a proof row, aborting the whole transaction on any violation
   (tests PI1, PI2) — see docs/GENERIC_VERIFICATION_SECURITY.md.
2. **Stable index material** — destination hash, subject-ref hash, IP
   rate-limit hash, the idempotency key, and the request fingerprint. These
   are pinned to a fixed `STABLE_INDEX_KEY_VERSION = 1` constant, completely
   independent of `GENERIC_VERIFICATION_KEY_VERSION` (the OTP/proof
   rotation pointer). It is deliberately not an environment variable, and
   rotating it is NOT something a migration can do automatically: these
   are HMACs over the ORIGINAL raw input (the actual email/phone, IP, or
   request id), and this codebase does not retain those raw inputs
   anywhere once hashed — nothing can "recompute every stored hash" after
   the fact. The only supported procedure is to quiesce verification
   traffic, wait for every challenge/proof/rate-limit window/idempotency
   entry to expire, purge the expired rows, THEN change the constant and
   deploy (or implement a genuinely version-aware dual-read migration,
   which this codebase does not have) — see
   docs/GENERIC_VERIFICATION_SECURITY.md's "Key management and rotation"
   for the full procedure. Without this separation, rotating the OTP key
   would silently change what a resend/replay/rate-limit lookup hashes to,
   breaking in-flight challenges and letting rotation reset rate-limit
   buckets (tests KR1, KR2, KR5a/b/c).

`currentVerificationKeyVersion()` (the rotation pointer) is used ONLY when
originating a NEW artifact — a fresh challenge or a fresh proof — never when
re-hashing or re-validating an EXISTING one.

## Proofs are bound to their verified destination

`verification_proofs` carries `destination_normalized`, `destination_hash`,
and `destination_hash_key_version`, copied from the LOCKED challenge row at
the moment `_gv_do_verify` issues the proof — never from caller input.
`gv_consume_verification_proof` returns this authoritative destination
(`ConsumeProofResult.destinationNormalized`) rather than accepting one: a
future consumer for `signup_email`/`signup_phone`/`change_email`/
`change_phone` is expected to use exactly this returned value for its
business mutation, never a client-supplied "new email"/"new phone" field.
This makes "a proof issued for destination A authorizes a mutation to
destination B" structurally impossible rather than merely validated against
— there is no field in `ConsumeProofInput` a caller could set to redirect
it. Tests DB1–DB4 prove this for all four destination-bearing purposes.

## Canonical lock order

Every RPC entry point that can touch both a workspace/scope-level lock and a
challenge-row lock acquires the workspace/scope lock FIRST, consistently:
`_gv_do_request`, `_gv_do_resend`, and `_gv_do_revoke` all lock in that same
order. (`_gv_do_resend` previously locked the challenge row before the
workspace row — the reverse of `_gv_do_request` — a real deadlock risk under
concurrent request-vs-resend traffic; this has been corrected to match the
documented invariant.) Tests LOCK1–LOCK3 exercise request-vs-resend,
request-vs-revoke, and resend-vs-revoke concurrently against two DIFFERENT
challenges in the same workspace (a bounded lock timeout via
`statement_timeout`), asserting no deadlock, no duplicate active challenge,
and a consistent final state.

## Scoped, authorized revoke

`revokeVerificationChallenge` takes the same shape of scope/authorization
context as `verify`/`resend`: `channel`, `workspaceId`, `subjectRef`, and the
requester's `authenticatedUserId`. It calls `assertChannelAllowed` and
`assertPolicyBindings` before any database call, exactly like every other
mutating entry point, and `_gv_do_revoke` re-validates the claimed scope
under a row lock with the same NULL-safe `IS DISTINCT FROM` comparisons
`_gv_do_verify` uses — a wrong workspace, wrong subject, wrong channel, or an
unauthenticated caller on a `requiresAuth` purpose all receive the same
generic rejection and never modify the challenge or its proof (tests
REV1–REV4). This replaces an earlier, narrower revoke contract that took
only `handle`/`purpose`/`reason` and ran as an unauthenticated `system`
actor with no scope check at all.

## Delivery model — Express calls the provider directly, no worker

This is the canonical OTP architecture on `main` today, matching
`server/services/phoneVerification/index.ts`'s `issueChallenge()`: Express
calls the email/SMS provider abstraction (`server/services/email`,
`server/services/sms`) **synchronously, inside the same HTTP request** that
created or replayed the challenge. There is no `worker.ts`, no delivery-job
table, no claim/lease/heartbeat, no polling. `requestVerificationChallenge`/
`resendVerificationChallenge` in `service.ts` do all three steps:

1. **Prepare** (`gv_prepare_verification_delivery`) — atomically creates the
   challenge (or determines this is a replay/resume of a prior attempt),
   commits *before* any provider is contacted, and returns a fresh
   `attemptToken` (rotated on every fresh AND resumed prepare call).
2. **Send** — Express derives the OTP deterministically from the committed
   challenge's own handle/generation/destination-hash/key-version and calls
   `sendEmail`/`sendPlatformEmail`/`sendSms` directly.
3. **Finalize** (`gv_finalize_verification_delivery`) — requires and
   validates the SAME `attemptToken` from step 1, atomically records what
   the provider actually did, and moves the idempotency ledger to
   `committed`.

Provider success is recorded as `provider_accepted` — never `delivered` —
because this system has no delivery receipt channel from the provider.

### Delivery-attempt ownership token

A time-based staleness heuristic alone (`prepared_at` older than 30 seconds
⇒ "probably crashed, safe to resume") is a guess, not a proof: the "crashed"
attempt's provider call might simply still be running. `attempt_token`
(a `uuid` column on `verification_idempotency`) closes the resulting race:

- Every `gv_prepare_verification_delivery` call that reaches the CASE
  dispatch or the resume branch generates a NEW random token and stores it
  as the row's CURRENT token, returning it to the caller.
- `gv_finalize_verification_delivery` requires the caller's token to match
  the CURRENT one on the row (`_row.attempt_token IS DISTINCT FROM
  _attempt_token`). A mismatch is a **soft** rejection — `{applied: false,
  reason: 'stale_attempt_token', result: <current ledger state>}` — never an
  exception, since the caller made a real provider call in good faith and
  needs a coherent response, not a crash.

This guarantees the database is never left inconsistent even when the
30-second heuristic guesses wrong: if the "crashed" attempt was actually
still alive, BOTH it and the resumed attempt may genuinely submit to the
provider (an accepted, documented at-least-once cost — see the matrix
below), but only the LATEST token holder's finalize call can ever record an
outcome. Test AA1 proves this directly: a stale attempt's finalize call is
rejected softly, the resumed attempt's finalize succeeds, and exactly one
`verification_delivery_attempts` row exists afterward — the stale call wrote
nothing.

### The crash/concurrency/replay matrix this implies

Because step 2 is a real network call sitting between two separate database
transactions, exactly-once delivery is not claimable, and this design does
not pretend otherwise. Each case below is directly exercised in
`src/test/integration/genericVerificationCore.pg.test.ts`:

| Scenario | What happens |
|---|---|
| DB commit (prepare) then connection loss | Ledger row left in `prepared` with `prepared_at` recorded. A retry with the same idempotency key within 30s (`IN_FLIGHT_STALE_SECONDS`) is rejected as `VERIFICATION_ALREADY_IN_FLIGHT` (test P2); after 30s it **resumes** — reuses the SAME committed challenge/handle, rotates the attempt token, and re-derives the identical code (test P1). |
| Provider accepted but Express lost the response | Recorded as `outcome: 'ambiguous'`, not success or failure — the challenge status is left unchanged. A resend is required to try again with a fresh code. |
| Provider accepted but `gv_finalize_verification_delivery` itself failed (RPC/transport loss) | The `request`/`resend` call throws; the ledger stays `prepared`. A caller retry within 30s is rejected as in-flight (safe); after that, it resumes (rotating the attempt token), calls the provider AGAIN — genuine at-least-once delivery — then finalizes for real. The **database** state is never duplicated: `gv_finalize_verification_delivery` is itself idempotent on an already-`committed` key, and exactly one `verification_delivery_attempts` row is written per logical send even across a resumed retry (test P3). |
| A stale-heuristic resume races a still-alive prior attempt's finalize call | The prior attempt's OLD token no longer matches the row's rotated CURRENT token — its finalize call is rejected softly (`stale_attempt_token`), never overwriting what the resumed attempt recorded (test AA1). |
| Express crashed before ever calling the provider | Same as "DB commit then connection loss" above — the challenge exists but nothing was sent; a resumed retry sends for the first time. |
| Express crashed after calling the provider (response pending) | Same as "provider accepted but Express lost the response" — recorded `ambiguous`, resend required. |
| Same `requestId` replayed after the original committed | Returns the cached committed result; the provider is never called again (test B/C). |
| Concurrent identical requests | One does the real work; the other(s) either replay the committed result or, if they land while the first is still mid-flight, are rejected outright rather than double-sending (test B/C, P2). |
| Same idempotency key, different payload | Rejected with `IDEMPOTENCY_KEY_REUSED` / `VerificationIdempotencyConflictError` — never silently reinterpreted as the new payload. |
| A genuinely unexpected internal failure during prepare (e.g. a constraint violation) | Caught, and the ledger row is marked `result_state = 'failed'` — this persistence is only correct because the risky dispatch is wrapped in its OWN nested `BEGIN/EXCEPTION` block, scoped so PL/pgSQL's implicit-savepoint rollback undoes only the failed dispatch's own effects, not the earlier tentative ledger row from the OUTER block (test DD2). |

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

## Workspace-less email

This core is meant to eventually serve pre-account flows — signup email
verification, password reset, email change — none of which have a workspace
to scope an email-provider config against. `server/services/email/
index.ts`'s existing `sendEmail()` hard-requires a `workspaceId` (it resolves
a provider via workspace-scoped settings, falling back to a global
`app_runtime_config.default_email_provider` row only as its LAST internal
step). `sendPlatformEmail()` is a new, additive function that resolves ONLY
that global platform-default step — no workspace-scoped lookup at all — and
dispatches through the same `sendViaResend`/`sendViaSendGrid`/`sendViaSMTP`
provider implementations. It deliberately does not write to `email_logs`,
which is workspace-scoped delivery history with no meaning for a send that
has no workspace.

`sendOtpDirect` in `service.ts` calls `sendPlatformEmail` whenever a
`request`/`resend` has no `workspaceId` bound (i.e. `channel: 'email'` and
`input.workspaceId` is absent) — replacing what used to be an unconditional
`unconfigured` result for every workspace-less email challenge. This is
still fully dormant in production: no purpose with `tenantBinding: 'none'`
is `enabled: true` today, so no route can ever reach this path. Tests CC1a/
CC1b prove the path works end-to-end — actually calling `sendPlatformEmail`,
never `sendEmail` — both when a platform provider is configured (successful
`provider_accepted`) and when none is (`unconfigured`, matching the real
production default).

## Localization

`server/services/verification/locale.ts` reuses the same effective-locale
resolution order already proven by Workspace Invitations v5.1: explicit
selection on the request wins; otherwise the workspace's configured default;
otherwise the app-wide fallback. **`Accept-Language` never overrides the
configured default.** The resolved locale is frozen onto the challenge row
at creation time and is not re-resolved on delivery or verification.
`templates.ts` ships complete fa (RTL), tr, and en templates for both email
and SMS.

## Abuse prevention — atomic rate-limit buckets

Rate limiting is enforced **atomically, in the database**, inside the same
transaction that creates a challenge — not only at the Express middleware
layer, and not via a racy count-then-insert. `_gv_create_challenge_row`
acquires a `pg_advisory_xact_lock` per bucket (auto-released at transaction
end) BEFORE counting, so concurrent requests targeting the SAME bucket
serialize instead of racing past a stale count:

| Bucket | Scope | Cap | Rationale |
|---|---|---|---|
| Destination | (destination hash, purpose, channel) | `maxPerWindow`, plus a resend cooldown | The original, tightest check — a fresh challenge to the same destination must also respect the cooldown, not just the rolling-window count. |
| IP (collapsed) | request IP, /64-collapsed for IPv6 | `maxPerWindow × 10` | Looser than per-destination: one IP legitimately serves many destinations. |
| Subject | (subject ref hash, purpose), when bound | `maxPerWindow` | Same cap as destination — a subject-bound purpose must not let one subject fan out across many destinations to evade the destination bucket. |
| Workspace | (workspace id, purpose), when bound | `maxPerWindow × 5` | Looser than per-subject: a busy workspace legitimately has many members triggering challenges independently. |
| Global (purpose+channel) | system-wide, **opt-in, disabled by default** | `PurposePolicy.globalRateLimit.maxPerWindow` over `.windowSeconds`, only when explicitly configured | See below — this replaces an earlier design that derived a platform-wide cap from `maxSendsPerWindow × 20`. |

The per-destination/IP/subject/workspace multipliers are a deliberate design
choice for this pass, not exact numbers specified elsewhere — documented
here and in the migration itself. Tests Z1–Z4 each prove one bucket's cap
holds EXACTLY under real concurrent load (`Promise.allSettled` against a
real database), not just under sequential calls.

### The global bucket is opt-in, not derived

An earlier design derived a platform-wide (purpose+channel) cap as
`maxSendsPerWindow × 20` — for a policy with `maxSendsPerWindow: 5`, that
caps the ENTIRE PLATFORM'S traffic for that purpose+channel at 100
requests/hour, through a single shared advisory lock that every unrelated
request would contend on. `PurposePolicy.globalRateLimit` is now an explicit,
independently configured `{ maxPerWindow, windowSeconds } | null` field,
defaulting to `null` for every shipped policy. When `null`,
`_gv_create_challenge_row` does not even acquire bucket 1's advisory lock —
there is no global hot lock in the normal request path at all. A deployment
that genuinely needs a platform-wide ceiling (or prefers an
infrastructure-level limiter instead) opts in explicitly with its own cap,
independent of any per-identifier limit. Test Z5a proves 25 concurrent
requests across unrelated destinations/subjects/IPs all succeed by default
(well past the old formula's would-be ceiling of 20); test Z5b proves an
explicitly configured `globalRateLimit` still enforces its own cap
atomically when a deployment opts in.

IPs are hashed with IPv6 /64-prefix collapsing
(`collapseIpForRateLimit`/`hashIpForRateLimit`) — a deliberate improvement
over both reference systems, neither of which collapses IPv6 prefixes, so a
single actor rotating within one /64 cannot mint a fresh bucket per request.
Verification failures increment a per-challenge attempt counter that locks
the challenge at the policy's `maxVerificationAttempts`. All identifiers
(destination, subject reference, IP) are hashed before storage or
comparison; no raw OTP, proof token, or pepper is ever logged, audited, or
stored in the idempotency ledger's `safe_result`.

## What this pass does NOT do

- No new consumer is wired: signup, password reset, and phone verification
  are unchanged and do not import this module.
- No new public HTTP endpoint exposes any of this.
- No existing invitation OTP record is migrated into these tables.
- No generic OTP is ever sent in production, because every purpose is
  disabled at BOTH the TypeScript and database layers, and the dormancy gate
  is unconditional.
- No Supabase Auth / GoTrue / `auth.uid()` / Edge Function is introduced.

See `docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md` for how a future consumer
would integrate, and `docs/GENERIC_VERIFICATION_SECURITY.md` for the full
security/cryptography/rate-limit/key-rotation writeup.
