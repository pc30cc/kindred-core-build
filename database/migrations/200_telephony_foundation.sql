-- 200_telephony_foundation.sql — WEBYAR Telephony (provider-neutral) MVP.
-- Forward-only. Does not touch migrations 169-198.

-- ── 1. Provider-neutral technical call mapping ────────────────────────────
CREATE TABLE IF NOT EXISTS public.telephony_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  external_call_id text,
  sip_call_id text NOT NULL,
  call_session_id uuid,
  room_name text,
  asterisk_channel_id text,
  caller_number text,
  called_number text,
  lifecycle text NOT NULL DEFAULT 'incoming',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telephony_calls_lifecycle_check CHECK (
    lifecycle = ANY (ARRAY['incoming','ringing','connected','ended','failed','rejected'])
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS telephony_calls_dialog_uidx
  ON public.telephony_calls (installation_id, provider, sip_call_id);
CREATE UNIQUE INDEX IF NOT EXISTS telephony_calls_session_uidx
  ON public.telephony_calls (call_session_id) WHERE call_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telephony_calls_workspace_idx
  ON public.telephony_calls (workspace_id, created_at DESC);

GRANT ALL ON public.telephony_calls TO service_role;
ALTER TABLE public.telephony_calls ENABLE ROW LEVEL SECURITY;

-- ── 2. Registration / integration state (never any password) ──────────────
CREATE TABLE IF NOT EXISTS public.telephony_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'daftareshoma',
  sip_username text,
  sip_extension text,
  sip_domain_udp text,
  sip_domain_tcp text,
  sip_domain_webrtc text,
  outgoing_line text,
  transport text NOT NULL DEFAULT 'udp',
  state text NOT NULL DEFAULT 'not_configured',
  last_registered_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  last_inbound_call_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telephony_registrations_state_check CHECK (
    state = ANY (ARRAY['not_configured','configured','registering','registered','failed','disabled'])
  ),
  CONSTRAINT telephony_registrations_transport_check CHECK (
    transport = ANY (ARRAY['udp','tcp','tls'])
  )
);

CREATE INDEX IF NOT EXISTS telephony_registrations_workspace_idx
  ON public.telephony_registrations (workspace_id);

GRANT ALL ON public.telephony_registrations TO service_role;
ALTER TABLE public.telephony_registrations ENABLE ROW LEVEL SECURITY;

-- Shared updated_at trigger (already present in this database as a helper).
CREATE OR REPLACE FUNCTION public.telephony_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telephony_calls_touch ON public.telephony_calls;
CREATE TRIGGER telephony_calls_touch BEFORE UPDATE ON public.telephony_calls
  FOR EACH ROW EXECUTE FUNCTION public.telephony_touch_updated_at();

DROP TRIGGER IF EXISTS telephony_registrations_touch ON public.telephony_registrations;
CREATE TRIGGER telephony_registrations_touch BEFORE UPDATE ON public.telephony_registrations
  FOR EACH ROW EXECUTE FUNCTION public.telephony_touch_updated_at();

