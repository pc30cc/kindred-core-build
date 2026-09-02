# Generic Verification Core v1 — Security

Companion to `docs/GENERIC_VERIFICATION_CORE.md` (architecture/lifecycle) and
`docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md` (integration pattern). This
document covers cryptography, key rotation, rate limiting, ACLs, and
monitoring in enough depth for a security reviewer to evaluate the subsystem
without reading the source.

## Threat model summary

This is a pre-authentication and step-up-authentication primitive. Its
attacker is anyone who can reach the (future) HTTP endpoints that would sit
in front of it: an unauthenticated attacker trying to enumerate accounts,
brute-force a code, or steal a proof; or an authenticated attacker in one
tenant trying to act against another tenant's challenge/proof. **No
production endpoint currently reaches this subsystem** — the analysis below
is what protects it once one does.

## Cryptography

- **No raw OTP code is ever stored.** `verification_challenges.code_digest`
  stores only the HMAC digest.
- **Deterministic derivation, not random-then-hash.** `deriveOtpCode()`
  derives the code from an HMAC over
  `(purpose, channel, challengeHandle, generation, destinationHash)` under a
  versioned key. This is the same technique proven by Workspace Invitations
  v5.1's OTP derivation, applied here to a different crash-safety need:
  since delivery is Express-direct (see `docs/GENERIC_VERIFICATION_CORE.md`
  §Delivery — no worker), a resumed request after a crash between prepare
  and finalize re-derives the EXACT SAME code from the already-committed
  challenge's own handle/destination-hash/key-version, without a second
  database round-trip and without ever persisting the raw code anywhere for
  anything to read back.
- **Domain separation.** The HMAC input includes purpose, channel, challenge
  handle, generation, destination hash, *and* key version, so a digest
  computed for one purpose/channel/generation/destination can never collide
  with or be replayed against another — even under the same base secret.
- **Constant-time comparison.** `verifyOtpDigest()` uses
  `crypto.timingSafeEqual` and returns `false` (never throws) on a length
  mismatch, so a malformed candidate can't be distinguished from a
  wrong-but-well-formed one by response timing or by exception vs. return
  value.
- **No unkeyed SHA-256 anywhere in this module.** Every digest that touches
  a secret uses HMAC with a configured key; identifiers that don't need
  secrecy (destination hash for indexing, IP hash for rate-limit bucketing)
  still use a keyed HMAC via the same pepper, so they can't be pre-computed
  or dictionary-matched offline without the pepper.
- **Proof tokens are deterministically derived, exactly like OTP codes** —
  `deriveProofToken()` derives the raw token from an HMAC over
  `(purpose, channel, handle, requestId)` under an explicit key version,
  never a fresh random draw. This is what makes `verify` itself crash-safe
  and idempotent (see `docs/GENERIC_VERIFICATION_CORE.md` §Idempotency): a
  transport loss after a verify call successfully commits is recovered by
  retrying with the SAME `requestId`, which re-derives the IDENTICAL raw
  token — still valid, still hashing to the same stored value — without the
  raw token ever having been persisted anywhere. Only `hashProofToken()`'s
  output is ever stored, in `verification_proofs.proof_hash`.
- **Proof tokens are version-self-describing.** A raw token has the shape
  `gvp_v<N>_<base64url-value>`, strictly validated by
  `parseProofToken()`/`InvalidProofTokenFormatError` against
  `/^gvp_v([1-9][0-9]*)_([A-Za-z0-9_-]+)$/`. `hashProofToken()` parses the
  version out of the token itself rather than accepting or defaulting to an
  externally supplied "current" version — see §Two rotation domains below
  for why this matters for correctness across a key rotation.
- **Proofs are bound to their verified destination, one-way only.**
  `verification_proofs.destination_normalized`/`destination_hash`/
  `destination_hash_key_version` are copied from the LOCKED challenge row at
  the moment of issuance (`_gv_do_verify`), never accepted from caller input,
  and `gv_consume_verification_proof` RETURNS this value rather than
  accepting one. There is no field anywhere a caller could set to redirect a
  proof issued for destination A into authorizing a mutation against
  destination B for `signup_email`/`signup_phone`/`change_email`/
  `change_phone` — the property is structural, not merely validated
  (tests DB1–DB4 in `src/test/integration/genericVerificationCore.pg.test.ts`).

## Key management and rotation

Three environment variables (names only — see `.env.example` for where they
are declared; no values are documented here or anywhere else in this
codebase):

