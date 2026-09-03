# Generic Verification Core v1 — Future Consumer Guide

**This guide describes how a future consumer *would* integrate. Nothing in
this codebase does this yet — see `docs/GENERIC_VERIFICATION_CORE.md`'s
"What this pass does NOT do" section.** Signup, password reset, and phone
verification remain on their existing, unchanged implementations.

## Internal service contract

`server/services/verification/service.ts` exports six functions. All take a
`ServerConfig` first argument, exactly like every other server-side service
in this codebase.

```ts
requestVerificationChallenge(config, input: RequestChallengeInput): Promise<RequestChallengeResult>
resendVerificationChallenge(config, input: ResendChallengeInput): Promise<RequestChallengeResult>
verifyVerificationChallenge(config, input: VerifyChallengeInput): Promise<VerifyChallengeResult>
consumeVerificationProof(config, input: ConsumeProofInput): Promise<ConsumeProofResult>
revokeVerificationChallenge(config, input: RevokeChallengeInput): Promise<{ ok: boolean }>
getSafeVerificationStatus(config, handle: string): Promise<SafeVerificationStatus | null>
```

`RequestChallengeInput` carries: `purpose`, `channel`, `destination`,
`subjectKind`, optional `subjectRef`, optional `workspaceId`, optional
`locale`, a caller-supplied `idempotencyKey`, and `requester` context
(`ipAddress`, optional `authenticatedUserId`).

`ResendChallengeInput` is **handle-based, not destination-based**: it carries
the EXISTING challenge's own `handle` plus the caller's claimed scope
(`purpose`, `channel`, `subjectKind`, optional `subjectRef`, optional
`workspaceId`) instead of a raw `destination`. This scope is re-validated
server-side, under a row lock, against the existing challenge's own recorded
scope before anything is superseded — a resend can never reach, let alone
revoke, a challenge belonging to a different workspace or subject that
happens to share the same destination (see
`docs/GENERIC_VERIFICATION_CORE.md` §Lifecycle).

**The OTP code is never returned from `requestVerificationChallenge` or
`resendVerificationChallenge`** — only `handle`, `generation`, `expiresAt`,
`resendAvailableAt`, `deliveryOutcome`. Delivery is synchronous: by the time
either call resolves (or throws), Express has already called the email/SMS
provider directly — there is no worker, no queue, nothing left to happen
later. A caller should branch on `deliveryOutcome`: `'provider_accepted'`
means the code is on its way; anything else (`'retryable_failure'`,
`'unconfigured'`, `'ambiguous'`, `'permanent_failure'`,
`'derivation_key_unavailable'`) means the caller should surface a resend
affordance to the end user. See `docs/GENERIC_VERIFICATION_CORE.md`
§Delivery for the full state machine, including the delivery-attempt
ownership token that protects a resumed/stale prepare-finalize cycle.

`VerifyChallengeInput` REQUIRES a caller-supplied `requestId` — this is what
makes `verifyVerificationChallenge` idempotent-by-construction (see
`docs/GENERIC_VERIFICATION_CORE.md` §Idempotency): a route handler should
generate a fresh `requestId` per logical verify attempt (e.g. a
client-supplied request id, or one generated server-side per HTTP request)
and reuse the SAME `requestId` on its own internal retries of that same
logical attempt, never on a genuinely new one.

`RevokeChallengeInput` takes the same shape of scope/authorization context
as `verify`/`resend`: `handle`, `purpose`, `channel`, `reason`, optional
`workspaceId`, optional `subjectRef`, an `idempotencyKey`, and `requester`
(`ipAddress`, optional `authenticatedUserId`). This is checked with
`assertChannelAllowed`/`assertPolicyBindings` and re-validated under a row
lock at the database layer exactly like verify — a caller cannot revoke a
challenge by handle alone without also presenting the correct scope.

`verifyVerificationChallenge` returns `{ ok: false, reason }` on any failure
(wrong code, expired, locked, revoked, wrong purpose/channel/subject/
workspace, or not-found — all the same generic shapes) or `{ ok: true,
proofToken }` on success, where `proofToken` is the **raw, one-time** token —
this is the only point in the whole system where the raw token exists outside
the database, and only the caller of `verifyVerificationChallenge` ever sees
it (or re-derives it, byte-for-byte, on a same-`requestId` replay — see
§Idempotency). Only its hash (`hashProofToken`) is ever persisted.

## Step 1 — a route calls `requestVerificationChallenge`

```ts
const result = await requestVerificationChallenge(config, {
  purpose: 'password_reset',
  channel: 'email',
  destination: normalizedEmail,
  subjectKind: 'user',
  subjectRef: userId,
  idempotencyKey: req.body.requestId,   // client-supplied, per attempt
  requester: { ipAddress: getClientIp(req) },
});
res.json({ handle: result.handle, expiresAt: result.expiresAt });
```

This will currently throw `VerificationPurposeDisabledError` for every
purpose, because every purpose ships disabled at TWO independent layers —
see `docs/GENERIC_VERIFICATION_CORE.md` §Dormancy. **Enabling a purpose for
real requires a deliberate, reviewed, two-key change**: (1) flipping
`enabled: true` in `server/services/verification/types.ts`'s
`RAW_POLICIES`, AND (2) a new, additive migration that adds the purpose's
name to `gv_is_purpose_enabled`'s allow-list in
`database/migrations/098_generic_verification_core.sql` (mirrored to
`supabase/migrations/`). Neither change alone enables anything. This, and
the route wiring below, are explicitly out of scope for this pass, since
flipping a purpose live starts sending real OTPs for that flow.