-- ── 3. Atomic single-winner answer ────────────────────────────────────────
-- Exactly one concurrent operator can win a telephony call. Losers get a
-- stable {ok:false, reason:'already_answered'} without any side effect.
CREATE OR REPLACE FUNCTION public.telephony_claim_call(
  p_workspace_id uuid,
  p_call_session_id uuid,
  p_agent_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_call public.call_sessions%ROWTYPE;
  v_queue_id uuid;
BEGIN
  SELECT * INTO v_call
  FROM public.call_sessions
  WHERE id = p_call_session_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'call_not_found');
  END IF;

  IF v_call.entry_source <> 'telephony' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_entry_source');
  END IF;

  IF v_call.state IN ('ended', 'failed', 'cancelled', 'missed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'call_not_active');
  END IF;

  IF v_call.assigned_agent_id IS NOT NULL AND v_call.assigned_agent_id <> p_agent_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
  END IF;

  IF v_call.state IN ('active', 'connecting') AND v_call.assigned_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
  END IF;

  SELECT id INTO v_queue_id
  FROM public.call_queue_entries
  WHERE workspace_id = p_workspace_id
    AND call_session_id = p_call_session_id
  FOR UPDATE;

  IF v_queue_id IS NOT NULL THEN
    UPDATE public.call_queue_entries
       SET state = 'accepted',
           assigned_agent_id = p_agent_id,
           offered_to_user_id = p_agent_id,
           accepted_at = now(),
           updated_at = now()
     WHERE id = v_queue_id
       AND state IN ('queued', 'offered');

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
    END IF;
  END IF;

  UPDATE public.call_sessions
     SET assigned_agent_id = p_agent_id,
         state = 'connecting',
         updated_at = now()
   WHERE id = p_call_session_id
     AND (assigned_agent_id IS NULL OR assigned_agent_id = p_agent_id);

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'call_session_id', p_call_session_id,
    'queue_entry_id', v_queue_id,
    'agent_id', p_agent_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.telephony_claim_call(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telephony_claim_call(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.telephony_claim_call(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telephony_claim_call(uuid, uuid, uuid) TO service_role;

-- ── 4. Asterisk PJSIP Realtime — separate restricted schema ───────────────
-- Never exposed through PostgREST: the Data API only serves `public`.
CREATE SCHEMA IF NOT EXISTS asterisk;
REVOKE ALL ON SCHEMA asterisk FROM PUBLIC;

CREATE TABLE IF NOT EXISTS asterisk.ps_endpoints (
  id varchar(255) PRIMARY KEY,
  transport varchar(40),
  aors varchar(255),
  auth varchar(255),
  context varchar(40) NOT NULL DEFAULT 'webyar-inbound',
  disallow varchar(200) NOT NULL DEFAULT 'all',
  allow varchar(200) NOT NULL DEFAULT 'alaw,ulaw,opus',
  direct_media varchar(5) NOT NULL DEFAULT 'no',
  from_domain varchar(255),
  from_user varchar(255),
  outbound_auth varchar(255),
  rtp_symmetric varchar(5) NOT NULL DEFAULT 'yes',
  force_rport varchar(5) NOT NULL DEFAULT 'yes',
  rewrite_contact varchar(5) NOT NULL DEFAULT 'yes',
  ice_support varchar(5) NOT NULL DEFAULT 'no',
  webyar_workspace_id uuid,
  webyar_installation_id uuid
);

CREATE TABLE IF NOT EXISTS asterisk.ps_auths (
  id varchar(255) PRIMARY KEY,
  auth_type varchar(20) NOT NULL DEFAULT 'userpass',
  username varchar(255),
  password varchar(255),
  realm varchar(255)
);

CREATE TABLE IF NOT EXISTS asterisk.ps_aors (
  id varchar(255) PRIMARY KEY,
  contact varchar(255),
  max_contacts integer NOT NULL DEFAULT 1,
  qualify_frequency integer NOT NULL DEFAULT 60,
  remove_existing varchar(5) NOT NULL DEFAULT 'yes'
);

CREATE TABLE IF NOT EXISTS asterisk.ps_registrations (
  id varchar(255) PRIMARY KEY,
  transport varchar(40),
  outbound_auth varchar(255),
  server_uri varchar(255),
  client_uri varchar(255),
  contact_user varchar(255),
  retry_interval integer NOT NULL DEFAULT 60,
  forbidden_retry_interval integer NOT NULL DEFAULT 600,
  expiration integer NOT NULL DEFAULT 300,
  line varchar(5) NOT NULL DEFAULT 'yes',
  endpoint varchar(255),
  webyar_workspace_id uuid,
  webyar_installation_id uuid
);

CREATE INDEX IF NOT EXISTS ps_endpoints_workspace_idx
  ON asterisk.ps_endpoints (webyar_workspace_id);
CREATE INDEX IF NOT EXISTS ps_registrations_workspace_idx
  ON asterisk.ps_registrations (webyar_workspace_id);

-- Least-privilege telephony role. NOLOGIN here on purpose: the operator
-- attaches a password out of band (never in Git or a migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webyar_asterisk') THEN
    CREATE ROLE webyar_asterisk NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA asterisk TO webyar_asterisk, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA asterisk TO webyar_asterisk, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA asterisk
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO webyar_asterisk, service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA asterisk FROM anon, authenticated;