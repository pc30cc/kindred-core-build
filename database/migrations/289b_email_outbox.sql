-- 289b — The email outbox: transactional mail a relay hiccup must not lose
-- (owner, 2026-10-29: email is provider-driven — our own relay today,
-- Resend, SendGrid or another provider tomorrow — and works the same through
-- every one of them).
--
-- Until now a payment receipt, a plan mail, a trial's end, a password reset
-- or a verification link was tried once: a relay restarted by a redeploy, a
-- provider's brief outage or a timeout lost it for good, and the user was
-- told it had been sent. Invitations and the notification emails had queues
-- of their own; these had none. This is theirs, the same for every provider:
--
-- 1. public.email_outbox: one row per mail still to send (or sent, failed,
--    expired or cancelled in the last 7 days). The request it sends is in
--    `payload`, sealed with PLUGIN_SECRETS_MASTER_KEY when the backend has it
--    (a reset link carries a live token), and emptied the moment the row
--    reaches a final state: a check keeps every final row's payload NULL, so
--    nothing in it outlives the mail. server/services/email/outbox.ts writes
--    it (enqueueEmail, and sendEmailWithRetry after a failed first attempt)
--    and sends it: each attempt goes through sendEmail, so each attempt is
--    logged, and only a failure that can pass (a timeout, a dropped
--    connection, a provider's own error) is tried again, after 1, 5, 15 and
--    60 minutes, then every 3 hours, for up to 24 hours. A refused address,
--    a suppressed one or a missing setting is never retried.
--    `dedupe_key` (unique) makes the same mail queued twice one mail;
--    `supersede_key` lets a newer mail of the same kind (a fresh reset link)
--    cancel an older one still waiting; `after_sent` is what follows the
--    hand-over (the earlier reset links are revoked only once the new one
--    has reached the provider), from a closed list in the code.
-- 2. public.email_outbox_claim(): hands the next due rows to one worker, under
--    a lease (FOR UPDATE SKIP LOCKED, like the invitation outbox); a row whose
--    lease ran out (its worker died mid-send, or the backend was replaced) is
--    due again. Delivery is at least once, as for invitations.
--
-- Both are the backend's only (service_role): RLS on with a service_role
-- policy, nothing granted to anon or authenticated; the function is
-- SECURITY INVOKER with a pinned search_path. A deleted workspace takes its
-- waiting mail with it (ON DELETE CASCADE); platform mail (a reset, a
-- verification link) has no workspace.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The code
-- runs without it: enqueueing then fails, and every caller sends inline
-- instead, as it did before, so the order is safe either way. It writes no
-- data, changes no existing table and drops nothing. Safe to run twice. Dry
-- run: wrap the file in BEGIN; … ROLLBACK; (it opens no transaction of its
-- own). Like 284 to 289, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  template_slug       text,
  category            text NOT NULL DEFAULT 'transactional',
  payload             jsonb,
  dedupe_key          text,
  supersede_key       text,
  after_sent          jsonb,
  status              text NOT NULL DEFAULT 'pending',
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 12,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  give_up_at          timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  claim_token         uuid,
  claimed_by          text,
  lease_expires_at    timestamptz,
  provider            text,
  provider_message_id text,
  last_error_code     text,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CONSTRAINT email_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'expired', 'cancelled')),
  CONSTRAINT email_outbox_category_check
    CHECK (category IN ('transactional', 'notification', 'marketing')),
  CONSTRAINT email_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT email_outbox_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 50),
  -- A final row has its finish time, and nothing of the mail it sent.
  CONSTRAINT email_outbox_final_check
    CHECK ((status IN ('sent', 'failed', 'expired', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT email_outbox_payload_check
    CHECK (status NOT IN ('sent', 'failed', 'expired', 'cancelled') OR payload IS NULL),
  CONSTRAINT email_outbox_pending_payload_check
    CHECK (status NOT IN ('pending', 'sending') OR payload IS NOT NULL),
  CONSTRAINT email_outbox_sending_check
    CHECK (status <> 'sending' OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT email_outbox_keys_check
    CHECK ((dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200)
       AND (supersede_key IS NULL OR length(supersede_key) BETWEEN 1 AND 200)),
  CONSTRAINT email_outbox_error_check
    CHECK ((last_error IS NULL OR length(last_error) <= 300)
       AND (last_error_code IS NULL OR length(last_error_code) <= 40))
);

COMMENT ON TABLE public.email_outbox IS
  'Transactional mail queued for (another) attempt, the same for every email provider: sent by server/services/email/outbox.ts through sendEmail, retried only on a transient failure (1, 5, 15, 60 min, then every 3 h, up to 24 h). payload is the sealed request, NULL once final; final rows are purged after 7 days. Claimed by email_outbox_claim(). Server-only. Migration 289b.';

CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_key_idx
  ON public.email_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_outbox_due_idx
  ON public.email_outbox (next_attempt_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS email_outbox_lease_idx
  ON public.email_outbox (lease_expires_at) WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS email_outbox_supersede_idx
  ON public.email_outbox (supersede_key, created_at) WHERE status = 'pending' AND supersede_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_outbox_finished_idx
  ON public.email_outbox (finished_at) WHERE finished_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_outbox_workspace_idx
  ON public.email_outbox (workspace_id) WHERE workspace_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.email_outbox FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.email_outbox FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.email_outbox FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.email_outbox TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'email_outbox' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.email_outbox
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- Hand the next due rows to one worker: a pending row whose time has come,
-- or a sending row whose lease ran out. Each claimed row is 'sending' under
-- a fresh claim token until its worker completes it (guarded by that token)
-- or its lease runs out; the attempt is counted here, so a worker that dies
-- mid-send still used one. SKIP LOCKED: two workers never claim the same row.
CREATE OR REPLACE FUNCTION public.email_outbox_claim(
  p_worker text,
  p_limit integer,
  p_lease_seconds integer
) RETURNS SETOF public.email_outbox
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH due AS (
    SELECT o.id
      FROM public.email_outbox o
     WHERE (o.status = 'pending' AND o.next_attempt_at <= now())
        OR (o.status = 'sending' AND o.lease_expires_at <= now())
     ORDER BY o.next_attempt_at
     LIMIT greatest(1, least(coalesce(p_limit, 1), 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_outbox o
     SET status = 'sending',
         claim_token = gen_random_uuid(),
         claimed_by = left(coalesce(p_worker, ''), 128),
         lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)),
         attempts = o.attempts + 1,
         updated_at = now()
    FROM due
   WHERE o.id = due.id
  RETURNING o.*;
$fn$;

COMMENT ON FUNCTION public.email_outbox_claim(text, integer, integer) IS
  'Claims the next due email_outbox rows (pending and due, or sending with an expired lease) for one worker under a lease, counting the attempt. Server-only. Migration 289b.';

DO $acl$
DECLARE
  f text := 'public.email_outbox_claim(text, integer, integer)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $acl$;

RESET lock_timeout;
