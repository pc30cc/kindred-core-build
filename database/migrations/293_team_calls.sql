-- 293 — Colleague calls (team calls): the App Review plan carries
-- `team_calls` (owner, 2026-11-01; docs/operations/TEAM_CALLS.md).
--
-- Colleague calls are a plan feature the Super Admin turns on per plan
-- (registry key `team_calls`, type feature, default off). No plan gets it
-- from this file but the hidden App Review plan, which is meant to carry
-- every feature the iOS app gates on: Apple's reviewer signs in to it and
-- must be able to place a call from the team chat.
--
-- 1. app_review_seed_plan(): 272's function; only its fixed key list gains
--    'team_calls', so a reseed of the App Review account keeps it (every
--    other key any plan carries is still switched on as before).
-- 2. The App Review plan as it stands: `team_calls: true` added to its
--    entitlements, nothing else changed. No other plan is touched.
-- 3. team_call_place(): places a colleague call — the busy check and the
--    row's insert in one transaction, under a lock per member — so two
--    calls placed at the same moment that share a member never both ring
--    (A and B calling each other, or C and D calling B). The API's own busy
--    read before it (server/services/calls/teamCallPeople.ts busyMembers)
--    is only the early answer.
--
-- No table, column or type changes: a colleague call is a call_sessions row
-- with entry_source 'team_call' (free text) whose states (ringing,
-- connecting, active, ended, missed, cancelled) public.call_state already
-- has.
--
-- Applied by hand on WebYar BEFORE the merge of the code that reads the key
-- and calls the function (CLAUDE.md, Migrations): a dry run of this file
-- inside BEGIN … ROLLBACK first; by its migrator on RESPOK, on push. Needs
-- 272 (the function it replaces, and the App Review plan of 249).
-- Re-runnable: a second run replaces both functions with themselves and
-- finds the key already on. It opens no transaction of its own and touches
-- no archive schema or table. Like 284 to 292, it sets lock_timeout 5s
-- itself.

SET lock_timeout = '5s';

-- ─── 1. The App Review plan's seed: 'team_calls' in its fixed keys ───────
CREATE OR REPLACE FUNCTION public.app_review_seed_plan()
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ent  jsonb;
  v_lim  jsonb;
  v_plan uuid;
BEGIN
  -- Every key any plan carries, on, except the in-app promotions; and what
  -- the iOS app gates on, named outright.
  SELECT coalesce(jsonb_object_agg(k, NOT (k LIKE 'mobile_promo%')), '{}'::jsonb) INTO v_ent
    FROM (SELECT DISTINCT jsonb_object_keys(entitlements) AS k
            FROM public.billing_plans
           WHERE slug <> 'app-review' AND jsonb_typeof(entitlements) = 'object'
          UNION
          SELECT unnest(ARRAY['chat', 'chat_widget', 'contacts', 'visitor_tracking', 'web_analytics', 'analytics',
                              'email', 'email_inbox', 'gmail', 'yahoomail', 'whatsapp', 'telegram', 'instagram',
                              'omnichannel', 'voice', 'video', 'voice_video', 'call_center', 'call_queue',
                              'ai_assistant', 'advanced_ai_agent', 'ai_operator_assist', 'knowledge_base',
                              'inbox_ai_queue', 'inbox_needs_human', 'inbox_team_chat', 'contact_create',
                              'contact_edit', 'contact_tags', 'contact_notes', 'widget_attachments',
                              'widget_voice_notes', 'team_calls'])) keys;
  SELECT (coalesce((SELECT limits FROM public.billing_plans WHERE slug = 'enterprise'), '{}'::jsonb) - 'storage_gb')
         || jsonb_build_object(
              'max_agents', -1, 'max_contacts', -1, 'max_visitors', -1,
              'max_conversations', -1, 'max_workspaces', -1, 'max_widget_domains', -1,
              'max_concurrent_calls', -1, 'max_call_minutes_per_month', -1,
              'data_retention_days', 400, 'storage_mb', 20480)
    INTO v_lim;

  INSERT INTO public.billing_plans (name, slug, description, sort_order, prices, default_currency,
                                    entitlements, limits, provider_price_ids, is_active, is_free,
                                    is_hidden, trial_days, localized)
  VALUES ('App Review', 'app-review',
          'Hidden. The workspace Apple''s App Review signs in to: every feature, no price.',
          99, '{"IRR":{"monthly":0,"yearly":0}}'::jsonb, 'IRR',
          v_ent, v_lim, '{}'::jsonb, true, false, true, 0, '{}'::jsonb)
  ON CONFLICT (slug) DO UPDATE
     SET entitlements = EXCLUDED.entitlements, limits = EXCLUDED.limits,
         is_active = true, is_hidden = true, updated_at = now()
  RETURNING id INTO v_plan;
  RETURN v_plan;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_plan() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_plan() TO service_role;

