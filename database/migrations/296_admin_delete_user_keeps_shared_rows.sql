-- 296 — Deleting a user keeps the rows they share with everyone else.
--
-- APPLY BY HAND ON WEBYAR BEFORE THE MERGE (CLAUDE.md, "Database" →
-- Migrations: scripts/migrate-database.sh as postgres in the database
-- container, after a dry run of this file inside BEGIN … ROLLBACK). RESPOK's
-- DB Migrator applies it on push. It writes no data: it only replaces one
-- function.
--
-- admin_delete_user (182, never redefined since) purges the user's own
-- workspaces, then ran `DELETE FROM public.<t> WHERE <col> = <user>` on every
-- public table with a uuid column named user_id, created_by, updated_by,
-- assigned_to, operator_id, author_id, actor_id, invited_by, reviewed_by, …
-- in every tenant. Deleting an operator of someone else's workspace thus
-- deleted that workspace's conversations assigned to them (and their
-- messages), the canned replies and smart rules they wrote or last edited,
-- their notes, ratings and events, the invitations they sent and the member
-- details of whoever they invited; deleting a former Super Admin deleted
-- every platform singleton they last saved (widget_platform_settings, which
-- turns the inactivity close off; billing_settings; widget_edition_settings;
-- platform_sms_provider_config; platform_support_settings; the SEO provider
-- configs). 026 makes conversations.assigned_to ON DELETE SET NULL and 278b
-- keeps a closed conversation's assignee to record who handled it: the
-- schema meant the reference to go, not the row.
--
-- Now:
--   1. The guards are unchanged (admin actor, not oneself, the user exists,
--      not the last platform admin), and so is the purge of the workspaces
--      the user owns (admin_purge_workspaces, 263).
--   2. Rows that are the user's own are deleted, from an explicit list keyed
--      by the user (credentials, sessions and tokens, roles, phone
--      verifications, notification and availability prefs, push devices and
--      their log, their membership of other workspaces and everything that
--      hangs on it, their own reactions, their invitation consents, their
--      billing account when no workspace still names it, their write
--      leases), then the profile, whose ON DELETE CASCADE foreign keys take
--      the rest (audit_logs, canned_responses, platform_support_threads,
--      notification_email_jobs, …) and whose SET NULL ones clear theirs.
--   3. Every other reference to the user, in a nullable uuid column of one
--      of those names, is set to NULL: the row stays. Append-only financial
--      records (the balance ledger, gateway payments, the AI billing audit
--      log and adjustments, the published AI prices) keep the id as their
--      record of who acted, as 263 already did on a purge.
--   4. A NOT NULL reference without a foreign key (conversation_notes.
--      author_id, workspace_invitations.created_by, privacy_jobs, the
--      deletion jobs, admin_gate_bypass_log, billing_lock_exports) is left
--      as it is, pointing at nobody: the row is never deleted for it.
--   5. Nothing is retried in a loop that swallows errors: a statement that
--      fails fails the call, and the deletion job retries.
--
-- The user's own deletion job (user_deletion_jobs) is no longer deleted with
-- them: the worker marks it completed with this function's result.
--
-- Server-only: SECURITY DEFINER, search_path pinned, service_role only, as
-- 182 and 217 left it. Re-runnable: CREATE OR REPLACE and grants.