## Step 2 — a route calls `verifyVerificationChallenge`

```ts
const verified = await verifyVerificationChallenge(config, {
  handle: req.body.handle,
  code: req.body.code,
  purpose: 'password_reset',
  channel: 'email',
  requestId: req.body.requestId,   // REQUIRED — makes this call idempotent
  requester: { ipAddress: getClientIp(req) },
});
if (!verified.ok) return res.status(400).json({ error: verified.reason });
// verified.proofToken is the ONE-TIME raw proof token.
```

At this point **no business mutation has happened**. The proof exists, but
nothing has been reset, changed, or created. This is intentional: a
verified-but-unconsumed proof is inert.

## Step 3 — the atomic proof-consumption pattern

The proof must be consumed **inside the same database transaction** as the
consumer's own business mutation, so a crash between "proof consumed" and
"password actually reset" is impossible — either both commit or neither does.

`gv_consume_verification_proof` is a plain SQL function precisely so a
consumer's own `SECURITY DEFINER` function can call it as a **nested SQL
call inside its own transaction** — no HTTP round-trip, no two-phase commit
needed:

```sql
-- A FUTURE migration would add something like this (does not exist yet):
CREATE OR REPLACE FUNCTION public.reset_password_with_proof(
  _proof_hash text, _new_password_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _consumed jsonb;
BEGIN
  -- Consume the proof FIRST, in the same transaction. If this fails
  -- (already consumed, wrong purpose, wrong subject), the whole
  -- transaction rolls back and user_credentials is never touched.
  SELECT public.gv_consume_verification_proof(
    _proof_hash, 'password_reset', 'email',
    NULL, _subject_ref_hash := <hash of the target user id>,
    _consumed_by_context := 'password_reset_v2'
  ) INTO _consumed;

  IF NOT (_consumed->>'ok')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'reason', _consumed->>'reason');
  END IF;

  UPDATE public.user_credentials
  SET password_hash = _new_password_hash, updated_at = now()
  WHERE user_id = (_consumed->>'subjectRef')::uuid;

  RETURN jsonb_build_object('ok', true);
END;
$$;
```

If the `UPDATE` fails for any reason, Postgres rolls back the whole
transaction — including the proof consumption — so the proof is *not*
silently burned on a failed mutation. If it succeeds, both commit together.

The Node-level `consumeVerificationProof()` wrapper in `service.ts` exists
for direct testing/completeness only; a real consumer should prefer the
nested-SQL pattern above so the mutation and the consumption share one
transaction, which a two-step Node-level call (verify proof, then separately
call the business route) cannot guarantee.

## Binding checks a consumer gets for free

`gv_consume_verification_proof` rejects consumption if the caller-supplied
`purpose`, `channel`, `workspaceId`, or `subjectRefHash` don't match what the
proof was issued for. A consumer does not need to re-check tenant isolation
or purpose confusion itself — passing its own purpose/channel/workspace/
subject is sufficient, and a mismatch fails closed with a generic reason.

**Destination binding, for `signup_email`/`signup_phone`/`change_email`/
`change_phone`.** The consume result also returns `destinationNormalized` —
the exact destination the underlying challenge was verified for, copied
from the locked challenge row at issuance time. A future consumer for one of
these four purposes **must use this returned value**, never a
client-supplied "new email"/"new phone" field from the request body, for its
business mutation (e.g. `UPDATE profiles SET email = <destinationNormalized
from the consume result>`, not `UPDATE profiles SET email =
req.body.newEmail`). There is no field in `ConsumeProofInput` to pass a
destination in, precisely so this can't be gotten wrong: a proof issued for
destination A cannot be used to authorize a mutation to destination B, by
construction rather than by a check that could be forgotten.

## Checklist for a future integration PR

1. Flip the specific purpose's `enabled` to `true` in
   `server/services/verification/types.ts` (and only that purpose), AND add
   it to `gv_is_purpose_enabled`'s allow-list in a new, additive migration —
   both layers, per §Dormancy in `docs/GENERIC_VERIFICATION_CORE.md`.
2. Add the route(s) that call `requestVerificationChallenge` /
   `verifyVerificationChallenge`.
3. Add the consumer-side `SECURITY DEFINER` SQL function that nests a call to
   `gv_consume_verification_proof` inside its own transaction, as shown above,
   in a **new, additive** migration.
4. No worker to register — delivery is synchronous, inside
   `requestVerificationChallenge`/`resendVerificationChallenge` itself.
   Confirm the calling route handles every `deliveryOutcome` value
   sensibly (surfacing a resend affordance for anything other than
   `'provider_accepted'`).
5. Add end-to-end tests for the new flow, following the pattern in
   `src/test/integration/genericVerificationCore.pg.test.ts` — including the
   crash/concurrency/replay matrix in `docs/GENERIC_VERIFICATION_CORE.md`
   §Delivery, not just the happy path.
6. Get a security review specifically for that one purpose going live —
   enabling a purpose is the point at which real OTPs start being sent.

None of the above is done in this pass.