-- ─── 2. The App Review plan as it stands: colleague calls on ─────────────
UPDATE public.billing_plans
   SET entitlements = entitlements || '{"team_calls": true}'::jsonb,
       updated_at = now()
 WHERE slug = 'app-review'
   AND jsonb_typeof(entitlements) = 'object'
   AND (entitlements -> 'team_calls') IS DISTINCT FROM 'true'::jsonb;

-- ─── 3. Placing a colleague call: busy check and insert, one at a time ───
-- Called by POST /api/team-calls (server/routes/teamCalls.ts) once the
-- members, the plan and its limits have said yes, with the call's row as the
-- API built it. Both members' locks are taken first, the lower id first, so
-- two placements that share a member run one after the other and two that
-- share both cannot deadlock; each lock is released with the transaction.
-- Under them, the rule of busyMembers' colleague-call half: a member in a
-- colleague call that is ringing with ring left (placed after p_ring_cutoff),
-- connecting or active — as its caller or its callee, in any workspace, and
-- placed after p_live_since (a row older than that is one whose end never
-- reached the server, not a call) — cannot be rung, nor ring anyone. The two
-- instants come from the API, so the busy rule and the answer's
-- compare-and-set (teamCallLifecycle.ts) read one clock.
--
-- Answers {"verdict": "placed", "call": <the new row, every column>}, or
-- {"verdict": "caller_busy"} / {"verdict": "callee_busy"} with nothing
-- written. The row comes back in the same call, so a placed call is never
-- left ringing unseen behind a read that failed.
CREATE OR REPLACE FUNCTION public.team_call_place(
  p_workspace_id uuid,
  p_caller_id    uuid,
  p_callee_id    uuid,
  p_channel      text,
  p_provider     text,
  p_metadata     jsonb,
  p_ring_cutoff  timestamptz,
  p_live_since   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller_busy boolean;
  v_callee_busy boolean;
  v_call        public.call_sessions;
BEGIN
  IF p_workspace_id IS NULL OR p_caller_id IS NULL OR p_callee_id IS NULL OR p_caller_id = p_callee_id THEN
    RAISE EXCEPTION 'team_call_place: a workspace and two different members are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('audio', 'video') THEN
    RAISE EXCEPTION 'team_call_place: channel must be audio or video' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('team_call_line:' || least(p_caller_id, p_callee_id)::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('team_call_line:' || greatest(p_caller_id, p_callee_id)::text, 0));

  SELECT coalesce(bool_or(p_caller_id::text IN (s.initiated_by::text,
                                                s.metadata #>> '{team_call,caller_user_id}',
                                                s.metadata #>> '{team_call,callee_user_id}')), false),
         coalesce(bool_or(p_callee_id::text IN (s.initiated_by::text,
                                                s.metadata #>> '{team_call,caller_user_id}',
                                                s.metadata #>> '{team_call,callee_user_id}')), false)
    INTO v_caller_busy, v_callee_busy
    FROM public.call_sessions s
   WHERE s.entry_source = 'team_call'
     AND s.state IN ('ringing', 'connecting', 'active')
     AND s.created_at > p_live_since
     AND (s.state <> 'ringing' OR s.created_at > p_ring_cutoff)
     AND (s.initiated_by IN (p_caller_id, p_callee_id)
          OR s.metadata #>> '{team_call,callee_user_id}' IN (p_caller_id::text, p_callee_id::text));

  IF v_caller_busy THEN
    RETURN jsonb_build_object('verdict', 'caller_busy');
  END IF;
  IF v_callee_busy THEN
    RETURN jsonb_build_object('verdict', 'callee_busy');
  END IF;

  INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id,
                                    entry_source, state, initiated_by, initiated_by_type,
                                    recording_enabled, recording_state, metadata)
  VALUES (p_workspace_id, p_provider, p_channel::public.call_type, 'internal', NULL,
          'team_call', 'ringing', p_caller_id, 'internal',
          false, 'disabled', coalesce(p_metadata, '{}'::jsonb))
  RETURNING * INTO v_call;

  RETURN jsonb_build_object('verdict', 'placed', 'call', to_jsonb(v_call));
END;
$$;

REVOKE ALL ON FUNCTION public.team_call_place(uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_call_place(uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz)
  TO service_role;