- `GENERIC_VERIFICATION_PEPPER` — required, minimum 32 bytes. Occupies key
  version 1 in the ring.
- `GENERIC_VERIFICATION_PEPPER_RING` — optional JSON object mapping key
  version (string) to secret, e.g. `{"1": "...", "2": "..."}`, for holding
  multiple historical keys simultaneously during a rotation window.
- `GENERIC_VERIFICATION_KEY_VERSION` — optional; the *current* key version
  used for new challenges. Defaults to the highest version present in the
  ring.

**Rotation procedure:**
1. Add the new secret to `GENERIC_VERIFICATION_PEPPER_RING` under a new,
   higher version number, alongside the existing (still-valid) versions.
2. Bump `GENERIC_VERIFICATION_KEY_VERSION` to that new version. New
   challenges are created with the new version from this point on.
3. Once every challenge created under the old version has expired (its TTL
   has elapsed — `otpTtlSeconds` per purpose, capped at
   `PLATFORM_MAXIMUMS.otpTtlSeconds`), the old version may be removed from
   the ring.

**Why this never breaks an in-flight code:** `verification_challenges.key_version`
records the key version *at creation time*. Verification always recomputes
the candidate digest using **that recorded version**, not the current one
(`server/services/verification/service.ts::verifyVerificationChallenge`
reads `key_version` from the challenge row before computing anything). A key
rotation therefore never invalidates a code that was already sent — only a
version being *removed from the ring* does, and that is a fail-closed
decision (see next point), not a silent failure.

**Fail-closed on a missing historical key.** If a challenge's recorded
`key_version` is no longer present in `GENERIC_VERIFICATION_PEPPER_RING` (it
was rotated out too early), `deriveOtpCode`/`digestOtpCode`/`candidateOtpDigest`
throw `DerivationKeyUnavailableError` rather than silently falling back to
the current key — a wrong-key digest would never match anyway, but silent
fallback would mask an operational mistake (removing a key while challenges
under it are still live) as an ordinary wrong-code response. Tested in
`src/test/verification/purposeDormancy.test.ts`.

**Missing pepper entirely** throws `VerificationPepperMissingError` at first
use, not at process start with an unclear stack trace — this fails the very
first `requestVerificationChallenge`/verify call loudly and specifically.

**Key isolation.** `crypto.ts` sub-derives its working keys from the base
pepper with a labeled HKDF-style derivation (`subKey(label, version)`) rather
than using the raw pepper bytes directly, and asserts the configured pepper
does not textually match another subsystem's secret — this subsystem's key
material is cryptographically independent of Workspace Invitations v5.1's
pepper ring and Phone Verification's key material, even if an operator
accidentally reused an environment variable value.

### Two rotation domains — rotating material vs. stable index material

The rotation procedure above governs OTP codes and proof tokens — material
that is *supposed* to move to a new key version over time. A second,
independent category of derived material must NEVER move with that
rotation, or every in-flight challenge, resend, and rate-limit bucket would
silently break the moment `GENERIC_VERIFICATION_KEY_VERSION` changes:

