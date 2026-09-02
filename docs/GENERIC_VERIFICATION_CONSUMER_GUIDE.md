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
resendVerificationChallenge(config, input: RequestChallengeInput): Promise<RequestChallengeResult>
verifyVerificationChallenge(config, input: VerifyChallengeInput): Promise<VerifyChallengeResult>
consumeVerificationProof(config, input: ConsumeProofInput): Promise<ConsumeProofResult>
revokeVerificationChallenge(config, input): Promise<{ ok: boolean }>
getSafeVerificationStatus(config, handle: string): Promise<SafeVerificationStatus | null>
```

`RequestChallengeInput` carries: `purpose`, `channel`, `destination`,
`subjectKind`, optional `subjectRef`, optional `workspaceId`, optional
`locale`, a caller-supplied `idempotencyKey`, and `requester` context
(`ipAddress`, optional `authenticatedUserId`). **The OTP code is never
returned from `requestVerificationChallenge` or `resendVerificationChallenge`**
— only `handle`, `generation`, `expiresAt`, `resendAvailableAt`. Delivery is
the worker's job.

`verifyVerificationChallenge` returns `{ ok: false, reason }` on any failure
(wrong code, expired, locked, revoked, wrong purpose/channel/subject/
workspace, or not-found — all the same generic shapes) or `{ ok: true,
proofToken }` on success, where `proofToken` is the **raw, one-time** token —
this is the only point in the whole system where the raw token exists outside
the database, and only the caller of `verifyVerificationChallenge` ever sees
it. Only its hash (`hashProofToken`) is ever persisted.

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
purpose, because every purpose ships `enabled: false`. **Enabling a purpose
is a one-line change in `server/services/verification/types.ts`'s
`RAW_POLICIES`** — but that change, and the route wiring above, are explicitly
out of scope for this pass and must go through their own review, since
flipping a purpose live starts sending real OTPs for that flow.

## Step 2 — a route calls `verifyVerificationChallenge`

```ts
const verified = await verifyVerificationChallenge(config, {
  handle: req.body.handle,
  code: req.body.code,
  purpose: 'password_reset',
  channel: 'email',
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

## Checklist for a future integration PR

1. Flip the specific purpose's `enabled` to `true` in
   `server/services/verification/types.ts` (and only that purpose).
2. Add the route(s) that call `requestVerificationChallenge` /
   `verifyVerificationChallenge`.
3. Add the consumer-side `SECURITY DEFINER` SQL function that nests a call to
   `gv_consume_verification_proof` inside its own transaction, as shown above,
   in a **new, additive** migration.
4. Register `server/services/verification/worker.ts` in `worker/index.ts`'s
   `WORKER_KIND` dispatcher so delivery jobs actually get processed.
5. Add end-to-end tests for the new flow, following the pattern in
   `src/test/integration/genericVerificationCore.pg.test.ts`.
6. Get a security review specifically for that one purpose going live —
   enabling a purpose is the point at which real OTPs start being sent.

None of the above is done in this pass.
