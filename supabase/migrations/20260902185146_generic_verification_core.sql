-- 098 — Generic Verification Core v1.
--
-- A domain-neutral, purpose-agnostic OTP/verification engine intended for
-- FUTURE consumers (signup email/phone verification, password reset,
-- login step-up, email/phone change, sensitive-action confirmation,
-- workspace member flows). NOTHING in this migration is called by any
-- existing route, RPC, or trigger — every table/function here is new,
-- additive, and unreferenced by the rest of the schema. No existing
-- table, function, trigger, or column is altered, renamed, or dropped.
--
-- Explicitly NOT migrated here: the existing Workspace Invitations v5.1
-- OTP system (`workspace_invitation_otps`/`workspace_invitation_proofs`,
-- migrations 077-097) and the existing phone-verification OTP system
-- (`phone_verification_challenges`/`user_phone_verifications`, hosted-only
-- migrations from 2026-08-01) both continue completely unchanged. This is
-- a NEW, separate, parallel subsystem — not a replacement, not a shared
-- table, not a dual-write. See docs/GENERIC_VERIFICATION_CORE.md for the
-- full architecture and docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md for
-- how a FUTURE consumer would adopt this (none does yet).
--
-- Every "purpose" this core could ever serve ships DISABLED by default in
-- BOTH layers independently: the application-layer registry
-- (server/services/verification/types.ts, a TypeScript Record — a
-- disabled purpose is rejected there BEFORE any database call is made)
-- AND the database-facing contract itself (gv_is_purpose_enabled below,
-- an empty allow-list) — so even a direct service-role call to a public
-- wrapper RPC for a disabled purpose produces zero writes, independent of
-- whether the TypeScript layer was somehow bypassed. This migration's own
-- DO $verify$ block at the bottom proves the ACL/security posture.
--
-- Cryptography: every table stores only HMAC digests/hashes, never a raw
-- OTP code or raw proof token. All HMAC/hash computation happens in Node
-- (server/services/verification/crypto.ts), keyed by a versioned pepper
-- ring (GENERIC_VERIFICATION_PEPPER[_RING/_KEY_VERSION] env vars — entirely
-- separate secrets from INVITATION_OTP_PEPPER/INVITATION_LINK_SECRET and
-- PHONE_VERIFICATION_PEPPER; no secret is reused across subsystems). SQL
-- here only stores and compares opaque hex strings — it never hashes
-- anything itself, matching the already-proven pattern in the Workspace
-- Invitations v5.1 subsystem (see that subsystem's `tokens.ts`). Proof
-- tokens are ALSO deterministically derived (not random-then-hashed),
-- exactly like OTP codes, so a verify replay can reproduce and return the
-- identical usable proof token without it ever being persisted.
--
-- RPC isolation: only a small, explicit set of "public wrapper" RPCs is
-- ever granted EXECUTE to service_role — `gv_prepare_verification_delivery`,
-- `gv_finalize_verification_delivery`, `gv_execute_idempotent`,
-- `gv_consume_verification_proof`, `gv_get_verification_status`,
-- `gv_purge_expired_idempotency`. Every `_gv_do_*`/`_gv_create_*` function
-- is an internal implementation detail: EXECUTE is revoked from PUBLIC
-- (and therefore from anon/authenticated/service_role, none of which own
-- these functions) entirely. This works because PostgreSQL SECURITY
-- DEFINER functions execute with the DEFINING role's own privileges for
-- everything they do internally, including calling other functions — a
-- wrapper can call an internal function it has no explicit grant on, but
-- service_role (or anyone else) cannot call that internal function
-- directly. See the DO $verify$ block for the assertions that prove this.
--
-- Canonical lock order (mirrors the Workspace Invitations v5.1 convention,
-- stated once here rather than re-derived per function): workspace (if
-- bound) → idempotency ledger row → challenge → proof. Every RPC below
-- acquires locks in this order to avoid deadlocking against itself under
-- concurrency. Rate-limit buckets (purpose/channel, destination, IP,
-- subject, workspace) are each additionally protected by their own
-- transactional advisory lock (`pg_advisory_xact_lock`), acquired before
-- that bucket's count-then-decide check, so concurrent requests targeting
-- the SAME bucket serialize instead of racing past a stale COUNT(*).
--
-- Delivery model: Express calls the email/SMS provider DIRECTLY — there is
-- no background worker and no job/outbox table. A 'request' or 'resend'
-- is a three-step Express-side sequence: (1) gv_prepare_verification_delivery
-- atomically creates or replays the challenge and issues a fresh,
-- rotating delivery-attempt token; (2) Express derives the OTP
-- deterministically and calls sendEmail/sendSms itself; (3)
-- gv_finalize_verification_delivery atomically records the outcome,
-- validating that the attempt token presented still matches the current
-- one (a stale, superseded attempt can never overwrite a newer outcome).
-- See docs/GENERIC_VERIFICATION_CORE.md §Delivery for the full state
-- machine and the documented crash/concurrency/replay matrix.
--
-- Verify is idempotent-by-construction on a caller-supplied `requestId`,
-- exactly like request/resend/revoke — going through the SAME
-- `gv_execute_idempotent` ledger (unlike an earlier iteration of this
-- migration, which routed verify around the ledger entirely; that design
-- could not safely replay an issued proof, because the proof token was
-- generated fresh in Node before knowing whether a call was a replay).
-- The proof token is now deterministically DERIVED (see crypto.ts's
-- `deriveProofToken`) from (purpose, channel, handle, requestId), so
-- replaying a committed verify call re-derives and returns the IDENTICAL
-- usable proof token without it ever being stored — solving the replay
-- problem without ever persisting a raw secret.

-- ============================================================
-- 1. verification_challenges
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_challenges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  handle text NOT NULL UNIQUE,                    -- opaque, client-facing (never the OTP code)
  purpose text NOT NULL,                          -- from the app-layer purpose registry; not a DB enum
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,  -- optional tenant binding
  subject_kind text NOT NULL CHECK (subject_kind IN ('user', 'pending_account', 'anonymous')),
  subject_ref text,                               -- e.g. an existing user id; NULL for pre-account/anonymous
  subject_ref_hash text,                          -- HMAC of a sensitive subject identifier when subject_ref itself must not be stored raw
  destination_normalized text NOT NULL,           -- normalized email/phone the OTP is actually delivered to (delivery needs the real value)
  destination_hash text NOT NULL,                 -- HMAC of destination_normalized — used for domain separation + rate-limit bucketing, never for delivery
  locale text NOT NULL CHECK (locale IN ('fa', 'tr', 'en')),
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending_delivery' CHECK (
    status IN ('pending_delivery', 'provider_accepted', 'verified', 'revoked', 'expired', 'locked', 'delivery_failed')
  ),
  key_version integer NOT NULL,
  code_digest text NOT NULL,                      -- "v<version>:<hmac-hex>" — never the raw code
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  send_count integer NOT NULL DEFAULT 1,
  max_sends integer NOT NULL,
  resend_cooldown_seconds integer NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  request_ip_hash text,
  idempotency_key text,
  created_by_context text NOT NULL DEFAULT 'self_service' CHECK (created_by_context IN ('self_service', 'admin', 'system')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verification_challenges_destination_window
  ON public.verification_challenges (destination_hash, purpose, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_challenges_subject_window
  ON public.verification_challenges (subject_ref_hash, purpose, created_at) WHERE subject_ref_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_challenges_workspace_window
  ON public.verification_challenges (workspace_id, purpose, created_at) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_challenges_ip_window
  ON public.verification_challenges (request_ip_hash, purpose, created_at) WHERE request_ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_challenges_purpose_channel_window
  ON public.verification_challenges (purpose, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_challenges_live_lookup
  ON public.verification_challenges (destination_hash, purpose, channel) WHERE status IN ('pending_delivery', 'provider_accepted');

-- ============================================================
-- 2. verification_attempts — append-only per-attempt audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  result text NOT NULL CHECK (result IN ('correct', 'incorrect', 'expired', 'locked', 'revoked')),
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_attempts_challenge ON public.verification_attempts (challenge_id, created_at);

-- ============================================================
-- 3. verification_proofs — the consumable, single-use credential a
--    successful verification issues. Denormalizes purpose/channel/
--    workspace/subject from the challenge so a future consumer's
--    "wrong purpose/subject/workspace" check never depends on a join
--    surviving (the challenge row can be deleted by CASCADE independent
--    of the proof's own lifecycle needs, though in v1 they cascade
--    together — the denormalization is defense in depth for any future
--    schema evolution that decouples them).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_proofs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  proof_hash text NOT NULL UNIQUE,                -- HMAC of the raw proof token — the raw token is NEVER stored
  purpose text NOT NULL,
  channel text NOT NULL,
  workspace_id uuid,
  subject_kind text NOT NULL,
  subject_ref text,
  subject_ref_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_context text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_proofs_lookup ON public.verification_proofs (proof_hash) WHERE status = 'active';

-- ============================================================
-- 4. verification_delivery_attempts — append-only evidence of every
--    Express-side provider submission. This is NOT a job queue: there is
--    no claim/lease/status-transition model here, because there is no
--    background worker. Express calls the email/SMS provider directly,
--    in the SAME request that created or replayed the challenge, and
--    records exactly what happened, once, per logical send operation
--    (idempotency_key ties an attempt row back to the delivery that
--    produced it — see verification_idempotency and
--    gv_finalize_verification_delivery below). "provider_accepted" is the
--    strongest outcome ever recorded — never "delivered" (this codebase
--    cannot know actual mailbox/handset delivery, matching the Workspace
--    Invitations v5.1 convention).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_delivery_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  channel text NOT NULL,
  outcome text NOT NULL CHECK (
    outcome IN ('provider_accepted', 'retryable_failure', 'permanent_failure', 'unconfigured', 'ambiguous', 'derivation_key_unavailable')
  ),
  provider_name text,
  provider_message_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_delivery_attempts_challenge ON public.verification_delivery_attempts (challenge_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_delivery_attempts_idempotency ON public.verification_delivery_attempts (idempotency_key);

-- ============================================================
-- 5. verification_idempotency — generic to THIS subsystem only (not
--    reused from workspace_invitation_idempotency, which is CHECK-
--    constrained to invitation-specific operations and FK'd to
--    invitation_id; no other pre-existing generic ledger was found in
--    this codebase — see docs/GENERIC_VERIFICATION_CORE.md §Idempotency).
--
-- `result_state = 'prepared'` is the crash-recovery hinge for the
-- Express-direct delivery model (no background worker retries this): a
-- 'request'/'resend' operation commits the challenge-creation half of the
-- work (gv_prepare_verification_delivery) BEFORE Express ever calls the
-- email/SMS provider, and only reaches 'committed' after
-- gv_finalize_verification_delivery records the provider outcome. If the
-- Express process dies between those two calls, the ledger row is left in
-- 'prepared' with `prepared_at` recording when that happened, and
-- `attempt_token` recording which Express attempt currently "owns" this
-- delivery. A resumed retry ROTATES `attempt_token` to a new value before
-- sending again, so the ORIGINAL (now-superseded) Express request can
-- never successfully finalize afterward and overwrite the resumed
-- attempt's outcome — see gv_prepare_verification_delivery /
-- gv_finalize_verification_delivery for the exact mechanics.
--
-- 'verify' also uses this ledger (operation='verify'): unlike
-- request/resend, it has no external side effect and no crash window, so
-- it goes straight from a fresh row to 'committed' inside
-- gv_execute_idempotent, exactly like 'revoke'.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_idempotency (
  key text NOT NULL PRIMARY KEY,
  scope_kind text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('request', 'resend', 'verify', 'consume', 'revoke')),
  purpose text,
  workspace_id uuid,
  challenge_id uuid,
  result_state text NOT NULL DEFAULT 'prepared' CHECK (result_state IN ('prepared', 'committed', 'failed')),
  request_fingerprint text NOT NULL,
  safe_result jsonb,
  actor_ref_hash text,
  prepared_at timestamptz,
  attempt_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_verification_idempotency_expiry ON public.verification_idempotency (expires_at);
CREATE INDEX IF NOT EXISTS idx_verification_idempotency_prepared ON public.verification_idempotency (prepared_at) WHERE result_state = 'prepared';

-- ============================================================
-- 6. RLS + GRANTs — every table is backend-only. RLS enabled, ZERO
--    policies (deny-all for anon/authenticated; service_role bypasses RLS
--    via its own BYPASSRLS role attribute, not via a policy). No DELETE
--    grant on the two append-only evidence tables.
-- ============================================================
ALTER TABLE public.verification_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_idempotency ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.verification_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_proofs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_delivery_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_idempotency FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.verification_challenges TO service_role;
GRANT SELECT, INSERT ON public.verification_attempts TO service_role;          -- append-only, no UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE ON public.verification_proofs TO service_role;
GRANT SELECT, INSERT ON public.verification_delivery_attempts TO service_role; -- append-only, no UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification_idempotency TO service_role; -- DELETE needed for the purge RPC

-- ============================================================
-- 7. Database-facing dormancy contract — independent of, and in addition
--    to, the TypeScript purpose registry. Empty by design: EVERY purpose
--    ships disabled in this pass. Enabling a purpose for real use
--    requires editing BOTH this array (a new, reviewed, additive
--    migration) AND server/services/verification/types.ts — a deliberate
--    two-key change, never a single boolean flip in one layer.
-- ============================================================
CREATE OR REPLACE FUNCTION public.gv_is_purpose_enabled(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY[]::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_is_purpose_enabled(text) FROM PUBLIC;

-- ============================================================
-- 8. RPCs
-- ============================================================

-- 8a. INTERNAL — never granted to anyone (see the ACL/verify blocks at the
--     bottom). Called only from the public wrapper RPCs below, which run
--     under their own SECURITY DEFINER privileges. Shared insert path for
--     both a fresh request and a validated resend: atomic multi-bucket
--     rate limiting (purpose/channel, destination, IP, subject,
--     workspace — each protected by its own pg_advisory_xact_lock so
--     concurrent requests targeting the SAME bucket serialize instead of
--     racing past a stale COUNT(*)) followed by the actual challenge
--     insert.
CREATE OR REPLACE FUNCTION public._gv_create_challenge_row(
  _handle text, _purpose text, _channel text, _workspace_id uuid, _subject_kind text, _subject_ref text, _subject_ref_hash text,
  _destination_normalized text, _destination_hash text, _locale text, _generation integer, _key_version integer,
  _code_digest text, _max_attempts integer, _max_sends integer, _resend_cooldown_seconds integer,
  _ttl_seconds integer, _rate_window_seconds integer, _max_per_window integer, _request_ip_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _challenge_id uuid;
  _recent integer;
  _last timestamptz;
BEGIN
  -- Bucket 1: purpose+channel, system-wide. A deliberately looser
  -- ceiling than the per-destination cap (20x) — this catches a
  -- purpose-wide flood that spreads across many distinct destinations,
  -- without making ordinary per-destination traffic contend on one lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('gv:bucket:purpose:' || _purpose || ':' || _channel, 0));
  SELECT count(*)::integer INTO _recent
    FROM public.verification_challenges
    WHERE purpose = _purpose AND channel = _channel
      AND created_at > now() - make_interval(secs => _rate_window_seconds);
  IF _recent >= _max_per_window * 20 THEN
    RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
  END IF;

  -- Bucket 2: destination (the original, tightest check) — rolling-window
  -- cap plus resend cooldown, scoped to (destination, purpose, channel).
  PERFORM pg_advisory_xact_lock(hashtextextended('gv:bucket:dest:' || _destination_hash || ':' || _purpose || ':' || _channel, 0));
  SELECT count(*)::integer, max(created_at) INTO _recent, _last
    FROM public.verification_challenges
    WHERE destination_hash = _destination_hash AND purpose = _purpose AND channel = _channel
      AND created_at > now() - make_interval(secs => _rate_window_seconds);
  IF _last IS NOT NULL AND _last > now() - make_interval(secs => _resend_cooldown_seconds) THEN
    RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
  END IF;
  IF _recent >= _max_per_window THEN
    RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
  END IF;

  -- Bucket 3: IP (already collapsed to a /64 prefix before hashing in
  -- Node — see crypto.ts's collapseIpForRateLimit). Looser than
  -- per-destination (10x): one IP legitimately serves many destinations.
  IF _request_ip_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('gv:bucket:ip:' || _request_ip_hash, 0));
    SELECT count(*)::integer INTO _recent
      FROM public.verification_challenges
      WHERE request_ip_hash = _request_ip_hash
        AND created_at > now() - make_interval(secs => _rate_window_seconds);
    IF _recent >= _max_per_window * 10 THEN
      RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
    END IF;
  END IF;

  -- Bucket 4: subject (when bound) — same cap as destination, since a
  -- subject-bound purpose (login_step_up, change_email, ...) should not
  -- let one subject fan out across many destinations to evade bucket 2.
  IF _subject_ref_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('gv:bucket:subject:' || _subject_ref_hash || ':' || _purpose, 0));
    SELECT count(*)::integer INTO _recent
      FROM public.verification_challenges
      WHERE subject_ref_hash = _subject_ref_hash AND purpose = _purpose
        AND created_at > now() - make_interval(secs => _rate_window_seconds);
    IF _recent >= _max_per_window THEN
      RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
    END IF;
  END IF;

  -- Bucket 5: workspace (when bound) — looser than per-subject (5x): a
  -- busy workspace legitimately has many members triggering step-up/
  -- sensitive-action challenges independently.
  IF _workspace_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('gv:bucket:ws:' || _workspace_id::text || ':' || _purpose, 0));
    SELECT count(*)::integer INTO _recent
      FROM public.verification_challenges
      WHERE workspace_id = _workspace_id AND purpose = _purpose
        AND created_at > now() - make_interval(secs => _rate_window_seconds);
    IF _recent >= _max_per_window * 5 THEN
      RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
    END IF;
  END IF;

  INSERT INTO public.verification_challenges (
    handle, purpose, channel, workspace_id, subject_kind, subject_ref, subject_ref_hash,
    destination_normalized, destination_hash, locale, generation, key_version, code_digest,
    max_attempts, max_sends, resend_cooldown_seconds, expires_at, request_ip_hash
  ) VALUES (
    _handle, _purpose, _channel, _workspace_id, _subject_kind, _subject_ref, _subject_ref_hash,
    _destination_normalized, _destination_hash, _locale, _generation, _key_version, _code_digest,
    _max_attempts, _max_sends, _resend_cooldown_seconds, now() + make_interval(secs => _ttl_seconds), _request_ip_hash
  ) RETURNING id INTO _challenge_id;

  RETURN jsonb_build_object(
    'challengeId', _challenge_id, 'handle', _handle, 'generation', _generation,
    'channel', _channel, 'destinationNormalized', _destination_normalized, 'destinationHash', _destination_hash,
    'locale', _locale, 'keyVersion', _key_version,
    'expiresAt', (now() + make_interval(secs => _ttl_seconds)),
    'resendAvailableAt', (now() + make_interval(secs => _resend_cooldown_seconds))
  );
END;
$function$;
REVOKE ALL ON FUNCTION public._gv_create_challenge_row(text, text, text, uuid, text, text, text, text, text, text, integer, integer, text, integer, integer, integer, integer, integer, integer, text) FROM PUBLIC;

-- 8b. INTERNAL — brand-new challenge (generation 1). No existing
--     challenge to lock; a scoped previous-generation invalidation
--     (destination + purpose + channel + workspace + subject — NEVER
--     destination + purpose + channel alone, which would let a request
--     bound to one workspace/subject revoke a live challenge bound to a
--     DIFFERENT workspace/subject sharing the same destination) may
--     supersede a still-live prior challenge in the SAME exact scope.
CREATE OR REPLACE FUNCTION public._gv_do_request(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _workspace_id uuid := NULLIF(_args->>'workspaceId', '')::uuid;
  _purpose text := _args->>'purpose';
  _channel text := _args->>'channel';
  _destination_normalized text := _args->>'destinationNormalized';
  _destination_hash text := _args->>'destinationHash';
  _subject_kind text := _args->>'subjectKind';
  _subject_ref text := NULLIF(_args->>'subjectRef', '');
  _subject_ref_hash text := NULLIF(_args->>'subjectRefHash', '');
  _locale text := _args->>'locale';
  _key_version integer := (_args->>'keyVersion')::integer;
  _code_digest text := _args->>'codeDigest';
  _ttl_seconds integer := (_args->>'ttlSeconds')::integer;
  _max_attempts integer := (_args->>'maxAttempts')::integer;
  _max_sends integer := (_args->>'maxSends')::integer;
  _resend_cooldown_seconds integer := (_args->>'resendCooldownSeconds')::integer;
  _rate_window_seconds integer := (_args->>'rateWindowSeconds')::integer;
  _max_per_window integer := (_args->>'maxPerWindow')::integer;
  _invalidate_previous boolean := COALESCE((_args->>'invalidatePrevious')::boolean, true);
  _request_ip_hash text := NULLIF(_args->>'requestIpHash', '');
  _handle text := _args->>'handle';
BEGIN
  IF _workspace_id IS NOT NULL THEN
    PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  END IF;

  IF _invalidate_previous THEN
    UPDATE public.verification_challenges
    SET status = 'revoked', revoked_at = now(), revoked_reason = 'superseded_by_new_generation'
    WHERE destination_hash = _destination_hash AND purpose = _purpose AND channel = _channel
      AND workspace_id IS NOT DISTINCT FROM _workspace_id
      AND subject_ref_hash IS NOT DISTINCT FROM _subject_ref_hash
      AND status IN ('pending_delivery', 'provider_accepted');
  END IF;

  RETURN public._gv_create_challenge_row(
    _handle, _purpose, _channel, _workspace_id, _subject_kind, _subject_ref, _subject_ref_hash,
    _destination_normalized, _destination_hash, _locale, 1, _key_version, _code_digest,
    _max_attempts, _max_sends, _resend_cooldown_seconds, _ttl_seconds, _rate_window_seconds, _max_per_window, _request_ip_hash
  );
END;
$function$;
REVOKE ALL ON FUNCTION public._gv_do_request(jsonb) FROM PUBLIC;

-- 8c. INTERNAL — resend. Requires the EXISTING challenge's own `handle`
--     (never looked up by destination+purpose+channel alone) and locks +
--     strictly validates it against the caller's claimed scope BEFORE
--     superseding it, so a resend can never reach — let alone revoke — a
--     challenge belonging to a different workspace or subject that
--     happens to share the same destination.
CREATE OR REPLACE FUNCTION public._gv_do_resend(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _existing_handle text := _args->>'existingHandle';
  _purpose text := _args->>'purpose';
  _channel text := _args->>'channel';
  _workspace_id uuid := NULLIF(_args->>'workspaceId', '')::uuid;
  _subject_ref_hash text := NULLIF(_args->>'subjectRefHash', '');
  _handle text := _args->>'handle';
  _key_version integer := (_args->>'keyVersion')::integer;
  _code_digest text := _args->>'codeDigest';
  _ttl_seconds integer := (_args->>'ttlSeconds')::integer;
  _max_attempts integer := (_args->>'maxAttempts')::integer;
  _max_sends integer := (_args->>'maxSends')::integer;
  _resend_cooldown_seconds integer := (_args->>'resendCooldownSeconds')::integer;
  _rate_window_seconds integer := (_args->>'rateWindowSeconds')::integer;
  _max_per_window integer := (_args->>'maxPerWindow')::integer;
  _request_ip_hash text := NULLIF(_args->>'requestIpHash', '');
  _existing public.verification_challenges%ROWTYPE;
  _new_generation integer;
BEGIN
  SELECT * INTO _existing FROM public.verification_challenges WHERE handle = _existing_handle FOR UPDATE;

  -- Same generic rejection for "does not exist" and "exists but wrong
  -- scope" — a caller probing handles can never distinguish the two.
  IF NOT FOUND
     OR _existing.purpose <> _purpose
     OR _existing.channel <> _channel
     OR _existing.workspace_id IS DISTINCT FROM _workspace_id
     OR _existing.subject_ref_hash IS DISTINCT FROM _subject_ref_hash
  THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH';
  END IF;

  IF _existing.status NOT IN ('pending_delivery', 'provider_accepted', 'delivery_failed', 'expired', 'locked') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH';
  END IF;

  _new_generation := _existing.generation + 1;

  IF _workspace_id IS NOT NULL THEN
    PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  END IF;

  UPDATE public.verification_challenges
  SET status = 'revoked', revoked_at = now(), revoked_reason = 'superseded_by_resend'
  WHERE id = _existing.id;

  RETURN public._gv_create_challenge_row(
    _handle, _existing.purpose, _existing.channel, _existing.workspace_id, _existing.subject_kind, _existing.subject_ref, _existing.subject_ref_hash,
    _existing.destination_normalized, _existing.destination_hash, _existing.locale, _new_generation, _key_version, _code_digest,
    _max_attempts, _max_sends, _resend_cooldown_seconds, _ttl_seconds, _rate_window_seconds, _max_per_window, _request_ip_hash
  );
END;
$function$;
REVOKE ALL ON FUNCTION public._gv_do_resend(jsonb) FROM PUBLIC;

-- 8d. PUBLIC WRAPPER — PREPARE half of the Express-direct delivery model.
--     Enforces database-level dormancy FIRST (before any write, including
--     to the idempotency ledger itself), then commits the challenge-
--     creation side effect (via _gv_do_request/_gv_do_resend) BEFORE
--     Express ever calls an email/SMS provider, and leaves the
--     idempotency ledger row in `result_state = 'prepared'` — NOT
--     'committed' — until gv_finalize_verification_delivery below
--     records what the provider actually did.
--
--     Returns one of four shapes:
--       {status: 'fresh',    result, attemptToken}  — a brand-new
--         challenge was just created; Express should derive the code and
--         send it now, presenting `attemptToken` to finalize.
--       {status: 'resume',   result, attemptToken}  — a PRIOR attempt
--         with this exact key created the challenge but crashed before
--         finalizing, and enough time has passed that it is safe to
--         attempt a resume; `attemptToken` is a FRESH, ROTATED value —
--         the prior attempt's own (now-stale) token can never finalize
--         successfully again (see gv_finalize_verification_delivery).
--         Express should derive the SAME code (deterministic derivation
--         makes this safe) and (re-)send.
--       {status: 'replayed', result}                — this exact request
--         already finished (committed); Express must NOT call the
--         provider again and should return `result` as-is.
--       {status: 'error',    error}                 — a genuinely
--         unexpected internal failure was caught and recorded as
--         `result_state = 'failed'`; Express should treat this as a hard
--         error. (Expected control-flow rejections — rate limits,
--         in-flight, key reuse, disabled purpose — are raised as SQL
--         exceptions instead, deliberately rolling back any tentative
--         ledger row along with them; see this function's own EXCEPTION
--         block for why "mark failed, then re-raise" cannot actually
--         persist anything in PostgreSQL.)
--     A concurrent identical request that is still genuinely in flight
--     (fresh 'prepared' row) raises VERIFICATION_ALREADY_IN_FLIGHT rather
--     than returning any of the above.
CREATE OR REPLACE FUNCTION public.gv_prepare_verification_delivery(
  _key text,
  _scope_kind text,
  _operation text,
  _request_fingerprint text,
  _purpose text,
  _workspace_id uuid,
  _actor_ref_hash text,
  _args jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _row public.verification_idempotency%ROWTYPE;
  _result jsonb;
  _new_token uuid;
  _error_code text;
  IN_FLIGHT_STALE_SECONDS CONSTANT integer := 30;
BEGIN
  IF _key IS NULL OR length(_key) < 16 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_INVALID';
  END IF;
  IF _operation NOT IN ('request', 'resend') THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_UNKNOWN';
  END IF;
  IF NOT public.gv_is_purpose_enabled(_purpose) THEN
    RAISE EXCEPTION 'VERIFICATION_PURPOSE_DISABLED';
  END IF;

  INSERT INTO public.verification_idempotency (key, scope_kind, operation, purpose, workspace_id, request_fingerprint, actor_ref_hash, result_state)
  VALUES (_key, _scope_kind, _operation, _purpose, _workspace_id, _request_fingerprint, _actor_ref_hash, 'prepared')
  ON CONFLICT (key) DO NOTHING;

  SELECT * INTO _row FROM public.verification_idempotency WHERE key = _key FOR UPDATE;

  IF _row.operation <> _operation OR _row.scope_kind <> _scope_kind OR _row.request_fingerprint <> _request_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
  END IF;

  IF _row.result_state = 'committed' THEN
    RETURN jsonb_build_object('status', 'replayed', 'result', _row.safe_result);
  END IF;

  IF _row.result_state = 'failed' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_FAILED_PREVIOUSLY';
  END IF;

  -- result_state = 'prepared'. Either THIS call just inserted the row
  -- (prepared_at IS NULL — the ordinary, no-crash path, proceed to create
  -- the challenge below) or a PRIOR call already created it.
  IF _row.prepared_at IS NOT NULL THEN
    IF _row.prepared_at > now() - make_interval(secs => IN_FLIGHT_STALE_SECONDS) THEN
      RAISE EXCEPTION 'VERIFICATION_ALREADY_IN_FLIGHT';
    END IF;
    -- Stale: the prior attempt almost certainly crashed between prepare
    -- and finalize (Express process died, connection dropped, etc), OR
    -- (unavoidably, since this is a heuristic, not a proof of death) its
    -- provider call is simply still slow. Either way, resuming is made
    -- SAFE by rotating the attempt token here: the prior attempt's own
    -- token is left on record nowhere else, so when/if it eventually
    -- calls gv_finalize_verification_delivery with its OLD token, that
    -- call will find a mismatch and be rejected — it can never overwrite
    -- whatever THIS resumed attempt (or a later one) records. The
    -- unavoidable cost is a genuine at-least-once provider submission
    -- (documented in docs/GENERIC_VERIFICATION_CORE.md §Delivery) when
    -- the "crashed" attempt was in fact still alive — never a database
    -- inconsistency.
    _new_token := gen_random_uuid();
    UPDATE public.verification_idempotency SET attempt_token = _new_token, prepared_at = now() WHERE key = _key;
    RETURN jsonb_build_object('status', 'resume', 'result', _row.safe_result, 'attemptToken', _new_token);
  END IF;

  -- This dispatch is wrapped in its OWN nested BEGIN/EXCEPTION block —
  -- deliberately NOT the same block that contains the tentative ledger
  -- INSERT above. PL/pgSQL's exception handling rolls back to an implicit
  -- SAVEPOINT taken at the START of whichever block's EXCEPTION clause
  -- catches the error, undoing every persistent database change made
  -- since THAT block was entered — including changes made by nested
  -- function calls. If this handler lived on the OUTER block (as it did
  -- in an earlier version of this function), catching an error here would
  -- also silently undo the tentative ledger INSERT from before the CASE
  -- dispatch, leaving the subsequent "mark failed" UPDATE below with zero
  -- matching rows — a no-op — so NOTHING would persist at all, not even a
  -- 'failed' marker, despite the code appearing to record one. Scoping
  -- the EXCEPTION to this inner block instead means only the FAILED
  -- dispatch's own effects are undone; the outer INSERT survives, so the
  -- UPDATE in this handler has a real row to mark.
  BEGIN
    CASE _operation
      WHEN 'request' THEN
        SELECT public._gv_do_request(_args) INTO _result;
      WHEN 'resend' THEN
        SELECT public._gv_do_resend(_args) INTO _result;
    END CASE;
  EXCEPTION
    WHEN OTHERS THEN
      _error_code := SQLERRM;
      IF _error_code IN ('VERIFICATION_ALREADY_IN_FLIGHT', 'VERIFICATION_RATE_LIMITED', 'IDEMPOTENCY_KEY_REUSED',
                          'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_OPERATION_UNKNOWN', 'IDEMPOTENCY_KEY_FAILED_PREVIOUSLY',
                          'VERIFICATION_PURPOSE_DISABLED', 'VERIFICATION_SCOPE_MISMATCH') THEN
        -- Expected control-flow rejections: re-raise. With no further
        -- handler above this one, this propagates out of the function
        -- entirely and rolls back the WHOLE statement, including the
        -- tentative ledger insert — there is nothing to persist for
        -- these; a retry later should start clean, not find a stale row
        -- blocking it.
        RAISE;
      END IF;
      -- A genuinely unexpected internal failure (e.g. a foreign-key
      -- violation, a constraint this function didn't anticipate). Record
      -- it and RETURN a structured error instead of raising, so the
      -- ENCLOSING statement — which still has the earlier ledger INSERT
      -- intact, since that happened in the OUTER block, outside this
      -- savepoint's scope — can commit successfully with the failure
      -- marker in place. Node checks for `status: 'error'` and throws a
      -- JS error from it.
      UPDATE public.verification_idempotency SET result_state = 'failed', completed_at = now() WHERE key = _key;
      RETURN jsonb_build_object('status', 'error', 'error', _error_code);
  END;

  _new_token := gen_random_uuid();
  UPDATE public.verification_idempotency
  SET prepared_at = now(), safe_result = _result, attempt_token = _new_token,
      challenge_id = NULLIF(_result->>'challengeId', '')::uuid
  WHERE key = _key;

  RETURN jsonb_build_object('status', 'fresh', 'result', _result, 'attemptToken', _new_token);
END;
$function$;

-- 8e. PUBLIC WRAPPER — FINALIZE half of the Express-direct delivery
--     model. Requires and validates the `attemptToken` issued by the
--     matching prepare call — a stale (rotated-away) token is rejected
--     without modifying anything, so an old, superseded Express request
--     can never overwrite a newer outcome. Records what the provider
--     actually did and moves the ledger row from 'prepared' to
--     'committed' — the ONLY transition that makes a 'request'/'resend'
--     idempotency key safe to replay. Idempotent itself: finalizing an
--     already-committed key returns the existing committed result rather
--     than double-recording delivery evidence.
CREATE OR REPLACE FUNCTION public.gv_finalize_verification_delivery(
  _key text,
  _attempt_token uuid,
  _outcome text,
  _provider_name text,
  _provider_message_id text,
  _error_code text,
  _error_message text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _row public.verification_idempotency%ROWTYPE;
  _final_result jsonb;
BEGIN
  IF _outcome NOT IN ('provider_accepted', 'retryable_failure', 'permanent_failure', 'unconfigured', 'ambiguous', 'derivation_key_unavailable') THEN
    RAISE EXCEPTION 'DELIVERY_OUTCOME_UNKNOWN';
  END IF;

  SELECT * INTO _row FROM public.verification_idempotency WHERE key = _key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_NOT_FOUND';
  END IF;

  IF _row.result_state = 'committed' THEN
    RETURN jsonb_build_object('applied', true, 'alreadyFinalized', true, 'result', _row.safe_result);
  END IF;
  IF _row.result_state <> 'prepared' THEN
    RAISE EXCEPTION 'VERIFICATION_NOT_PREPARED';
  END IF;

  -- The core ownership check: a stale (superseded-by-resume) attempt
  -- token can never finalize. Returned as a SOFT rejection (not an
  -- exception) — the caller made a real provider call in good faith and
  -- needs to know it was superseded, not crash on an unhandled error. The
  -- CURRENT ledger state (whatever the newer attempt has done) is
  -- returned so the stale caller can still respond coherently.
  IF _row.attempt_token IS DISTINCT FROM _attempt_token THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'stale_attempt_token', 'result', _row.safe_result);
  END IF;

  _final_result := _row.safe_result || jsonb_build_object('deliveryOutcome', _outcome);

  IF _outcome = 'provider_accepted' THEN
    UPDATE public.verification_challenges SET status = 'provider_accepted'
    WHERE id = _row.challenge_id AND status = 'pending_delivery';
  ELSIF _outcome IN ('permanent_failure', 'unconfigured', 'derivation_key_unavailable') THEN
    UPDATE public.verification_challenges SET status = 'delivery_failed'
    WHERE id = _row.challenge_id AND status IN ('pending_delivery', 'provider_accepted');
  END IF;
  -- 'retryable_failure' and 'ambiguous' deliberately leave the challenge
  -- in its current status: the caller must explicitly resend (a new
  -- generation) to try again — this core never auto-retries a send
  -- itself, because there is no background worker to do so.

  INSERT INTO public.verification_delivery_attempts (
    challenge_id, idempotency_key, channel, outcome, provider_name, provider_message_id, error_code, error_message
  ) VALUES (
    _row.challenge_id, _key, _row.safe_result->>'channel', _outcome, _provider_name, _provider_message_id, _error_code, left(_error_message, 300)
  );

  UPDATE public.verification_idempotency
  SET result_state = 'committed', safe_result = _final_result, completed_at = now()
  WHERE key = _key;

  RETURN jsonb_build_object('applied', true, 'alreadyFinalized', false, 'result', _final_result);
END;
$function$;

-- 8f. INTERNAL — verify. Locks the live challenge, enforces attempt/
--     lockout/expiry, compares the caller-supplied candidate digest
--     (computed in Node using the challenge's OWN recorded key_version —
--     never the newest key), and on success issues exactly one proof.
--     Binding checks are STRICT and null-safe throughout: a caller that
--     omits workspaceId/subjectRefHash is compared against the
--     challenge's own value with `IS DISTINCT FROM`, which correctly
--     REJECTS when the challenge has a real binding the caller didn't
--     supply — omitting a field can never bypass a binding that exists.
CREATE OR REPLACE FUNCTION public._gv_do_verify(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _handle text := _args->>'handle';
  _candidate_digest text := _args->>'candidateDigest';
  _purpose text := _args->>'purpose';
  _channel text := _args->>'channel';
  _workspace_id uuid := NULLIF(_args->>'workspaceId', '')::uuid;
  _subject_ref_hash text := NULLIF(_args->>'subjectRefHash', '');
  _ip_hash text := NULLIF(_args->>'ipHash', '');
  _issues_proof boolean := COALESCE((_args->>'issuesProof')::boolean, true);
  _proof_hash text := _args->>'proofHash';
  _proof_ttl_seconds integer := (_args->>'proofTtlSeconds')::integer;
  _chal public.verification_challenges%ROWTYPE;
  _next_attempt integer;
BEGIN
  SELECT * INTO _chal FROM public.verification_challenges WHERE handle = _handle FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;

  -- Wrong purpose/channel/workspace/subject can never verify against this
  -- challenge, and the response is the SAME generic shape as an incorrect
  -- code — no distinguishing signal leaks which check failed. Both
  -- workspace_id and subject_ref_hash use a STRICT `IS DISTINCT FROM`
  -- comparison (no "only check if the caller supplied one" carve-out) —
  -- an omitted field never bypasses a real binding.
  IF _chal.purpose <> _purpose OR _chal.channel <> _channel
     OR _chal.workspace_id IS DISTINCT FROM _workspace_id
     OR _chal.subject_ref_hash IS DISTINCT FROM _subject_ref_hash THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;

  IF _chal.status = 'verified' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_verified');
  END IF;
  IF _chal.status NOT IN ('pending_delivery', 'provider_accepted') THEN
    RETURN jsonb_build_object('ok', false, 'reason', _chal.status);
  END IF;
  IF _chal.expires_at <= now() THEN
    UPDATE public.verification_challenges SET status = 'expired' WHERE id = _chal.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF _chal.attempt_count >= _chal.max_attempts THEN
    UPDATE public.verification_challenges SET status = 'locked' WHERE id = _chal.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'locked');
  END IF;

  _next_attempt := _chal.attempt_count + 1;

  IF _chal.code_digest <> _candidate_digest THEN
    INSERT INTO public.verification_attempts (challenge_id, attempt_no, result, ip_hash)
    VALUES (_chal.id, _next_attempt, 'incorrect', _ip_hash);

    IF _next_attempt >= _chal.max_attempts THEN
      UPDATE public.verification_challenges SET attempt_count = _next_attempt, status = 'locked' WHERE id = _chal.id;
      RETURN jsonb_build_object('ok', false, 'reason', 'locked');
    END IF;

    UPDATE public.verification_challenges SET attempt_count = _next_attempt WHERE id = _chal.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;

  INSERT INTO public.verification_attempts (challenge_id, attempt_no, result, ip_hash)
  VALUES (_chal.id, _next_attempt, 'correct', _ip_hash);

  UPDATE public.verification_challenges
  SET status = 'verified', verified_at = now(), attempt_count = _next_attempt
  WHERE id = _chal.id;

  IF _issues_proof THEN
    INSERT INTO public.verification_proofs (
      challenge_id, proof_hash, purpose, channel, workspace_id, subject_kind, subject_ref, subject_ref_hash, expires_at
    ) VALUES (
      _chal.id, _proof_hash, _chal.purpose, _chal.channel, _chal.workspace_id, _chal.subject_kind, _chal.subject_ref, _chal.subject_ref_hash,
      now() + make_interval(secs => _proof_ttl_seconds)
    );
    RETURN jsonb_build_object('ok', true, 'challengeId', _chal.id, 'proofIssued', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'challengeId', _chal.id, 'proofIssued', false);
END;
$function$;
REVOKE ALL ON FUNCTION public._gv_do_verify(jsonb) FROM PUBLIC;

-- 8g. INTERNAL — revoke. Explicit admin/system cancellation, also revokes
--     any live proof.
CREATE OR REPLACE FUNCTION public._gv_do_revoke(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _handle text := _args->>'handle';
  _reason text := COALESCE(_args->>'reason', 'revoked');
  _chal_id uuid;
BEGIN
  UPDATE public.verification_challenges
  SET status = 'revoked', revoked_at = now(), revoked_reason = _reason
  WHERE handle = _handle AND status IN ('pending_delivery', 'provider_accepted', 'verified')
  RETURNING id INTO _chal_id;

  IF _chal_id IS NOT NULL THEN
    UPDATE public.verification_proofs
    SET status = 'revoked', revoked_at = now()
    WHERE challenge_id = _chal_id AND status = 'active';
  END IF;

  RETURN jsonb_build_object('ok', _chal_id IS NOT NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public._gv_do_revoke(jsonb) FROM PUBLIC;

-- 8h. PUBLIC WRAPPER — idempotent dispatch for 'verify' and 'revoke',
--     both of which have no external side effect and no crash window, so
--     a single-phase dispatch (insert-then-execute-then-commit, all in
--     one statement) is sufficient — unlike 'request'/'resend', which
--     need the two-phase prepare/finalize split above because Express's
--     provider call sits BETWEEN database commits.
--
--     'verify' is idempotent on a caller-supplied `requestId`: the
--     fingerprint includes the candidate digest and scope, so (a) the
--     SAME requestId with the SAME code/scope replays the committed
--     result without re-executing _gv_do_verify (no double attempt-
--     counting, and a replayed proof is safely re-derivable — see
--     crypto.ts's deriveProofToken and service.ts); (b) the SAME
--     requestId with a DIFFERENT code/scope is rejected as
--     IDEMPOTENCY_KEY_REUSED, never silently re-interpreted; (c) a NEW
--     requestId with a wrong code always re-executes and counts as a
--     genuinely new attempt; (d) concurrent identical calls serialize on
--     the ledger row's FOR UPDATE lock, so exactly one attempt/proof is
--     created; (e) a transport loss after a successful commit replays the
--     identical safe_result, and Node re-derives the identical usable
--     proof token from it deterministically.
CREATE OR REPLACE FUNCTION public.gv_execute_idempotent(
  _key text,
  _scope_kind text,
  _operation text,
  _request_fingerprint text,
  _purpose text,
  _workspace_id uuid,
  _actor_ref_hash text,
  _args jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _row public.verification_idempotency%ROWTYPE;
  _result jsonb;
BEGIN
  IF _key IS NULL OR length(_key) < 16 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_INVALID';
  END IF;
  IF _operation NOT IN ('verify', 'revoke') THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_UNKNOWN';
  END IF;
  IF NOT public.gv_is_purpose_enabled(_purpose) THEN
    RAISE EXCEPTION 'VERIFICATION_PURPOSE_DISABLED';
  END IF;

  INSERT INTO public.verification_idempotency (key, scope_kind, operation, purpose, workspace_id, request_fingerprint, actor_ref_hash, result_state)
  VALUES (_key, _scope_kind, _operation, _purpose, _workspace_id, _request_fingerprint, _actor_ref_hash, 'prepared')
  ON CONFLICT (key) DO NOTHING;

  SELECT * INTO _row FROM public.verification_idempotency WHERE key = _key FOR UPDATE;

  IF _row.operation <> _operation OR _row.scope_kind <> _scope_kind OR _row.request_fingerprint <> _request_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
  END IF;

  IF _row.result_state = 'committed' THEN
    RETURN jsonb_build_object('replayed', true, 'result', _row.safe_result);
  END IF;

  IF _row.result_state = 'failed' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_FAILED_PREVIOUSLY';
  END IF;

  CASE _operation
    WHEN 'verify' THEN
      SELECT public._gv_do_verify(_args) INTO _result;
    WHEN 'revoke' THEN
      SELECT public._gv_do_revoke(_args) INTO _result;
  END CASE;

  UPDATE public.verification_idempotency
  SET result_state = 'committed', safe_result = _result, completed_at = now(),
      challenge_id = NULLIF(_result->>'challengeId', '')::uuid
  WHERE key = _key;

  RETURN jsonb_build_object('replayed', false, 'result', _result);
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM NOT IN ('IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_OPERATION_UNKNOWN',
                        'IDEMPOTENCY_KEY_FAILED_PREVIOUSLY', 'VERIFICATION_PURPOSE_DISABLED') THEN
      -- Same rationale as gv_prepare_verification_delivery: re-raising
      -- would roll back this whole statement anyway (including whatever
      -- this UPDATE does), but 'verify'/'revoke' have no crash window to
      -- protect against and no Express-side follow-up call, so there is
      -- no resume path that depends on a 'failed' marker surviving here —
      -- attempting to persist one would be a no-op at best. Re-raise
      -- directly; the tentative ledger row (if any) rolls back cleanly.
      NULL;
    END IF;
    RAISE;
END;
$function$;

-- 8i. PUBLIC WRAPPER — consume a proof. The ONE function a FUTURE
--     consumer calls from WITHIN ITS OWN SECURITY DEFINER function (a
--     plain SQL function call, not a second RPC round-trip) so proof
--     consumption is atomic with that consumer's business mutation in a
--     single transaction. See docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md
--     for the exact pattern. No consumer exists yet — nothing in this
--     codebase calls this today. Binding checks are strict and null-safe,
--     same rationale as _gv_do_verify.
CREATE OR REPLACE FUNCTION public.gv_consume_verification_proof(
  _proof_hash text,
  _purpose text,
  _channel text,
  _workspace_id uuid,
  _subject_ref_hash text,
  _consumed_by_context text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _proof public.verification_proofs%ROWTYPE;
BEGIN
  IF NOT public.gv_is_purpose_enabled(_purpose) THEN
    RAISE EXCEPTION 'VERIFICATION_PURPOSE_DISABLED';
  END IF;

  SELECT * INTO _proof FROM public.verification_proofs WHERE proof_hash = _proof_hash FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF _proof.purpose <> _purpose OR _proof.channel <> _channel
     OR _proof.workspace_id IS DISTINCT FROM _workspace_id
     OR _proof.subject_ref_hash IS DISTINCT FROM _subject_ref_hash THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'scope_mismatch');
  END IF;

  IF _proof.status = 'consumed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_consumed');
  END IF;
  IF _proof.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', _proof.status);
  END IF;
  IF _proof.expires_at <= now() THEN
    UPDATE public.verification_proofs SET status = 'expired' WHERE id = _proof.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  UPDATE public.verification_proofs
  SET status = 'consumed', consumed_at = now(), consumed_by_context = _consumed_by_context
  WHERE id = _proof.id;

  RETURN jsonb_build_object(
    'ok', true, 'challengeId', _proof.challenge_id, 'subjectKind', _proof.subject_kind,
    'subjectRef', _proof.subject_ref, 'subjectRefHash', _proof.subject_ref_hash
  );
END;
$function$;

-- 8j. PUBLIC WRAPPER — safe status lookup. Never returns destination,
--     digest, or code. Read-only, no dormancy check needed (no write is
--     ever possible through this function).
CREATE OR REPLACE FUNCTION public.gv_get_verification_status(_handle text) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'status', status, 'purpose', purpose, 'channel', channel, 'generation', generation,
    'expiresAt', expires_at, 'attemptsRemaining', GREATEST(max_attempts - attempt_count, 0),
    'resendAvailableAt', created_at + make_interval(secs => resend_cooldown_seconds)
  )
  FROM public.verification_challenges WHERE handle = _handle;
$function$;

-- 8k. PUBLIC WRAPPER — purge expired idempotency rows. Bounded
--     (LIMIT + FOR UPDATE SKIP LOCKED, never blocks/duplicates live
--     claims) and returns the EXACT number deleted via GET DIAGNOSTICS —
--     a plain `RETURNING ... INTO` on a multi-row DELETE silently keeps
--     only the FIRST row's value in PL/pgSQL, which previously made this
--     function report "1" even when several rows were purged in one call.
CREATE OR REPLACE FUNCTION public.gv_purge_expired_idempotency(_limit integer) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _n integer;
BEGIN
  WITH victims AS (
    SELECT key FROM public.verification_idempotency
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.verification_idempotency USING victims WHERE public.verification_idempotency.key = victims.key;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

-- ============================================================
-- 9. ACL lockdown.
--
--    `internal_fns` are NEVER granted to anyone — not PUBLIC, not
--    service_role. They are reachable ONLY as nested calls from within
--    `public_fns`'s own SECURITY DEFINER execution context (PostgreSQL
--    resolves function-call privilege checks against the DEFINING role
--    for the duration of a SECURITY DEFINER function's execution, so a
--    wrapper can invoke an internal function it has no grant on — the
--    caller of the WRAPPER never gets that same ability).
--
--    `public_fns` are the ONLY verification RPCs ever executable by
--    service_role, and never by anon/authenticated/PUBLIC.
-- ============================================================
DO $acl$
DECLARE
  fn text;
  internal_fns text[] := ARRAY[
    'public._gv_create_challenge_row(text, text, text, uuid, text, text, text, text, text, text, integer, integer, text, integer, integer, integer, integer, integer, integer, text)',
    'public._gv_do_request(jsonb)',
    'public._gv_do_resend(jsonb)',
    'public._gv_do_verify(jsonb)',
    'public._gv_do_revoke(jsonb)',
    'public.gv_is_purpose_enabled(text)'
  ];
  public_fns text[] := ARRAY[
    'public.gv_prepare_verification_delivery(text, text, text, text, text, uuid, text, jsonb)',
    'public.gv_finalize_verification_delivery(text, uuid, text, text, text, text, text)',
    'public.gv_execute_idempotent(text, text, text, text, text, uuid, text, jsonb)',
    'public.gv_consume_verification_proof(text, text, text, uuid, text, text)',
    'public.gv_get_verification_status(text)',
    'public.gv_purge_expired_idempotency(integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY internal_fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY public_fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$acl$;

-- ============================================================
-- 10. Build-time verification — proves the invariants this migration
--     claims, exactly like the established Workspace Invitations v5.1
--     `DO $verify$` convention: a migration that violates its own
--     security posture fails to apply, it does not silently ship broken.
-- ============================================================
DO $verify$
DECLARE
  t text;
  fn text;
  sig text;
  tables text[] := ARRAY[
    'verification_challenges', 'verification_attempts', 'verification_proofs',
    'verification_delivery_attempts', 'verification_idempotency'
  ];
  append_only_tables text[] := ARRAY['verification_attempts', 'verification_delivery_attempts'];
  internal_fns text[] := ARRAY[
    'public._gv_create_challenge_row(text, text, text, uuid, text, text, text, text, text, text, integer, integer, text, integer, integer, integer, integer, integer, integer, text)',
    'public._gv_do_request(jsonb)',
    'public._gv_do_resend(jsonb)',
    'public._gv_do_verify(jsonb)',
    'public._gv_do_revoke(jsonb)',
    'public.gv_is_purpose_enabled(text)'
  ];
  public_fns text[] := ARRAY[
    'public.gv_prepare_verification_delivery(text, text, text, text, text, uuid, text, jsonb)',
    'public.gv_finalize_verification_delivery(text, uuid, text, text, text, text, text)',
    'public.gv_execute_idempotent(text, text, text, text, text, uuid, text, jsonb)',
    'public.gv_consume_verification_proof(text, text, text, uuid, text, text)',
    'public.gv_get_verification_status(text)',
    'public.gv_purge_expired_idempotency(integer)'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '098: table % was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '098: RLS not enabled on %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION '098: % unexpectedly has a browser-facing RLS policy — must be zero policies (service_role bypasses RLS)', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '098: anon/authenticated unexpectedly has SELECT on %', t;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '098: service_role lacks SELECT on %', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY append_only_tables LOOP
    IF has_table_privilege('service_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '098: append-only table % unexpectedly grants DELETE to service_role', t;
    END IF;
    IF has_table_privilege('service_role', 'public.' || t, 'UPDATE') THEN
      RAISE EXCEPTION '098: append-only table % unexpectedly grants UPDATE to service_role', t;
    END IF;
  END LOOP;

  -- Internal functions: NOBODY may execute them directly, including
  -- service_role — they are reachable only as nested calls from within a
  -- public wrapper's own SECURITY DEFINER context.
  FOREACH fn IN ARRAY internal_fns LOOP
    sig := to_regprocedure(fn)::text;
    IF sig IS NULL THEN
      RAISE EXCEPTION '098: internal function % was not created', fn;
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: anon can execute internal function %', fn;
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: authenticated can execute internal function %', fn;
    END IF;
    IF has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: service_role unexpectedly CAN execute internal function % directly — internal functions must only be reachable via a public wrapper', fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(fn)
        AND p.prosecdef = true
        AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=public, pg_temp')
    ) THEN
      RAISE EXCEPTION '098: internal function % is not SECURITY DEFINER with search_path pinned to public, pg_temp', fn;
    END IF;
  END LOOP;

  -- Public wrappers: ONLY service_role may execute them.
  FOREACH fn IN ARRAY public_fns LOOP
    sig := to_regprocedure(fn)::text;
    IF sig IS NULL THEN
      RAISE EXCEPTION '098: public wrapper function % was not created', fn;
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: anon can execute %', fn;
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: authenticated can execute %', fn;
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: service_role cannot execute %', fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(fn)
        AND p.prosecdef = true
        AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=public, pg_temp')
    ) THEN
      RAISE EXCEPTION '098: % is not SECURITY DEFINER with search_path pinned to public, pg_temp', fn;
    END IF;
  END LOOP;

  -- Database-facing dormancy: gv_is_purpose_enabled must be empty right
  -- now — every purpose ships disabled at BOTH layers in this pass.
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['signup_email','signup_phone','password_reset','login_step_up','change_email','change_phone','sensitive_action','workspace_invitation']) p
    WHERE public.gv_is_purpose_enabled(p)
  ) THEN
    RAISE EXCEPTION '098: gv_is_purpose_enabled unexpectedly reports a purpose as enabled — every purpose must ship disabled';
  END IF;

  RAISE NOTICE '098: Generic Verification Core v1 installed — % tables, % internal + % public-wrapper RPCs, all service_role-only, RLS enabled with zero browser policies, all purposes disabled at the database layer', array_length(tables, 1), array_length(internal_fns, 1), array_length(public_fns, 1);
END
$verify$;