- **Rotating material**: `deriveOtpCode`/`digestOtpCode` (keyed by the
  challenge's own recorded `key_version`) and `deriveProofToken`/
  `hashProofToken` (keyed by the version embedded in the `gvp_v<N>_...`
  token itself). Both always use the SPECIFIC version recorded on the row
  or token being re-validated, never "whatever version is current right
  now."
- **Stable index material**: `hashDestination`, `hashSubjectRef`,
  `hashIpForRateLimit`, `deriveIdempotencyKey`, and
  `deriveRequestFingerprint` are all pinned to a fixed
  `STABLE_INDEX_KEY_VERSION = 1` constant in `crypto.ts` — completely
  decoupled from `GENERIC_VERIFICATION_KEY_VERSION`. This is deliberately
  NOT an environment variable: changing it would require a dedicated
  re-indexing migration to recompute every existing row's stored hash under
  the new version, since these hashes are used as lookup/matching keys
  (finding an existing challenge by handle+scope, matching a rate-limit
  bucket, replaying an idempotency key), not as secrets that need periodic
  rotation.

**Why this separation is a security-relevant correctness property, not just
an implementation detail:** without it, rotating the OTP/proof key would
silently change what a resend or an idempotency replay hashes a
destination/subject/IP to, causing a legitimate resend to be misclassified
as a scope mismatch, an idempotent replay to miss its own ledger row (and
re-execute), and — most seriously — every rate-limit bucket to reset simply
because an operator rotated a key for unrelated cryptographic-hygiene
reasons, defeating the abuse protection described below at the exact moment
an operator is doing routine key maintenance. Tests KR1 (idempotent replay
survives rotation), KR2 (a user-bound resend+verify survives rotation),
KR5a/b/c (destination/subject/IP buckets are NOT reset by rotation) and KR6
(removing a historical key fails closed for a still-live challenge, then
recovers once restored) exercise this directly against a real database.

## Rate limiting and abuse prevention

Enforced ATOMICALLY in the database, inside the same transaction that would
create a row — not only in Express middleware (which can be bypassed by any
direct caller and does not coordinate across multiple server instances), and
not via a racy count-then-insert. `_gv_create_challenge_row` takes a
`pg_advisory_xact_lock` per bucket (auto-released at transaction commit or
rollback) BEFORE counting, so concurrent requests targeting the SAME bucket
serialize on the lock instead of all reading a stale count and all deciding
independently that they're under the cap:

| Bucket | Scope | Cap |
|---|---|---|
| Destination | (destination hash, purpose, channel) | `maxSendsPerWindow`, plus a resend cooldown |
| IP (collapsed) | request IP, /64-collapsed for IPv6 | `maxSendsPerWindow × 10` |
| Subject | (subject ref hash, purpose), when bound | `maxSendsPerWindow` |
| Workspace | (workspace id, purpose), when bound | `maxSendsPerWindow × 5` |
| Global (purpose+channel) | system-wide, **opt-in, disabled by default** | `PurposePolicy.globalRateLimit.maxPerWindow` over `.windowSeconds`, only when a deployment explicitly configures it |

Tests Z1–Z4 in `src/test/integration/genericVerificationCore.pg.test.ts` each
fire real concurrent (`Promise.allSettled`) requests against one bucket and
assert the cap holds EXACTLY — not "approximately," which is what a
count-then-insert race would produce under load.

**The global bucket is opt-in, not derived from the per-identifier limit —
a P1 correctness/availability fix.** An earlier design derived the
platform-wide (purpose+channel) cap as `maxSendsPerWindow × 20`: for a
policy with `maxSendsPerWindow: 5`, that silently caps the ENTIRE
platform's traffic for that purpose+channel at 100 requests/hour, and every
unrelated request — regardless of destination, subject, or workspace —
would contend on the SAME `pg_advisory_xact_lock`, i.e. a single global hot
lock in the normal request path. `PurposePolicy.globalRateLimit` is now an
explicit `{ maxPerWindow, windowSeconds } | null` field, `null` for every
shipped policy; when `null`, `_gv_create_challenge_row` does not acquire
that advisory lock at all. Test Z5a proves 25 concurrent requests spread
across unrelated destinations/subjects/IPs all succeed by default — well
past the old formula's would-be ceiling of 20 — and test Z5b proves an
explicitly configured `globalRateLimit` still enforces its own cap
atomically once a deployment opts in.

- **Resend cooldown** (destination bucket only): checks
  `max(created_at) FOR (destination_hash, purpose, channel) > now() - cooldown`
  before creating a new challenge row. Floor: `PLATFORM_MAXIMUMS.resendCooldownSecondsMin`
  (a policy may not set a *shorter* cooldown than this, even via override).
- **Verification-attempt limiting**: each wrong code increments
  `verification_challenges.attempt_count`; reaching `max_attempts` locks the
  challenge (`status = 'locked'`) — no further attempt, correct or not, can
  succeed against a locked challenge.
- **IPv4/IPv6-safe bucketing**: `collapseIpForRateLimit()` collapses an IPv6
  address to its /64 prefix before hashing, so rotating within one /64 (a
  single actor's typical residential/mobile IPv6 allocation) does not evade
  the bucket. This is a deliberate improvement over both reference systems
  (`server/utils/clientIp.ts` and `server/services/phoneVerification/crypto.ts`),
  neither of which collapses IPv6 prefixes.
- **Destination normalization before hashing**: email/phone are normalized
  (case, E.164) before `hashDestination()`, so `Foo@Example.com` and
  `foo@example.com` bucket identically and can't be used to fan out around
  the rate limit.
- **Uniform errors, no account-existence leakage**: verifying a
  non-existent handle returns the exact same `{ ok: false, reason:
  'invalid_code' }` shape as a wrong code against a real challenge (test
  case T). A wrong purpose/channel/subject/workspace binding returns the
  same generic failure as a wrong code (no "found but wrong tenant" signal).
- **No raw secrets or unnecessary raw IPs in persistent storage.** IPs are
  hashed before being written to `verification_attempts.ip_hash` /
  `verification_challenges.request_ip_hash`; the idempotency ledger's
  `safe_result` is the RPC's own return value, which never includes a code,
  proof token, or pepper (test case R asserts this against every table in
  the schema).

## Canonical lock order — deadlock prevention

`_gv_do_request`, `_gv_do_resend`, and `_gv_do_revoke` all acquire a
workspace/scope-level row lock BEFORE any challenge-row lock, consistently.
This matters because two of these functions run concurrently against
different rows in the same workspace in normal operation (one member
resending an invitation-style challenge while another member's own
challenge is being created or revoked), and PostgreSQL's deadlock detector
will abort one side of a genuine lock-order inversion — a real availability
bug, not merely a theoretical one. `_gv_do_resend` previously acquired the
challenge-row lock BEFORE the workspace lock, the reverse of
`_gv_do_request`'s order; this has been corrected to match the single
documented order. Tests LOCK1–LOCK3 run request-vs-resend,
request-vs-revoke, and resend-vs-revoke concurrently (via
`Promise.allSettled` with a bounded `statement_timeout`) against two
DIFFERENT challenges in the same workspace and assert: no deadlock error
from either side, no duplicate active challenge, and a consistent final
state.

## Revoke is scoped and authorized like every other mutation

`revokeVerificationChallenge` previously accepted only `handle`/`purpose`/
`reason` and executed as an implicit, unauthenticated `system` actor with no
`assertPolicyBindings` check — meaning any caller who could reach it (once a
route existed) could revoke any challenge by handle alone, regardless of
workspace, subject, or channel. It now takes the same context shape as
`verify`/`resend`: `channel`, `workspaceId`, `subjectRef`, and the
requester's `authenticatedUserId`, and calls `assertChannelAllowed` +
`assertPolicyBindings` before any database call. `_gv_do_revoke`
re-validates the claimed scope under a row lock using the same NULL-safe
`IS DISTINCT FROM` comparison style as `_gv_do_verify`; a wrong workspace,
wrong subject, wrong channel, or an unauthenticated caller against a
`requiresAuth` purpose all receive the identical generic rejection and
never modify the challenge or its proof — the same "no signal leaks which
check failed" property this document already documents for verify/consume.
The revoke idempotency fingerprint also binds the complete claimed scope,
not just the handle. Tests REV1–REV4 exercise the unauthenticated,
wrong-workspace, wrong-subject, and wrong-channel cases directly.

## Database-level security posture

- **RLS enabled, zero policies** on all five tables — deny-all for `anon`/
  `authenticated` under PostgREST; `service_role` reaches them via the
  `BYPASSRLS` role attribute, not a policy. This is the same pattern used
  throughout this codebase for backend-only tables (see
  `security/advisor-baseline.json`), not a new pattern invented for this
  subsystem.
- **No Data API grants** — `REVOKE ALL ... FROM PUBLIC` on every table,
  `GRANT` only what the Express service-role connection needs.
- **Every RPC is `SECURITY DEFINER`** with `SET search_path = public,
  pg_temp` pinned, closing the classic search-path-hijack vector.
- **Two disjoint RPC sets, not one flat ACL.** Six INTERNAL functions
  (`_gv_create_challenge_row`, `_gv_do_request`, `_gv_do_resend`,
  `_gv_do_verify`, `_gv_do_revoke`, `gv_is_purpose_enabled`) are
  `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` — nobody
  can execute them directly, including the backend's own `service_role`
  connection; they are reachable only as nested calls from within a public
  wrapper's own `SECURITY DEFINER` context. Six PUBLIC WRAPPER functions
  (`gv_prepare_verification_delivery`, `gv_finalize_verification_delivery`,
  `gv_execute_idempotent`, `gv_consume_verification_proof`,
  `gv_get_verification_status`, `gv_purge_expired_idempotency`) are
  `REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO
  service_role` — the ONLY verification RPCs ever executable by
  `service_role`, and never by `anon`/`authenticated`. No browser-reachable
  verification RPC exists, and no RPC (internal or public) is reachable
  by any role broader than strictly necessary. Test X2 proves the internal
  set is unreachable even under `SET ROLE service_role`.
- **No `auth.uid()` / Supabase Auth identity logic** anywhere in this
  module — subject binding is an opaque `subject_ref`/`subject_ref_hash`
  supplied by the caller (the Express server, which has already
  authenticated the request through this codebase's own `gs_session`/
  Argon2id first-party auth, where applicable), not a Postgres-session
  identity claim.
- **No RPC returns a secret.** Every RPC's JSON return value is checked
  (test case R) to contain no OTP code, no proof token, and no pepper —
  only hashes, statuses, and timestamps.
- **Append-only evidence**: `verification_attempts` and
  `verification_delivery_attempts` carry no `UPDATE`/`DELETE` grant for
  `service_role` — history cannot be edited after the fact.
- **Build-time self-verification**: the migration's own `DO $verify$` block
  queries `pg_class`/`pg_policy`/`has_table_privilege`/
  `has_function_privilege` for every one of the above invariants — including
  the internal/public split above and the database-layer dormancy check
  below — and raises an exception — failing the migration itself — if any
  invariant does not hold. A future edit that accidentally weakens an ACL
  cannot silently ship.

## Dormancy as a security property — enforced at TWO layers

**TypeScript layer.** Every purpose ships `enabled: false`.
`assertPurposeEnabled`/`assertChannelAllowed`/`assertPolicyBindings` are
unconditional and are the first statements in every `service.ts` entry point
(`request`, `resend`, `verify`, `consume`) — a disabled purpose, or one whose
`requiresAuth`/`subjectBinding`/`tenantBinding` requirement the caller
doesn't satisfy, throws before a Supabase client is even constructed.

**Database layer, independent of the TypeScript registry.**
`gv_is_purpose_enabled(_purpose text)` ships hardcoded to
`SELECT _purpose = ANY(ARRAY[]::text[])` — an empty allow-list. Every public
wrapper RPC that can write checks this FIRST, before any ledger row is even
tentatively inserted. This means a bug that flips the TypeScript `enabled`
flag by mistake, or a direct `SET ROLE service_role` SQL call that skips
`service.ts` entirely, still cannot write a single row for a disabled
purpose — proven directly (not via a test override) by test X1, which
temporarily restores the exact shipped function and confirms zero writes and
a rolled-back ledger insert. Enabling a purpose for real requires a
deliberate, reviewed, additive migration touching this function AND a code
deploy touching the TypeScript registry — never a single-layer change.

Both layers are verified for zero-database-writes in
`src/test/integration/genericVerificationCore.pg.test.ts` (tests A, X1), and
the TypeScript layer additionally at the pure-function level (no database
involved) in `src/test/verification/purposeDormancy.test.ts`.

There is no worker for this subsystem (delivery is Express-direct — see
`docs/GENERIC_VERIFICATION_CORE.md` §Delivery) and no route calls
`service.ts`, so there is no code path in this codebase — dormant purpose
or not — that currently reaches this subsystem at all in production.

## Monitoring / metrics (for a future consumer to wire up)

No monitoring is wired up in this pass (there is nothing to monitor — the
subsystem processes zero traffic). Once a purpose is enabled, the natural
metrics to add, using the existing shapes:

- Delivery outcomes (`verification_delivery_attempts.outcome`) —
  provider-accepted vs. retryable/permanent-failure/ambiguous rate, per
  channel/purpose.
- Verification outcomes (`verification_attempts.result`) — wrong-code rate,
  lockout rate, per purpose.
- Rate-limit rejections (`VERIFICATION_RATE_LIMITED` exceptions from
  `_gv_do_request`) — a spike indicates either abuse or a misconfigured
  cooldown.
- Idempotency conflicts (`IDEMPOTENCY_KEY_REUSED`) on `request`/`resend`/
  `revoke` — should be near zero in normal operation.

## Future integration checklist (security-relevant subset)

See the full checklist in `docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md`.
Security-relevant additions when enabling a purpose:
- Confirm the consumer's proof-consumption SQL function is itself
  `SECURITY DEFINER` with a pinned `search_path`, and that it nests the
  `gv_consume_verification_proof` call inside its own transaction (not a
  separate round-trip) so consumption and the business mutation are atomic.
- Confirm the new route enforces the same Express-layer rate limiting this
  codebase already applies to comparable endpoints, in addition to (not
  instead of) the database-level limiting described above.
- Get a dedicated security review before flipping `enabled: true` for that
  purpose — this document describes the primitive's security properties,
  not a blanket clearance for every future use of it.
