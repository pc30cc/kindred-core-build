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
  versioned key. This is the same pattern proven by Workspace Invitations
  v5.1's OTP derivation: it lets the delivery worker re-derive the same code
  after a crash/retry without a second database round-trip or ever
  persisting the raw code for the worker to read back.
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
- **Proof tokens** are generated with `crypto.randomBytes` (not derived —
  there is no crash-safety requirement for a proof, since it is only handed
  back once, synchronously, to the caller of `verifyVerificationChallenge`).
  Only `hashProofToken()`'s output is ever persisted.

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

## Rate limiting and abuse prevention

Enforced in the database, inside the same transaction that would create a
row — not only in Express middleware, which can be bypassed by any direct
caller and does not coordinate across multiple server instances.

- **Resend cooldown**: `_gv_do_request` checks
  `max(created_at) FOR (destination_hash, purpose, channel) > now() - cooldown`
  before creating a new challenge row. Floor: `PLATFORM_MAXIMUMS.resendCooldownSecondsMin`
  (a policy may not set a *shorter* cooldown than this, even via override).
- **Rolling-window send cap**: `count(*) FOR the same tuple within rateWindowSeconds >= maxPerWindow`
  is checked in the same query, before the same row is created.
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

## Database-level security posture

- **RLS enabled, zero policies** on all six tables — deny-all for `anon`/
  `authenticated` under PostgREST; `service_role` reaches them via the
  `BYPASSRLS` role attribute, not a policy. This is the same pattern used
  throughout this codebase for backend-only tables (see
  `security/advisor-baseline.json`), not a new pattern invented for this
  subsystem.
- **No Data API grants** — `REVOKE ALL ... FROM PUBLIC` on every table,
  `GRANT` only what the Express service-role connection needs.
- **Every RPC is `SECURITY DEFINER`** with `SET search_path = public,
  pg_temp` pinned, closing the classic search-path-hijack vector.
- **`REVOKE ALL ... FROM PUBLIC, anon, authenticated` +
  `GRANT EXECUTE ... TO service_role`** on every one of the 13 RPCs — no
  browser-reachable verification RPC exists.
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
  `verification_deliveries` carry no `UPDATE`/`DELETE` grant for
  `service_role` — history cannot be edited after the fact.
- **Build-time self-verification**: the migration's own `DO $verify$` block
  queries `pg_class`/`pg_policy`/`has_table_privilege`/
  `has_function_privilege` for every one of the above invariants and raises
  an exception — failing the migration itself — if any invariant does not
  hold. A future edit that accidentally weakens an ACL cannot silently ship.

## Dormancy as a security property

Every purpose ships `enabled: false`. `assertPurposeEnabled`/
`assertChannelAllowed` are unconditional and are the first statement in
every `service.ts` entry point — a disabled purpose throws before a Supabase
client is even constructed, so it is architecturally impossible (not just
policy) for a disabled purpose to create a challenge row, a delivery job, or
send anything. This is verified directly (zero-database-writes) in
`src/test/integration/genericVerificationCore.pg.test.ts` test case A, and at
the pure-function level (no database involved) in
`src/test/verification/purposeDormancy.test.ts`.

Because the worker is not registered in `worker/index.ts`, and no route
calls `service.ts`, there is no code path in this codebase — dormant purpose
or not — that currently reaches this subsystem at all in production.

## Monitoring / metrics (for a future consumer to wire up)

No monitoring is wired up in this pass (there is nothing to monitor — the
subsystem processes zero traffic). Once a purpose is enabled, the natural
metrics to add, using the existing shapes:

- Delivery job outcomes (`verification_deliveries.outcome`) —
  provider-accepted vs. permanently-failed rate, per channel/purpose.
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
