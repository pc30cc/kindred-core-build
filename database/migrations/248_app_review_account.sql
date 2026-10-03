-- ============================================================
-- THE ACCOUNT APPLE'S APP REVIEW SIGNS IN WITH
--
-- Hosted twin: supabase/migrations/20261003120000_app_review_account.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- App Review signs in to the iOS app with a demo account and expects every
-- screen to have something on it. Everything here is in English.
--
--   • app_review_seed(password_hash)
--       Creates, or brings back, the account apple@webyar.ai and the
--       workspace it works in ("Webyar Demo", slug ws_appreview), then
--       replaces that workspace's content with a fresh English set dated
--       around now: conversations in every queue (open, needs a human, AI,
--       pending, resolved, spam; website, WhatsApp, Telegram and email),
--       contacts, visitors, six months of website analytics, colleagues
--       and their messages, saved replies and departments.
--       The reviewer is an ADMIN, not the owner: an owner cannot delete
--       their account, and App Review deletes it. The owner and the second
--       colleague are profiles that cannot sign in.
--       The workspace is on the hidden plan "app-review": every feature,
--       no price, until 2099.
--       The password is only set when a hash is passed (argon2id, from the
--       server's hashPassword); a new account needs one.
--   • app_review_status()          what Super Admin shows.
--   • app_review_set_enabled(bool) blocks or unblocks the sign-in, through
--                                  admin_set_user_block_status (blocking
--                                  also revokes its sessions).
--   • app_review_keep_visitors_live()
--       Keeps the demo's visitors on the Visitors tab: a seeded visitor
--       has no browser behind it, so its presence would go stale within
--       minutes. The server calls this every minute; it does nothing while
--       the account is blocked or missing.
--
-- Nothing is sent anywhere: no channel integration is attached, so agent
-- messages stay in the database, and the seed writes no push or event.
-- Service role only.
-- ============================================================

-- What Super Admin shows beside the switch: when the content was last made.
ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS app_review_seeded_at timestamptz;

CREATE OR REPLACE FUNCTION public.app_review_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user   public.profiles%ROWTYPE;
  v_status text;
  v_ws     public.workspaces%ROWTYPE;
  v_at     timestamptz;
BEGIN
  SELECT * INTO v_user FROM public.profiles WHERE email = 'apple@webyar.ai';
  IF v_user.id IS NOT NULL THEN
    SELECT status INTO v_status FROM public.user_credentials WHERE user_id = v_user.id;
  END IF;
  SELECT * INTO v_ws FROM public.workspaces WHERE slug = 'ws_appreview';
  SELECT app_review_seeded_at INTO v_at FROM public.mobile_app_settings LIMIT 1;

  RETURN jsonb_build_object(
    'email', 'apple@webyar.ai',
    'exists', v_user.id IS NOT NULL,
    'user_id', v_user.id,
    'full_name', v_user.full_name,
    'enabled', v_user.id IS NOT NULL AND coalesce(v_status, 'active') = 'active',
    'workspace_id', v_ws.id,
    'workspace_name', v_ws.name,
    'seeded_at', v_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.app_review_set_enabled(_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE email = 'apple@webyar.ai';
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'app_review_account_missing';
  END IF;
  PERFORM public.admin_set_user_block_status(v_user, NOT _enabled);
  RETURN public.app_review_status();
END;
$$;

CREATE OR REPLACE FUNCTION public.app_review_keep_visitors_live()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ws    uuid;
  v_count integer := 0;
BEGIN
  SELECT w.id INTO v_ws
    FROM public.workspaces w
    JOIN public.workspace_members m ON m.workspace_id = w.id
    JOIN public.profiles p ON p.id = m.user_id AND p.email = 'apple@webyar.ai'
    LEFT JOIN public.user_credentials c ON c.user_id = p.id
   WHERE w.slug = 'ws_appreview'
     AND coalesce(c.status, 'active') = 'active';
  IF v_ws IS NULL THEN
    RETURN 0;
  END IF;

  -- A minute old, not fresher: a realtime-presence platform reads a
  -- younger row as a hand-off in progress and shows nothing yet. 'idle'
  -- is what both presence modes keep showing for a visitor with no live
  -- connection; 'online' would read as offline under realtime presence.
  UPDATE public.visitor_sessions s
     SET last_seen_at = now() - interval '60 seconds',
         started_at = now() - make_interval(mins => coalesce((s.metadata->>'app_review_minutes')::int, 5))
   WHERE s.workspace_id = v_ws
     AND s.metadata->>'app_review_live' = 'true';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.visitor_presence p
     SET status = 'idle', updated_at = now() - interval '60 seconds'
    FROM public.visitor_sessions s
   WHERE p.visitor_session_id = s.id
     AND s.workspace_id = v_ws
     AND s.metadata->>'app_review_live' = 'true';

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_review_seed(_password_hash text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_email       constant text := 'apple@webyar.ai';
  c_owner_email constant text := 'emma.wilson@demo.webyar.ai';
  c_mate_email  constant text := 'daniel.carter@demo.webyar.ai';
  c_slug        constant text := 'ws_appreview';
  v_now   timestamptz := now();
  v_ent   jsonb;
  v_lim   jsonb;
  v_plan  uuid;
  v_owner uuid;
  v_mate  uuid;
  v_me    uuid;
  v_acct  uuid;
  v_ws    uuid;
  v_sub_plan uuid;
  v_sub_end  timestamptz;
  v_period   uuid;
  v_sales uuid;
  v_support uuid;
  -- contacts
  k_olivia uuid; k_liam uuid; k_sophia uuid; k_noah uuid; k_ava uuid; k_ethan uuid;
  k_mia uuid; k_lucas uuid; k_charlotte uuid; k_anon uuid; k_spam uuid; k_ben uuid; k_grace uuid;
  -- visitor sessions behind the conversations
  s_olivia uuid; s_liam uuid; s_sophia uuid; s_noah uuid; s_anon uuid; s_grace uuid; s_ethan uuid;
  -- conversations
  c_olivia uuid; c_liam uuid; c_sophia uuid; c_grace uuid; c_noah uuid; c_ava uuid; c_ethan uuid;
  c_mia uuid; c_lucas uuid; c_charlotte uuid; c_anon uuid; c_spam uuid; c_ben uuid;
BEGIN
  -- ── The plan: every feature the platform knows, no price ─────────────────
  -- Every key any plan carries, on — except the in-app promotions, which an
  -- App Review session should never meet.
  -- What the iOS app gates on is named outright, so a platform whose plans
  -- never mention one of them still turns it on.
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
                              'widget_voice_notes'])) keys;
  SELECT coalesce((SELECT limits FROM public.billing_plans WHERE slug = 'enterprise'), '{}'::jsonb)
         || jsonb_build_object(
              'max_agents', -1, 'max_contacts', -1, 'max_visitors', -1,
              'max_conversations', -1, 'max_workspaces', -1, 'max_widget_domains', -1,
              'max_concurrent_calls', -1, 'max_call_minutes_per_month', -1,
              'data_retention_days', 400, 'storage_gb', 20)
    INTO v_lim;

  INSERT INTO public.billing_plans (name, slug, description, sort_order, prices, default_currency,
                                    entitlements, limits, provider_price_ids, is_active, is_free,
                                    is_hidden, trial_days, localized)
  VALUES ('App Review', 'app-review',
          'Hidden. The workspace Apple''s App Review signs in to: every feature, no price.',
          99, '{"IRR":{"monthly":0,"yearly":0}}'::jsonb, 'IRR',
          v_ent, v_lim, '{}'::jsonb, true, false, true, 0, '{}'::jsonb)
  ON CONFLICT (slug) DO UPDATE
     SET entitlements = EXCLUDED.entitlements,
         limits = EXCLUDED.limits,
         is_active = true,
         is_hidden = true,
         updated_at = now()
  RETURNING id INTO v_plan;

  -- ── People ───────────────────────────────────────────────────────────────
  -- The owner and a colleague: real names on screen, no way to sign in.
  SELECT id INTO v_owner FROM public.profiles WHERE email = c_owner_email;
  IF v_owner IS NULL THEN
    INSERT INTO public.profiles (id, email, full_name, preferred_locale, signup_locale)
    VALUES (gen_random_uuid(), c_owner_email, 'Emma Wilson', 'en', 'en')
    RETURNING id INTO v_owner;
  END IF;
  INSERT INTO public.user_credentials (user_id, status) VALUES (v_owner, 'disabled')
  ON CONFLICT (user_id) DO UPDATE SET status = 'disabled', updated_at = now();

  SELECT id INTO v_mate FROM public.profiles WHERE email = c_mate_email;
  IF v_mate IS NULL THEN
    INSERT INTO public.profiles (id, email, full_name, preferred_locale, signup_locale)
    VALUES (gen_random_uuid(), c_mate_email, 'Daniel Carter', 'en', 'en')
    RETURNING id INTO v_mate;
  END IF;
  INSERT INTO public.user_credentials (user_id, status) VALUES (v_mate, 'disabled')
  ON CONFLICT (user_id) DO UPDATE SET status = 'disabled', updated_at = now();

  -- The reviewer. Brought back when App Review deleted it last time.
  SELECT id INTO v_me FROM public.profiles WHERE email = c_email;
  IF v_me IS NULL THEN
    IF _password_hash IS NULL THEN
      RAISE EXCEPTION 'app_review_password_required';
    END IF;
    INSERT INTO public.profiles (id, email, full_name, preferred_locale, signup_locale)
    VALUES (gen_random_uuid(), c_email, 'Alex Morgan', 'en', 'en')
    RETURNING id INTO v_me;
    INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at,
                                         email_verified_at, status)
    VALUES (v_me, _password_hash, 'argon2id', v_now, v_now, 'active')
    ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, password_algo = 'argon2id',
           password_set_at = EXCLUDED.password_set_at, email_verified_at = EXCLUDED.email_verified_at,
           status = 'active', failed_login_count = 0, updated_at = now();
  ELSE
    UPDATE public.profiles SET full_name = 'Alex Morgan', preferred_locale = 'en' WHERE id = v_me;
    -- Whether it may sign in is the switch's to say, never the seed's.
    INSERT INTO public.user_credentials (user_id, email_verified_at, status)
    VALUES (v_me, v_now, 'active')
    ON CONFLICT (user_id) DO UPDATE
       SET email_verified_at = coalesce(public.user_credentials.email_verified_at, v_now),
           failed_login_count = 0, updated_at = now();
    IF _password_hash IS NOT NULL THEN
      UPDATE public.user_credentials
         SET password_hash = _password_hash, password_algo = 'argon2id',
             password_set_at = v_now, updated_at = now()
       WHERE user_id = v_me;
    END IF;
  END IF;

  -- ── The workspace, owned by Emma ─────────────────────────────────────────
  SELECT id INTO v_ws FROM public.workspaces WHERE slug = c_slug;
  IF v_ws IS NULL THEN
    SELECT a.id INTO v_acct FROM public.accounts a WHERE a.owner_id = v_owner ORDER BY a.created_at LIMIT 1;
    IF v_acct IS NULL THEN
      INSERT INTO public.accounts (name, slug, owner_id)
      VALUES ('Webyar Demo', 'acc_appreview', v_owner)
      RETURNING id INTO v_acct;
    END IF;
    INSERT INTO public.account_members (account_id, user_id, role)
    VALUES (v_acct, v_owner, 'owner')
    ON CONFLICT (account_id, user_id) DO NOTHING;
    v_ws := public.create_workspace_atomic(v_acct, 'Webyar Demo', c_slug, v_owner);
  END IF;
  UPDATE public.workspaces
     SET name = 'Webyar Demo', default_locale = 'en', panel_locale = 'en', widget_locale = 'en'
   WHERE id = v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_me, 'admin'), (v_ws, v_mate, 'agent')
  ON CONFLICT (workspace_id, user_id) DO UPDATE
     SET role = EXCLUDED.role, suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL;

  -- ── The plan, granted as Super Admin would, until 2099 ───────────────────
  SELECT plan_id, current_period_end INTO v_sub_plan, v_sub_end
    FROM public.workspace_subscriptions WHERE workspace_id = v_ws;
  IF v_sub_plan IS DISTINCT FROM v_plan OR v_sub_end IS NULL OR v_sub_end < v_now + interval '1 year' THEN
    -- A new workspace has no subscription row yet, and the period's
    -- allowance cycles hang off it. Activation fills the row in.
    INSERT INTO public.workspace_subscriptions (workspace_id, provider_name, status, billing_engine_version)
    VALUES (v_ws, 'manual', 'active', 'v2')
    ON CONFLICT (workspace_id) DO NOTHING;
    INSERT INTO public.billing_subscription_periods (workspace_id, subscription_id, plan_id, invoice_id,
                                                     billing_interval, period_start, period_end, status,
                                                     source, plan_snapshot, limits_snapshot, ai_allowance_irr)
    SELECT v_ws, (SELECT id FROM public.workspace_subscriptions WHERE workspace_id = v_ws),
           p.id, NULL, 'yearly', v_now, timestamptz '2099-12-31 00:00:00+00', 'scheduled',
           'admin', to_jsonb(p), p.limits, 0
      FROM public.billing_plans p WHERE p.id = v_plan
    RETURNING id INTO v_period;
    PERFORM public.billing_activate_period(v_period);
  END IF;

  -- ── A clean slate ────────────────────────────────────────────────────────
  -- Whatever the last review left (its replies, its notes) goes too.
  DELETE FROM public.team_messages WHERE workspace_id = v_ws;
  DELETE FROM public.conversation_notes WHERE workspace_id = v_ws;
  DELETE FROM public.conversations WHERE workspace_id = v_ws;
  DELETE FROM public.web_analytics_events WHERE workspace_id = v_ws;
  DELETE FROM public.visitor_page_views WHERE workspace_id = v_ws;
  DELETE FROM public.visitor_presence WHERE workspace_id = v_ws;
  DELETE FROM public.visitor_sessions WHERE workspace_id = v_ws;
  DELETE FROM public.contacts WHERE workspace_id = v_ws;
  DELETE FROM public.canned_responses WHERE workspace_id = v_ws;
  DELETE FROM public.workspace_department_members WHERE workspace_id = v_ws;
  DELETE FROM public.workspace_departments WHERE workspace_id = v_ws;

  -- ── Departments ──────────────────────────────────────────────────────────
  INSERT INTO public.workspace_departments (workspace_id, name, enabled, chat_enabled, audio_enabled, video_enabled, sort_order)
  VALUES (v_ws, 'Sales', true, true, true, true, 1) RETURNING id INTO v_sales;
  INSERT INTO public.workspace_departments (workspace_id, name, enabled, chat_enabled, audio_enabled, video_enabled, sort_order)
  VALUES (v_ws, 'Support', true, true, true, true, 2) RETURNING id INTO v_support;
  INSERT INTO public.workspace_department_members (department_id, workspace_id, user_id)
  VALUES (v_sales, v_ws, v_me), (v_support, v_ws, v_me), (v_sales, v_ws, v_owner), (v_support, v_ws, v_mate);

  -- ── Contacts ─────────────────────────────────────────────────────────────
  INSERT INTO public.contacts (workspace_id, name, email, phone, metadata, created_at)
  VALUES (v_ws, 'Olivia Bennett', 'olivia.bennett@example.com', '+1 415 555 0142', '{"app_review_seed":true}', v_now - interval '40 days')
  RETURNING id INTO k_olivia;
  INSERT INTO public.contacts (workspace_id, name, email, phone, metadata, created_at)
  VALUES (v_ws, 'Liam Foster', 'liam.foster@example.co.uk', '+44 20 7946 0321', '{"app_review_seed":true}', v_now - interval '12 days')
  RETURNING id INTO k_liam;
  INSERT INTO public.contacts (workspace_id, name, email, metadata, created_at)
  VALUES (v_ws, 'Sophia Martinez', 'sophia.martinez@example.com', '{"app_review_seed":true}', v_now - interval '3 days')
  RETURNING id INTO k_sophia;
  INSERT INTO public.contacts (workspace_id, name, email, phone, metadata, created_at)
  VALUES (v_ws, 'Noah Schmidt', 'noah.schmidt@example.de', '+49 30 901820', '{"app_review_seed":true}', v_now - interval '65 days')
  RETURNING id INTO k_noah;
  INSERT INTO public.contacts (workspace_id, name, email, metadata, created_at)
  VALUES (v_ws, 'Ava Thompson', 'ava.thompson@example.com.au', '{"app_review_seed":true}', v_now - interval '20 days')
  RETURNING id INTO k_ava;
  INSERT INTO public.contacts (workspace_id, name, email, phone, metadata, created_at)
  VALUES (v_ws, 'Ethan Brooks', 'ethan.brooks@example.ca', '+1 416 555 0198', '{"app_review_seed":true}', v_now - interval '90 days')
  RETURNING id INTO k_ethan;
  INSERT INTO public.contacts (workspace_id, name, phone, metadata, created_at)
  VALUES (v_ws, 'Mia Johnson', '+1 646 555 0187', '{"app_review_seed":true}', v_now - interval '8 days')
  RETURNING id INTO k_mia;
  INSERT INTO public.contacts (workspace_id, name, metadata, created_at)
  VALUES (v_ws, 'Lucas Meyer', '{"app_review_seed":true}', v_now - interval '5 days')
  RETURNING id INTO k_lucas;
  INSERT INTO public.contacts (workspace_id, name, email, metadata, created_at)
  VALUES (v_ws, 'Charlotte Davies', 'charlotte.davies@example.co.uk', '{"app_review_seed":true}', v_now - interval '30 days')
  RETURNING id INTO k_charlotte;
  INSERT INTO public.contacts (workspace_id, visitor_code, metadata, created_at)
  VALUES (v_ws, '8F2C', '{"app_review_seed":true}', v_now - interval '15 minutes')
  RETURNING id INTO k_anon;
  INSERT INTO public.contacts (workspace_id, name, email, metadata, created_at)
  VALUES (v_ws, 'Quick Profits', 'promo@quick-profits.example', '{"app_review_seed":true}', v_now - interval '2 days')
  RETURNING id INTO k_spam;
  INSERT INTO public.contacts (workspace_id, name, email, metadata, created_at)
  VALUES (v_ws, 'Benjamin Clark', 'ben.clark@example.com', '{"app_review_seed":true}', v_now - interval '120 days')
  RETURNING id INTO k_ben;
  INSERT INTO public.contacts (workspace_id, name, email, metadata, created_at)
  VALUES (v_ws, 'Grace Lee', 'grace.lee@example.com', '{"app_review_seed":true}', v_now - interval '1 day')
  RETURNING id INTO k_grace;

  -- ── Visitors with a conversation, and the ones browsing right now ────────
  -- 'app_review_live' sessions are kept on the Visitors tab by
  -- app_review_keep_visitors_live(); 'app_review_minutes' is how long they
  -- have been on the site.
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-olivia', '/checkout', 'https://www.google.com/', 'Safari', 'mobile', 'iOS',
          'United States', 'San Francisco', v_now - interval '25 minutes', v_now - interval '60 seconds', k_olivia,
          'identified', '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":25}', 'en-US',
          'US', 'United States', 'California', 'San Francisco', 37.7749, -122.4194,
          'America/Los_Angeles', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_olivia;
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-anon-8f2c', '/pricing', 'https://www.linkedin.com/', 'Chrome', 'desktop', 'Windows',
          'United Kingdom', 'London', v_now - interval '15 minutes', v_now - interval '60 seconds', k_anon,
          'anonymous', '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":15}', 'en-GB',
          'GB', 'United Kingdom', 'England', 'London', 51.5074, -0.1278,
          'Europe/London', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_anon;
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-sophia', '/shipping', '', 'Chrome', 'mobile', 'Android',
          'United States', 'Austin', v_now - interval '9 minutes', v_now - interval '60 seconds', k_sophia,
          'identified', '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":9}', 'en-US',
          'US', 'United States', 'Texas', 'Austin', 30.2672, -97.7431,
          'America/Chicago', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_sophia;
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-grace', '/features/ai-agent', 'https://www.bing.com/', 'Edge', 'desktop', 'Windows',
          'Canada', 'Vancouver', v_now - interval '6 minutes', v_now - interval '60 seconds', k_grace,
          'identified', '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":6}', 'en-CA',
          'CA', 'Canada', 'British Columbia', 'Vancouver', 49.2827, -123.1207,
          'America/Vancouver', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_grace;
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES
    (v_ws, 'demo-live-berlin', '/blog/live-chat-best-practices', 'https://www.google.de/', 'Firefox', 'desktop', 'macOS',
     'Germany', 'Berlin', v_now - interval '4 minutes', v_now - interval '60 seconds', 'anonymous',
     '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":4}', 'de-DE',
     'DE', 'Germany', 'Berlin', 'Berlin', 52.5200, 13.4050, 'Europe/Berlin', 'city', 'maxmind_local', v_now),
    (v_ws, 'demo-live-sydney', '/', 'https://twitter.com/', 'Safari', 'mobile', 'iOS',
     'Australia', 'Sydney', v_now - interval '2 minutes', v_now - interval '60 seconds', 'anonymous',
     '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":2}', 'en-AU',
     'AU', 'Australia', 'New South Wales', 'Sydney', -33.8688, 151.2093, 'Australia/Sydney', 'city', 'maxmind_local', v_now),
    (v_ws, 'demo-live-toronto', '/integrations', 'https://www.producthunt.com/', 'Chrome', 'tablet', 'iPadOS',
     'Canada', 'Toronto', v_now - interval '11 minutes', v_now - interval '60 seconds', 'anonymous',
     '{"app_review_seed":true,"app_review_live":true,"app_review_minutes":11}', 'en-CA',
     'CA', 'Canada', 'Ontario', 'Toronto', 43.6532, -79.3832, 'America/Toronto', 'city', 'maxmind_local', v_now);

  -- Past visits behind older conversations: not live.
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-liam', '/pricing', 'https://www.google.co.uk/', 'Chrome', 'desktop', 'macOS',
          'United Kingdom', 'Manchester', v_now - interval '3 hours', v_now - interval '2 hours 40 minutes', k_liam,
          'identified', '{"app_review_seed":true}', 'en-GB',
          'GB', 'United Kingdom', 'England', 'Manchester', 53.4808, -2.2426, 'Europe/London', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_liam;
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-noah', '/account/billing', '', 'Chrome', 'desktop', 'Windows',
          'Germany', 'Munich', v_now - interval '50 minutes', v_now - interval '35 minutes', k_noah,
          'identified', '{"app_review_seed":true}', 'de-DE',
          'DE', 'Germany', 'Bavaria', 'Munich', 48.1351, 11.5820, 'Europe/Berlin', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_noah;
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
  VALUES (v_ws, 'demo-ethan', '/contact', 'https://duckduckgo.com/', 'Safari', 'desktop', 'macOS',
          'Canada', 'Toronto', v_now - interval '1 day 2 hours', v_now - interval '1 day 1 hour', k_ethan,
          'identified', '{"app_review_seed":true}', 'en-CA',
          'CA', 'Canada', 'Ontario', 'Toronto', 43.6532, -79.3832, 'America/Toronto', 'city', 'maxmind_local', v_now)
  RETURNING id INTO s_ethan;

  INSERT INTO public.visitor_presence (workspace_id, visitor_session_id, status, current_page, updated_at)
  SELECT v_ws, s.id, 'idle', s.current_page, v_now - interval '60 seconds'
    FROM public.visitor_sessions s
   WHERE s.workspace_id = v_ws AND s.metadata->>'app_review_live' = 'true';

  -- Where the live and conversation visitors have been.
  INSERT INTO public.visitor_page_views (workspace_id, visitor_session_id, url, title, viewed_at)
  VALUES
    (v_ws, s_olivia, '/', 'Northwind Outfitters — Outdoor gear', v_now - interval '25 minutes'),
    (v_ws, s_olivia, '/products/trail-backpack-45l', 'Trail Backpack 45L', v_now - interval '21 minutes'),
    (v_ws, s_olivia, '/account/orders', 'Your orders', v_now - interval '12 minutes'),
    (v_ws, s_olivia, '/checkout', 'Checkout', v_now - interval '3 minutes'),
    (v_ws, s_anon, '/', 'Northwind Outfitters — Outdoor gear', v_now - interval '15 minutes'),
    (v_ws, s_anon, '/pricing', 'Pricing', v_now - interval '9 minutes'),
    (v_ws, s_sophia, '/shipping', 'Shipping & delivery', v_now - interval '9 minutes'),
    (v_ws, s_grace, '/features/ai-agent', 'AI agent', v_now - interval '6 minutes'),
    (v_ws, s_liam, '/pricing', 'Pricing', v_now - interval '3 hours'),
    (v_ws, s_noah, '/account/billing', 'Billing', v_now - interval '50 minutes'),
    (v_ws, s_ethan, '/contact', 'Contact us', v_now - interval '1 day 2 hours');
  INSERT INTO public.visitor_page_views (workspace_id, visitor_session_id, url, title, viewed_at)
  SELECT v_ws, s.id, s.current_page, initcap(replace(split_part(s.current_page, '/', -1), '-', ' ')), s.started_at
    FROM public.visitor_sessions s
   WHERE s.workspace_id = v_ws AND s.visitor_id LIKE 'demo-live-%';

  -- ── Conversations ────────────────────────────────────────────────────────
  -- Every thread is unassigned or Alex's: the inbox lists only those.

  -- 1. Open, high priority, two unread: a delayed order.
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority, tags, metadata, created_at, updated_at)
  VALUES (v_ws, k_olivia, s_olivia, 'Order #NW-48213 is late', 'open', 'high', ARRAY['order','shipping'],
          '{"app_review_seed":true}', v_now - interval '24 minutes', v_now - interval '2 minutes')
  RETURNING id INTO c_olivia;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_olivia, 'contact', NULL, 'Hi! I ordered the Trail Backpack 45L last week and the tracking hasn''t moved since Monday.', '{}', v_now - interval '24 minutes', v_now - interval '24 minutes', v_now - interval '23 minutes'),
    (c_olivia, 'system', NULL, 'Emma Wilson joined the conversation', '{"kind":"routing_agent_joined","agent_name":"Emma Wilson"}', v_now - interval '22 minutes', v_now - interval '22 minutes', NULL),
    (c_olivia, 'contact', NULL, 'The order number is NW-48213. I need it before my trip on Saturday.', '{}', v_now - interval '6 minutes', v_now - interval '6 minutes', NULL),
    (c_olivia, 'contact', NULL, 'Is there any way to upgrade the shipping?', '{}', v_now - interval '2 minutes', v_now - interval '2 minutes', NULL);

  -- 2. Alex's, answered, with an internal note.
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority, tags, assigned_to, metadata, created_at, updated_at)
  VALUES (v_ws, k_liam, s_liam, 'Team plan for 12 agents', 'open', 'normal', ARRAY['sales','pricing'], v_me,
          '{"app_review_seed":true}', v_now - interval '3 hours', v_now - interval '2 hours 35 minutes')
  RETURNING id INTO c_liam;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_liam, 'contact', NULL, 'Hello, we have 12 support agents. Do you offer a discount for annual billing?', '{}', v_now - interval '3 hours', v_now - interval '3 hours', v_now - interval '2 hours 58 minutes'),
    (c_liam, 'agent', v_me, 'Hi Liam, thanks for reaching out! Yes, annual billing saves 20%, and teams over 10 agents get onboarding included.', '{}', v_now - interval '2 hours 55 minutes', v_now - interval '2 hours 55 minutes', NULL),
    (c_liam, 'contact', NULL, 'Great. Could you send me a quote for 12 seats so I can share it with finance?', '{}', v_now - interval '2 hours 40 minutes', v_now - interval '2 hours 40 minutes', v_now - interval '2 hours 39 minutes'),
    (c_liam, 'agent', v_me, 'Of course. I''ll email the quote to liam.foster@example.co.uk within the hour.', '{}', v_now - interval '2 hours 35 minutes', v_now - interval '2 hours 35 minutes', NULL);
  INSERT INTO public.conversation_notes (workspace_id, conversation_id, author_id, body, created_at, updated_at)
  VALUES (v_ws, c_liam, v_owner, 'Liam is evaluating us against two other tools. Offer the onboarding call if he asks about migration.', v_now - interval '2 hours 50 minutes', v_now - interval '2 hours 50 minutes');

  -- 3 and 4. The AI is answering these.
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority, tags, metadata, created_at, updated_at)
  VALUES (v_ws, k_sophia, s_sophia, 'Delivery time to Texas', 'open', 'normal', ARRAY['shipping'],
          '{"app_review_seed":true,"ai_state":"ai_managed"}', v_now - interval '9 minutes', v_now - interval '7 minutes')
  RETURNING id INTO c_sophia;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_sophia, 'contact', NULL, 'How long does standard shipping take to Austin, Texas?', '{}', v_now - interval '9 minutes', v_now - interval '9 minutes', v_now - interval '9 minutes'),
    (c_sophia, 'ai', NULL, 'Standard shipping to Texas usually takes 3–5 business days. Orders placed before 2 pm ship the same day.', '{}', v_now - interval '9 minutes', v_now - interval '9 minutes', NULL),
    (c_sophia, 'contact', NULL, 'And is express available?', '{}', v_now - interval '8 minutes', v_now - interval '8 minutes', v_now - interval '8 minutes'),
    (c_sophia, 'ai', NULL, 'Yes — express delivery arrives in 1–2 business days for $14.90. You can choose it at checkout.', '{}', v_now - interval '7 minutes', v_now - interval '7 minutes', NULL);

  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority, tags, metadata, created_at, updated_at)
  VALUES (v_ws, k_grace, s_grace, 'Does the AI agent speak French?', 'open', 'normal', ARRAY['product'],
          '{"app_review_seed":true,"ai_state":"ai_managed"}', v_now - interval '5 minutes', v_now - interval '4 minutes')
  RETURNING id INTO c_grace;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_grace, 'contact', NULL, 'Can your AI agent answer customers in French as well as English?', '{}', v_now - interval '5 minutes', v_now - interval '5 minutes', v_now - interval '5 minutes'),
    (c_grace, 'ai', NULL, 'Yes! The AI agent replies in the customer''s language, including French, and uses your knowledge base for every answer.', '{}', v_now - interval '4 minutes', v_now - interval '4 minutes', NULL);

  -- 5. The AI handed this one over: it needs a person.
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority, tags, metadata, created_at, updated_at)
  VALUES (v_ws, k_noah, s_noah, 'Refund for a double charge', 'open', 'urgent', ARRAY['billing','refund'],
          '{"app_review_seed":true,"ai_state":"needs_human"}', v_now - interval '48 minutes', v_now - interval '40 minutes')
  RETURNING id INTO c_noah;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_noah, 'contact', NULL, 'I was charged twice for my September invoice. Can I get a refund for the duplicate?', '{}', v_now - interval '48 minutes', v_now - interval '48 minutes', v_now - interval '47 minutes'),
    (c_noah, 'ai', NULL, 'I''m sorry about that. Refunds need a team member to review, so I''m passing this to a colleague now.', '{}', v_now - interval '47 minutes', v_now - interval '47 minutes', NULL),
    (c_noah, 'system', NULL, 'Waiting in the queue for an available agent', '{"kind":"routing_in_queue"}', v_now - interval '47 minutes', v_now - interval '47 minutes', NULL),
    (c_noah, 'contact', NULL, 'Thanks. The transaction ID is TXN-2093-77.', '{}', v_now - interval '40 minutes', v_now - interval '40 minutes', NULL);

  -- 6. Waiting on the customer.
  INSERT INTO public.conversations (workspace_id, contact_id, subject, status, priority, tags, assigned_to, metadata, created_at, updated_at)
  VALUES (v_ws, k_ava, 'Widget not showing on Shopify', 'pending', 'normal', ARRAY['technical'], v_me,
          '{"app_review_seed":true}', v_now - interval '1 day 3 hours', v_now - interval '1 day 2 hours')
  RETURNING id INTO c_ava;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_ava, 'contact', NULL, 'The chat widget doesn''t appear on my Shopify store after I pasted the code.', '{}', v_now - interval '1 day 3 hours', v_now - interval '1 day 3 hours', v_now - interval '1 day 3 hours'),
    (c_ava, 'agent', v_me, 'Thanks Ava. Could you send a screenshot of your theme.liquid file where you pasted the snippet? It should go right before </body>.', '{}', v_now - interval '1 day 2 hours', v_now - interval '1 day 2 hours', NULL);

  -- 7. Resolved, after a phone call.
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority, tags, assigned_to, metadata, created_at, updated_at)
  VALUES (v_ws, k_ethan, s_ethan, 'Setting up the call center', 'resolved', 'normal', ARRAY['onboarding'], v_me,
          '{"app_review_seed":true}', v_now - interval '1 day 2 hours', v_now - interval '1 day 1 hour')
  RETURNING id INTO c_ethan;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_ethan, 'contact', NULL, 'Could someone walk me through setting up call queues? A quick call would be easiest.', '{}', v_now - interval '1 day 2 hours', v_now - interval '1 day 2 hours', v_now - interval '1 day 2 hours'),
    (c_ethan, 'system', NULL, 'Alex Morgan invited the visitor to an audio call', '{"kind":"call_invitation","channel":"audio","operator_name":"Alex Morgan","status":"accepted"}', v_now - interval '1 day 1 hour 55 minutes', v_now - interval '1 day 1 hour 55 minutes', NULL),
    (c_ethan, 'system', NULL, 'Call ended', '{"kind":"call_ended","duration_seconds":252,"ended_by":"operator","end_reason":"hangup"}', v_now - interval '1 day 1 hour 50 minutes', v_now - interval '1 day 1 hour 50 minutes', NULL),
    (c_ethan, 'agent', v_me, 'Great talking to you, Ethan! As promised, here''s the guide: help.webyar.ai/call-queues', '{}', v_now - interval '1 day 1 hour 48 minutes', v_now - interval '1 day 1 hour 48 minutes', NULL),
    (c_ethan, 'contact', NULL, 'All set, the queue is working. Thank you!', '{}', v_now - interval '1 day 1 hour', v_now - interval '1 day 1 hour', v_now - interval '1 day 1 hour');

  -- 8, 9 and 10. Other channels: WhatsApp, Telegram, email.
  INSERT INTO public.conversations (workspace_id, contact_id, subject, status, priority, tags, metadata, created_at, updated_at)
  VALUES (v_ws, k_mia, 'Reschedule my appointment', 'open', 'normal', ARRAY['booking'],
          '{"app_review_seed":true,"channel":"whatsapp"}', v_now - interval '35 minutes', v_now - interval '33 minutes')
  RETURNING id INTO c_mia;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_mia, 'contact', NULL, 'Hi, can I move my fitting appointment from Thursday to Friday morning?', '{}', v_now - interval '35 minutes', v_now - interval '35 minutes', NULL),
    (c_mia, 'contact', NULL, 'Any time before 11am works for me.', '{}', v_now - interval '33 minutes', v_now - interval '33 minutes', NULL);

  INSERT INTO public.conversations (workspace_id, contact_id, subject, status, priority, tags, assigned_to, metadata, created_at, updated_at)
  VALUES (v_ws, k_lucas, 'Webhook for new orders', 'open', 'low', ARRAY['api'], v_me,
          '{"app_review_seed":true,"channel":"telegram"}', v_now - interval '5 hours', v_now - interval '4 hours 30 minutes')
  RETURNING id INTO c_lucas;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_lucas, 'contact', NULL, 'Is there a webhook I can use to get notified about new conversations?', '{}', v_now - interval '5 hours', v_now - interval '5 hours', v_now - interval '5 hours'),
    (c_lucas, 'agent', v_me, 'Yes — under Settings → Integrations → Webhooks you can subscribe to conversation.created.', '{}', v_now - interval '4 hours 45 minutes', v_now - interval '4 hours 45 minutes', NULL),
    (c_lucas, 'contact', NULL, 'Perfect, found it. Thanks!', '{}', v_now - interval '4 hours 30 minutes', v_now - interval '4 hours 30 minutes', v_now - interval '4 hours 30 minutes');

  INSERT INTO public.conversations (workspace_id, contact_id, subject, status, priority, tags, metadata, created_at, updated_at)
  VALUES (v_ws, k_charlotte, 'Invoice for September', 'open', 'normal', ARRAY['billing'],
          '{"app_review_seed":true,"channel":"email"}', v_now - interval '2 hours', v_now - interval '2 hours')
  RETURNING id INTO c_charlotte;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_charlotte, 'contact', NULL, E'Hello,\n\nCould you resend the invoice for September with our VAT number (GB 123 4567 89) on it?\n\nKind regards,\nCharlotte Davies', '{}', v_now - interval '2 hours', v_now - interval '2 hours', NULL);

  -- 11. A new visitor, no name yet.
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, status, priority, metadata, created_at, updated_at)
  VALUES (v_ws, k_anon, s_anon, 'open', 'normal', '{"app_review_seed":true}', v_now - interval '1 minute', v_now - interval '1 minute')
  RETURNING id INTO c_anon;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_anon, 'contact', NULL, 'Hi, is anyone there? I have a question about the Pro plan.', '{}', v_now - interval '1 minute', v_now - interval '1 minute', NULL);

  -- 12. Spam.
  INSERT INTO public.conversations (workspace_id, contact_id, subject, status, priority, is_spam, spam_marked_at, metadata, created_at, updated_at)
  VALUES (v_ws, k_spam, 'Grow your sales 10x', 'open', 'low', true, v_now - interval '2 days',
          '{"app_review_seed":true}', v_now - interval '2 days', v_now - interval '2 days')
  RETURNING id INTO c_spam;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_spam, 'contact', NULL, 'Grow your sales 10x with our guaranteed marketing package! Reply YES for a free trial.', '{}', v_now - interval '2 days', v_now - interval '2 days', NULL);

  -- 13. Resolved a while ago.
  INSERT INTO public.conversations (workspace_id, contact_id, subject, status, priority, tags, assigned_to, metadata, created_at, updated_at)
  VALUES (v_ws, k_ben, 'Feature request: dark mode', 'resolved', 'low', ARRAY['feedback'], v_me,
          '{"app_review_seed":true}', v_now - interval '6 days', v_now - interval '5 days')
  RETURNING id INTO c_ben;
  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata, created_at, updated_at, seen_at) VALUES
    (c_ben, 'contact', NULL, 'Love the product! Any plans for a dark mode in the dashboard?', '{}', v_now - interval '6 days', v_now - interval '6 days', v_now - interval '6 days'),
    (c_ben, 'agent', v_me, 'Thanks Ben! Dark mode is now live — switch it on under Settings → Appearance.', '{}', v_now - interval '5 days', v_now - interval '5 days', NULL);

  -- Inserting a message touches its conversation; put each one back at its
  -- last message, which is what the inbox sorts by.
  UPDATE public.conversations c
     SET updated_at = m.last_at
    FROM (SELECT conversation_id, max(created_at) AS last_at
            FROM public.conversation_messages
           WHERE conversation_id IN (SELECT id FROM public.conversations WHERE workspace_id = v_ws)
           GROUP BY conversation_id) m
   WHERE c.id = m.conversation_id;

  -- ── Colleagues ───────────────────────────────────────────────────────────
  INSERT INTO public.team_messages (workspace_id, sender_id, recipient_id, body, read_at, created_at) VALUES
    (v_ws, v_owner, v_me, 'Morning Alex! Could you pick up Olivia Bennett''s chat? Her order is stuck in transit.', v_now - interval '20 minutes', v_now - interval '21 minutes'),
    (v_ws, v_me, v_owner, 'On it. I''ll check with the carrier and upgrade her shipping if needed.', NULL, v_now - interval '19 minutes'),
    (v_ws, v_owner, v_me, 'Thanks! Also, Liam''s quote is approved — 20% annual discount.', NULL, v_now - interval '10 minutes'),
    (v_ws, v_mate, v_me, 'I updated the shipping saved reply with the new express price.', v_now - interval '2 hours', v_now - interval '3 hours'),
    (v_ws, v_me, v_mate, 'Perfect, thank you Daniel!', NULL, v_now - interval '2 hours 55 minutes');

  -- ── Saved replies ────────────────────────────────────────────────────────
  INSERT INTO public.canned_responses (workspace_id, created_by, locale, shortcut, title, body, is_active) VALUES
    (v_ws, v_owner, 'en', 'hello', 'Greeting', 'Hi {{contact.name}}, thanks for reaching out! How can I help you today?', true),
    (v_ws, v_mate, 'en', 'shipping', 'Shipping times', 'Standard shipping takes 3–5 business days. Express delivery arrives in 1–2 business days for $14.90.', true),
    (v_ws, v_owner, 'en', 'refund', 'Refund policy', 'Refunds are processed within 5 business days and go back to the original payment method.', true),
    (v_ws, v_owner, 'en', 'pricing', 'Pricing', 'You can compare all plans at webyar.ai/pricing. Annual billing saves 20%.', true),
    (v_ws, v_mate, 'en', 'bye', 'Closing', 'Glad I could help, {{contact.name}}! Have a great day.', true);

  -- ── Six months of website traffic ────────────────────────────────────────
  -- More visits on weekdays, slowly growing, so every range has a period
  -- before it to compare with. Visitors come back: ids repeat.
  WITH days AS (
    SELECT d, (v_now::date - d) AS day
      FROM generate_series(1, 180) AS d
  ), counts AS (
    SELECT day,
           greatest(3, round((9 + 10 * (1 - d / 180.0))
                             * CASE WHEN extract(isodow FROM day) IN (6, 7) THEN 0.6 ELSE 1 END
                             + random() * 5))::int AS n
      FROM days
  ), raw AS MATERIALIZED (
    SELECT day,
           floor(random() * 12)::int AS gi,
           floor(random() * 10)::int AS si,
           floor(random() * 8)::int  AS di,
           floor(random() * 7)::int  AS pi,
           (day + make_interval(secs => floor(random() * 86000)::int))::timestamptz AS started,
           20 + floor(random() * 480)::int AS secs,
           'demo-' || lpad(floor(random() * 700)::int::text, 3, '0') AS visitor
      FROM counts, generate_series(1, n)
  ), geo(i, code, name, region, city, lat, lng, tz, lang) AS (
    VALUES (0,'US','United States','New York','New York',40.7128,-74.0060,'America/New_York','en-US'),
           (1,'US','United States','California','Los Angeles',34.0522,-118.2437,'America/Los_Angeles','en-US'),
           (2,'US','United States','Illinois','Chicago',41.8781,-87.6298,'America/Chicago','en-US'),
           (3,'GB','United Kingdom','England','London',51.5074,-0.1278,'Europe/London','en-GB'),
           (4,'GB','United Kingdom','England','Manchester',53.4808,-2.2426,'Europe/London','en-GB'),
           (5,'CA','Canada','Ontario','Toronto',43.6532,-79.3832,'America/Toronto','en-CA'),
           (6,'DE','Germany','Berlin','Berlin',52.5200,13.4050,'Europe/Berlin','de-DE'),
           (7,'AU','Australia','New South Wales','Sydney',-33.8688,151.2093,'Australia/Sydney','en-AU'),
           (8,'FR','France','Île-de-France','Paris',48.8566,2.3522,'Europe/Paris','fr-FR'),
           (9,'NL','Netherlands','North Holland','Amsterdam',52.3676,4.9041,'Europe/Amsterdam','nl-NL'),
           (10,'IN','India','Karnataka','Bengaluru',12.9716,77.5946,'Asia/Kolkata','en-IN'),
           (11,'US','United States','Texas','Austin',30.2672,-97.7431,'America/Chicago','en-US')
  ), src(i, referrer, utm_source, utm_medium, utm_campaign) AS (
    VALUES (0,'https://www.google.com/',NULL,NULL,NULL),
           (1,'https://www.google.com/',NULL,NULL,NULL),
           (2,'https://www.google.com/',NULL,NULL,NULL),
           (3,'',NULL,NULL,NULL),
           (4,'',NULL,NULL,NULL),
           (5,'https://www.linkedin.com/',NULL,NULL,NULL),
           (6,'https://twitter.com/',NULL,NULL,NULL),
           (7,'https://www.bing.com/',NULL,NULL,NULL),
           (8,'','newsletter','email','autumn_launch'),
           (9,'https://www.facebook.com/','facebook','cpc','retargeting')
  ), dev(i, browser, os, device) AS (
    VALUES (0,'Chrome','Windows','desktop'), (1,'Chrome','macOS','desktop'), (2,'Safari','macOS','desktop'),
           (3,'Safari','iOS','mobile'), (4,'Safari','iOS','mobile'), (5,'Chrome','Android','mobile'),
           (6,'Edge','Windows','desktop'), (7,'Safari','iPadOS','tablet')
  ), page(i, path) AS (
    VALUES (0,'/'), (1,'/'), (2,'/pricing'), (3,'/features'), (4,'/blog/live-chat-best-practices'),
           (5,'/integrations'), (6,'/products/trail-backpack-45l')
  )
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at,
           utm_source, utm_medium, utm_campaign)
  SELECT v_ws, r.visitor, p.path, s.referrer, d.browser, d.device, d.os,
         g.name, g.city, r.started, r.started + make_interval(secs => r.secs), 'anonymous',
         jsonb_build_object('app_review_seed', true, 'app_review_traffic', true), g.lang,
         g.code, g.name, g.region, g.city, g.lat, g.lng, g.tz, 'city', 'maxmind_local', r.started,
         s.utm_source, s.utm_medium, s.utm_campaign
    FROM raw r
    JOIN geo g ON g.i = r.gi
    JOIN src s ON s.i = r.si
    JOIN dev d ON d.i = r.di
    JOIN page p ON p.i = r.pi;

  -- One to four page views a visit, the first being where it landed.
  WITH visits AS MATERIALIZED (
    SELECT id, current_page, started_at, last_seen_at,
           1 + floor(random() * random() * 4)::int AS views
      FROM public.visitor_sessions
     WHERE workspace_id = v_ws AND metadata->>'app_review_traffic' = 'true'
  ), page(i, path, title) AS (
    VALUES (0,'/','Northwind Outfitters — Outdoor gear'), (1,'/pricing','Pricing'), (2,'/features','Features'),
           (3,'/blog/live-chat-best-practices','5 live chat best practices'), (4,'/integrations','Integrations'),
           (5,'/products/trail-backpack-45l','Trail Backpack 45L'), (6,'/contact','Contact us'), (7,'/signup','Sign up')
  ), views AS MATERIALIZED (
    SELECT v.id, v.current_page, v.started_at, v.last_seen_at, n,
           floor(random() * 8)::int AS pi
      FROM visits v, generate_series(1, v.views) AS n
  )
  INSERT INTO public.visitor_page_views (workspace_id, visitor_session_id, url, title, viewed_at)
  SELECT v_ws, w.id,
         CASE WHEN w.n = 1 THEN w.current_page ELSE p.path END,
         CASE WHEN w.n = 1 THEN coalesce((SELECT t.title FROM page t WHERE t.path = w.current_page LIMIT 1), 'Home') ELSE p.title END,
         w.started_at + (w.last_seen_at - w.started_at) * ((w.n - 1)::double precision / 4)
    FROM views w
    JOIN page p ON p.i = w.pi;

  -- Goals: a few of those visits signed up or asked for a demo.
  INSERT INTO public.web_analytics_events (workspace_id, visitor_session_id, event_name, properties, page_url, created_at)
  SELECT v_ws, s.id,
         CASE WHEN random() < 0.6 THEN 'signup_click' ELSE 'demo_request' END,
         '{}'::jsonb, s.current_page, s.last_seen_at
    FROM public.visitor_sessions s
   WHERE s.workspace_id = v_ws AND s.metadata->>'app_review_traffic' = 'true' AND random() < 0.08;

  -- ── Remember it ──────────────────────────────────────────────────────────
  UPDATE public.mobile_app_settings
     SET app_review_seeded_at = v_now,
         demo_account_username = c_email;

  RETURN public.app_review_status();
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_review_set_enabled(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_review_keep_visitors_live() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_review_seed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.app_review_set_enabled(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_review_keep_visitors_live() TO service_role;
GRANT EXECUTE ON FUNCTION public.app_review_seed(text) TO service_role;