CREATE OR REPLACE FUNCTION public.admin_delete_user(_actor_user_id uuid, _user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _ws uuid[];
  _rec record;
  _n bigint;
  _stmts int := 0;
  _deleted bigint := 0;
  _cleared bigint := 0;
  _admin_count int;
  _kept_accounts int := 0;
  -- The user's own rows: (table, column naming the user).
  _own CONSTANT text[][] := ARRAY[
    ['workspace_invitation_consents', 'user_id'],   -- FK to profiles is RESTRICT
    ['workspace_member_details',      'user_id'],   -- FK to workspace_members is RESTRICT
    ['workspace_department_members',  'user_id'],
    ['chat_routing_members',          'user_id'],
    ['call_center_agent_presence',    'user_id'],
    ['call_center_department_agents', 'user_id'],
    ['operator_call_availability',    'user_id'],
    ['operator_presence_live',        'user_id'],
    ['workspace_alert_dismissals',    'user_id'],
    ['workspace_members',             'user_id'],   -- hidden pairs (295) go with it
    ['account_members',               'user_id'],
    ['user_roles',                    'user_id'],
    ['user_credentials',              'user_id'],
    ['auth_sessions',                 'user_id'],
    ['auth_reset_tokens',             'user_id'],
    ['auth_verify_tokens',            'user_id'],
    ['user_continuity_tokens',        'user_id'],
    ['user_phone_verifications',      'user_id'],
    ['phone_verification_challenges', 'user_id'],
    ['user_notification_prefs',       'user_id'],
    ['user_email_notification_prefs', 'user_id'],
    ['user_availability_prefs',       'user_id'],
    ['notification_email_jobs',       'user_id'],
    ['mobile_push_devices',           'user_id'],
    ['push_dispatch_log',             'user_id'],
    ['admin_impersonation_tokens',    'target_user_id'],
    ['admin_impersonation_tokens',    'created_by']
  ];
  -- Append-only records that keep the actor's id as it is.
  _keep CONSTANT text[] := ARRAY[
    'billing_account_ledger', 'billing_account_payments',
    'ai_billing_audit_log', 'ai_billing_adjustments',
    'ai_rate_cards', 'ai_sell_policies', 'ai_exchange_rates',
    'billing_revenue_archive', 'billing_ledger_archive'
  ];
  i int;
BEGIN
  PERFORM set_config('app.billing_purge', 'on', true);
  IF NOT has_role(_actor_user_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _actor_user_id = _user_id THEN
    RAISE EXCEPTION 'Cannot delete your own account';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = _user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = 'admin') THEN
    SELECT count(*) INTO _admin_count FROM user_roles WHERE role = 'admin';
    IF _admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot delete the last platform admin';
    END IF;
  END IF;

  -- 1. The workspaces the user owns, whole.
  SELECT coalesce(array_agg(id), '{}') INTO _ws FROM workspaces WHERE owner_id = _user_id;
  IF array_length(_ws, 1) > 0 THEN
    _stmts := _stmts + admin_purge_workspaces(_ws);
  END IF;

  -- 2. The user's own rows.
  -- Their reactions as an operator (a CHECK keeps actor_id set for those).
  IF to_regclass('public.conversation_message_reactions') IS NOT NULL THEN
    DELETE FROM conversation_message_reactions WHERE actor_type = 'operator' AND actor_id = _user_id;
    GET DIAGNOSTICS _n = ROW_COUNT;
    _deleted := _deleted + _n; _stmts := _stmts + 1;
  END IF;

  FOR i IN 1 .. array_length(_own, 1) LOOP
    CONTINUE WHEN to_regclass('public.' || _own[i][1]) IS NULL;
    EXECUTE format('DELETE FROM public.%I WHERE %I = $1', _own[i][1], _own[i][2]) USING _user_id;
    GET DIAGNOSTICS _n = ROW_COUNT;
    _deleted := _deleted + _n; _stmts := _stmts + 1;
  END LOOP;

  -- Their write leases (a workspace's leases name the workspace, not a user).
  DELETE FROM owner_write_leases WHERE owner_kind = 'user' AND owner_id = _user_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  _deleted := _deleted + _n; _stmts := _stmts + 1;

  -- Their billing account, unless a workspace that survives still names it
  -- (workspaces.account_id is ON DELETE CASCADE: deleting it would delete
  -- that workspace unpurged). One that stays keeps owner_id as it is.
  IF to_regclass('public.accounts') IS NOT NULL THEN
    DELETE FROM accounts a WHERE a.owner_id = _user_id
       AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.account_id = a.id);
    GET DIAGNOSTICS _n = ROW_COUNT;
    _deleted := _deleted + _n; _stmts := _stmts + 1;
    SELECT count(*) INTO _kept_accounts FROM accounts WHERE owner_id = _user_id;
  END IF;

  -- 3. Every other reference: cleared, the row kept.
  FOR _rec IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.data_type = 'uuid'
      AND c.is_nullable = 'YES'
      AND c.table_name <> 'profiles'
      AND c.table_name <> ALL (_keep)
      AND c.column_name IN (
        'user_id','owner_id','actor_user_id','created_by','updated_by','assigned_to',
        'assigned_user_id','operator_id','agent_id','invited_by','requested_by',
        'uploaded_by','resolved_by','reviewed_by','sender_user_id','actor_id',
        'deleted_by','author_id','member_user_id','target_user_id','admin_user_id'
      )
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('UPDATE public.%I SET %I = NULL WHERE %I = $1',
                   _rec.table_name, _rec.column_name, _rec.column_name) USING _user_id;
    GET DIAGNOSTICS _n = ROW_COUNT;
    _cleared := _cleared + _n; _stmts := _stmts + 1;
  END LOOP;

  -- 4. The profile; its foreign keys cascade or clear the rest.
  DELETE FROM profiles WHERE id = _user_id;
  _stmts := _stmts + 1;

  RETURN jsonb_build_object(
    'deleted_user_id', _user_id,
    'workspaces_deleted', coalesce(array_length(_ws, 1), 0),
    'statements_executed', _stmts,
    'rows_deleted', _deleted,
    'references_cleared', _cleared,
    'accounts_kept', _kept_accounts
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_delete_user(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, uuid) TO service_role;

DO $verify$
BEGIN
  IF to_regprocedure('public.admin_delete_user(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '296: admin_delete_user missing';
  END IF;
  IF has_function_privilege('anon', 'public.admin_delete_user(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_delete_user(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admin_delete_user(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '296: admin_delete_user is not service_role-only';
  END IF;
  IF pg_get_functiondef('public.admin_delete_user(uuid, uuid)'::regprocedure) ~* 'DELETE FROM public\.%I WHERE %I = %L' THEN
    RAISE EXCEPTION '296: admin_delete_user still deletes by every user column';
  END IF;
END;
$verify$;
