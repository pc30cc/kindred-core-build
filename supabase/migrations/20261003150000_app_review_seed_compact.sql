-- ============================================================
-- APP REVIEW DEMO: THE SEED, SMALLER AND IN PARTS
--
-- Self-host mirror: database/migrations/249_app_review_seed_compact.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- 248's app_review_seed() wrote the English demo as one 47 KB function,
-- row by row. This writes the same demo as data, in small functions that
-- each apply on their own. app_review_seed(hash) keeps its name, arguments
-- and result, so the Super Admin card and 248's status, switch and
-- keep-live functions are unchanged. All of it is for the service role.
-- ============================================================

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
     SET entitlements = EXCLUDED.entitlements, limits = EXCLUDED.limits,
         is_active = true, is_hidden = true, updated_at = now()
  RETURNING id INTO v_plan;
  RETURN v_plan;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_plan() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_plan() TO service_role;

-- The reviewer, and the owner and a colleague: names on screen that cannot
-- sign in. Returns {"me", "owner", "mate"}.
CREATE OR REPLACE FUNCTION public.app_review_seed_people(_password_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ids jsonb := '{}'::jsonb;
  v_id  uuid;
  r     record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('owner', 'emma.wilson@demo.webyar.ai', 'Emma Wilson'),
                                 ('mate', 'daniel.carter@demo.webyar.ai', 'Daniel Carter')) p(k, email, name)
  LOOP
    SELECT id INTO v_id FROM public.profiles WHERE email = r.email;
    IF v_id IS NULL THEN
      INSERT INTO public.profiles (id, email, full_name, preferred_locale, signup_locale)
      VALUES (gen_random_uuid(), r.email, r.name, 'en', 'en') RETURNING id INTO v_id;
    END IF;
    INSERT INTO public.user_credentials (user_id, status) VALUES (v_id, 'disabled')
    ON CONFLICT (user_id) DO UPDATE SET status = 'disabled', updated_at = now();
    v_ids := v_ids || jsonb_build_object(r.k, v_id);
  END LOOP;

  -- Brought back when App Review deleted it last time.
  SELECT id INTO v_id FROM public.profiles WHERE email = 'apple@webyar.ai';
  IF v_id IS NULL THEN
    IF _password_hash IS NULL THEN
      RAISE EXCEPTION 'app_review_password_required';
    END IF;
    INSERT INTO public.profiles (id, email, full_name, preferred_locale, signup_locale)
    VALUES (gen_random_uuid(), 'apple@webyar.ai', 'Alex Morgan', 'en', 'en') RETURNING id INTO v_id;
    INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at,
                                         email_verified_at, status)
    VALUES (v_id, _password_hash, 'argon2id', now(), now(), 'active')
    ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, password_algo = 'argon2id',
           password_set_at = now(), email_verified_at = now(),
           status = 'active', failed_login_count = 0, updated_at = now();
  ELSE
    UPDATE public.profiles SET full_name = 'Alex Morgan', preferred_locale = 'en' WHERE id = v_id;
    -- Whether it may sign in is the switch's to say, never the seed's.
    INSERT INTO public.user_credentials (user_id, email_verified_at, status)
    VALUES (v_id, now(), 'active')
    ON CONFLICT (user_id) DO UPDATE
       SET email_verified_at = coalesce(public.user_credentials.email_verified_at, now()),
           failed_login_count = 0, updated_at = now();
    IF _password_hash IS NOT NULL THEN
      UPDATE public.user_credentials
         SET password_hash = _password_hash, password_algo = 'argon2id',
             password_set_at = now(), updated_at = now()
       WHERE user_id = v_id;
    END IF;
  END IF;
  RETURN v_ids || jsonb_build_object('me', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_people(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_people(text) TO service_role;

-- "Webyar Demo", owned by Emma, on the hidden plan until 2099, emptied of
-- whatever the last review left.
CREATE OR REPLACE FUNCTION public.app_review_seed_workspace(_p jsonb, _plan uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_owner uuid := (_p->>'owner')::uuid;
  v_acct  uuid;
  v_ws    uuid;
  v_sub   public.workspace_subscriptions%ROWTYPE;
  v_period uuid;
  v_table text;
BEGIN
  SELECT id INTO v_ws FROM public.workspaces WHERE slug = 'ws_appreview';
  IF v_ws IS NULL THEN
    SELECT id INTO v_acct FROM public.accounts WHERE owner_id = v_owner ORDER BY created_at LIMIT 1;
    IF v_acct IS NULL THEN
      INSERT INTO public.accounts (name, slug, owner_id)
      VALUES ('Webyar Demo', 'acc_appreview', v_owner) RETURNING id INTO v_acct;
    END IF;
    INSERT INTO public.account_members (account_id, user_id, role) VALUES (v_acct, v_owner, 'owner')
    ON CONFLICT (account_id, user_id) DO NOTHING;
    v_ws := public.create_workspace_atomic(v_acct, 'Webyar Demo', 'ws_appreview', v_owner);
  END IF;
  UPDATE public.workspaces
     SET name = 'Webyar Demo', default_locale = 'en', panel_locale = 'en', widget_locale = 'en'
   WHERE id = v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, (_p->>'me')::uuid, 'admin'), (v_ws, (_p->>'mate')::uuid, 'agent')
  ON CONFLICT (workspace_id, user_id) DO UPDATE
     SET role = EXCLUDED.role, suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL;

  -- Granted as Super Admin would. A new workspace has no subscription row
  -- yet, and the period's allowance cycles hang off it.
  SELECT * INTO v_sub FROM public.workspace_subscriptions WHERE workspace_id = v_ws;
  IF v_sub.plan_id IS DISTINCT FROM _plan OR v_sub.current_period_end IS NULL
     OR v_sub.current_period_end < now() + interval '1 year' THEN
    INSERT INTO public.workspace_subscriptions (workspace_id, provider_name, status, billing_engine_version)
    VALUES (v_ws, 'manual', 'active', 'v2')
    ON CONFLICT (workspace_id) DO NOTHING;
    INSERT INTO public.billing_subscription_periods (workspace_id, subscription_id, plan_id, invoice_id,
                billing_interval, period_start, period_end, status, source, plan_snapshot,
                limits_snapshot, ai_allowance_irr)
    SELECT v_ws, (SELECT id FROM public.workspace_subscriptions WHERE workspace_id = v_ws), p.id, NULL,
           'yearly', now(), timestamptz '2099-12-31 00:00:00+00', 'scheduled', 'admin', to_jsonb(p), p.limits, 0
      FROM public.billing_plans p WHERE p.id = _plan
    RETURNING id INTO v_period;
    PERFORM public.billing_activate_period(v_period);
  END IF;

  FOREACH v_table IN ARRAY ARRAY['team_messages', 'conversation_notes', 'conversations', 'web_analytics_events',
                                 'visitor_page_views', 'visitor_presence', 'visitor_sessions', 'contacts',
                                 'canned_responses', 'workspace_department_members', 'workspace_departments']
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE workspace_id = $1', v_table) USING v_ws;
  END LOOP;

  WITH d AS (
    INSERT INTO public.workspace_departments (workspace_id, name, enabled, chat_enabled, audio_enabled, video_enabled, sort_order)
    VALUES (v_ws, 'Sales', true, true, true, true, 1), (v_ws, 'Support', true, true, true, true, 2)
    RETURNING id, name
  )
  INSERT INTO public.workspace_department_members (department_id, workspace_id, user_id)
  SELECT d.id, v_ws, (_p->>m.who)::uuid
    FROM d JOIN (VALUES ('Sales', 'me'), ('Support', 'me'), ('Sales', 'owner'), ('Support', 'mate')) m(name, who)
      ON m.name = d.name;
  RETURN v_ws;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_workspace(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_workspace(jsonb, uuid) TO service_role;

-- What a page of the demo shop is called.
CREATE OR REPLACE FUNCTION public.app_review_seed_title(_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE _path
           WHEN '/' THEN 'Northwind Outfitters — Outdoor gear'
           WHEN '/products/trail-backpack-45l' THEN 'Trail Backpack 45L'
           WHEN '/blog/live-chat-best-practices' THEN '5 live chat best practices'
           WHEN '/features/ai-agent' THEN 'AI agent'
           WHEN '/shipping' THEN 'Shipping & delivery'
           WHEN '/account/orders' THEN 'Your orders'
           WHEN '/contact' THEN 'Contact us'
           WHEN '/signup' THEN 'Sign up'
           ELSE initcap(replace(split_part(_path, '/', -1), '-', ' '))
         END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_title(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_title(text) TO service_role;

-- Returns {key: contact id}.
CREATE OR REPLACE FUNCTION public.app_review_seed_contacts(_ws uuid)
RETURNS jsonb
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH c(k, name, email, phone, code, age) AS (VALUES
    ('olivia', 'Olivia Bennett', 'olivia.bennett@example.com', '+1 415 555 0142', NULL, '40 days'),
    ('liam', 'Liam Foster', 'liam.foster@example.co.uk', '+44 20 7946 0321', NULL, '12 days'),
    ('sophia', 'Sophia Martinez', 'sophia.martinez@example.com', NULL, NULL, '3 days'),
    ('noah', 'Noah Schmidt', 'noah.schmidt@example.de', '+49 30 901820', NULL, '65 days'),
    ('ava', 'Ava Thompson', 'ava.thompson@example.com.au', NULL, NULL, '20 days'),
    ('ethan', 'Ethan Brooks', 'ethan.brooks@example.ca', '+1 416 555 0198', NULL, '90 days'),
    ('mia', 'Mia Johnson', NULL, '+1 646 555 0187', NULL, '8 days'),
    ('lucas', 'Lucas Meyer', NULL, NULL, NULL, '5 days'),
    ('charlotte', 'Charlotte Davies', 'charlotte.davies@example.co.uk', NULL, NULL, '30 days'),
    ('anon', NULL, NULL, NULL, '8F2C', '15 minutes'),
    ('spam', 'Quick Profits', 'promo@quick-profits.example', NULL, NULL, '2 days'),
    ('ben', 'Benjamin Clark', 'ben.clark@example.com', NULL, NULL, '120 days'),
    ('grace', 'Grace Lee', 'grace.lee@example.com', NULL, NULL, '1 day')
  ), ins AS (
    INSERT INTO public.contacts (workspace_id, name, email, phone, visitor_code, metadata, created_at)
    SELECT _ws, name, email, phone, code, '{"app_review_seed":true}', now() - age::interval FROM c
    RETURNING id, coalesce(name, visitor_code) AS n
  )
  SELECT jsonb_object_agg(c.k, ins.id) FROM ins JOIN c ON coalesce(c.name, c.code) = ins.n;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_contacts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_contacts(uuid) TO service_role;

-- Seven visitors on the site now ('app_review_live': 248's
-- app_review_keep_visitors_live keeps them there) and three past visits
-- behind older conversations. Returns {key: session id}.
CREATE OR REPLACE FUNCTION public.app_review_seed_visitors(_ws uuid, _contacts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ids jsonb;
BEGIN
  WITH v(k, page, ref, browser, device, os, cc, country, region, city, lat, lng, tz, lang, started, seen) AS (VALUES
    ('olivia', '/checkout', 'https://www.google.com/', 'Safari', 'mobile', 'iOS', 'US', 'United States', 'California', 'San Francisco', 37.7749, -122.4194, 'America/Los_Angeles', 'en-US', 25, 1),
    ('anon', '/pricing', 'https://www.linkedin.com/', 'Chrome', 'desktop', 'Windows', 'GB', 'United Kingdom', 'England', 'London', 51.5074, -0.1278, 'Europe/London', 'en-GB', 15, 1),
    ('sophia', '/shipping', '', 'Chrome', 'mobile', 'Android', 'US', 'United States', 'Texas', 'Austin', 30.2672, -97.7431, 'America/Chicago', 'en-US', 9, 1),
    ('grace', '/features/ai-agent', 'https://www.bing.com/', 'Edge', 'desktop', 'Windows', 'CA', 'Canada', 'British Columbia', 'Vancouver', 49.2827, -123.1207, 'America/Vancouver', 'en-CA', 6, 1),
    ('berlin', '/blog/live-chat-best-practices', 'https://www.google.de/', 'Firefox', 'desktop', 'macOS', 'DE', 'Germany', 'Berlin', 'Berlin', 52.52, 13.405, 'Europe/Berlin', 'de-DE', 4, 1),
    ('sydney', '/', 'https://twitter.com/', 'Safari', 'mobile', 'iOS', 'AU', 'Australia', 'New South Wales', 'Sydney', -33.8688, 151.2093, 'Australia/Sydney', 'en-AU', 2, 1),
    ('toronto', '/integrations', 'https://www.producthunt.com/', 'Chrome', 'tablet', 'iPadOS', 'CA', 'Canada', 'Ontario', 'Toronto', 43.6532, -79.3832, 'America/Toronto', 'en-CA', 11, 1),
    ('liam', '/pricing', 'https://www.google.co.uk/', 'Chrome', 'desktop', 'macOS', 'GB', 'United Kingdom', 'England', 'Manchester', 53.4808, -2.2426, 'Europe/London', 'en-GB', 180, 160),
    ('noah', '/account/billing', '', 'Chrome', 'desktop', 'Windows', 'DE', 'Germany', 'Bavaria', 'Munich', 48.1351, 11.582, 'Europe/Berlin', 'de-DE', 50, 35),
    ('ethan', '/contact', 'https://duckduckgo.com/', 'Safari', 'desktop', 'macOS', 'CA', 'Canada', 'Ontario', 'Toronto', 43.6532, -79.3832, 'America/Toronto', 'en-CA', 1560, 1500)
  ), ins AS (
    INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
             country, city, started_at, last_seen_at, contact_id, identity_state, metadata, language,
             geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
             geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at)
    SELECT _ws, 'demo-' || k, page, ref, browser, device, os, country, city,
           now() - make_interval(mins => started), now() - make_interval(mins => seen), (_contacts->>k)::uuid,
           CASE WHEN k = 'anon' OR _contacts->>k IS NULL THEN 'anonymous' ELSE 'identified' END,
           CASE WHEN seen = 1 THEN jsonb_build_object('app_review_seed', true, 'app_review_live', true, 'app_review_minutes', started)
                ELSE '{"app_review_seed":true}' END,
           lang, cc, country, region, city, lat, lng, tz, 'city', 'maxmind_local', now()
      FROM v
    RETURNING id, substr(visitor_id, 6) AS k
  )
  SELECT jsonb_object_agg(k, id) INTO v_ids FROM ins;

  INSERT INTO public.visitor_presence (workspace_id, visitor_session_id, status, current_page, updated_at)
  SELECT _ws, id, 'idle', current_page, now() - interval '60 seconds'
    FROM public.visitor_sessions WHERE workspace_id = _ws AND metadata->>'app_review_live' = 'true';
  RETURN v_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_visitors(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_visitors(uuid, jsonb) TO service_role;

-- One conversation. _c: {k (contact), s (visitor), subject, status,
-- priority, tags, mine, spam, meta}; _m: [[sender, minutes ago, body,
-- read, metadata]]. An agent's message is Alex's; a read message was seen
-- a minute after it came. The thread is dated by its messages.
CREATE OR REPLACE FUNCTION public.app_review_seed_thread(_ws uuid, _p jsonb, _ids jsonb, _c jsonb, _m jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.conversations (workspace_id, contact_id, visitor_session_id, subject, status, priority,
                                    tags, assigned_to, is_spam, spam_marked_at, metadata)
  VALUES (_ws, (_ids->'contacts'->>(_c->>'k'))::uuid, (_ids->'visitors'->>(_c->>'s'))::uuid, _c->>'subject',
          coalesce(_c->>'status', 'open')::public.conversation_status,
          coalesce(_c->>'priority', 'normal')::public.conversation_priority,
          ARRAY(SELECT jsonb_array_elements_text(coalesce(_c->'tags', '[]'))),
          CASE WHEN (_c->>'mine')::boolean THEN (_p->>'me')::uuid END,
          coalesce((_c->>'spam')::boolean, false),
          CASE WHEN (_c->>'spam')::boolean THEN now() - make_interval(mins => (_m->0->>1)::int) END,
          '{"app_review_seed":true}'::jsonb || coalesce(_c->'meta', '{}'))
  RETURNING id INTO v_id;

  INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata,
                                            created_at, updated_at, seen_at)
  SELECT v_id, (m->>0)::public.sender_type, CASE WHEN m->>0 = 'agent' THEN (_p->>'me')::uuid END,
         m->>2, coalesce(m->4, '{}'), t, t, CASE WHEN (m->>3)::boolean THEN least(t + interval '1 minute', now()) END
    FROM jsonb_array_elements(_m) m, LATERAL (SELECT now() - make_interval(mins => (m->>1)::int) AS t) x;

  -- Inserting a message touches its conversation; the inbox sorts by this.
  UPDATE public.conversations c
     SET created_at = x.first_at, updated_at = x.last_at
    FROM (SELECT min(created_at) AS first_at, max(created_at) AS last_at
            FROM public.conversation_messages WHERE conversation_id = v_id) x
   WHERE c.id = v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_thread(uuid, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_thread(uuid, jsonb, jsonb, jsonb, jsonb) TO service_role;

-- The website chats: open, assigned with an internal note, the AI's, and
-- one the AI handed over. Each thread is unassigned or Alex's: the inbox
-- lists only those.
CREATE OR REPLACE FUNCTION public.app_review_seed_inbox(_ws uuid, _p jsonb, _ids jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_liam uuid;
BEGIN
  PERFORM public.app_review_seed_thread(_ws, _p, _ids, t.c, t.m) FROM (VALUES
    ('{"k":"olivia","s":"olivia","subject":"Order #NW-48213 is late","priority":"high","tags":["order","shipping"]}'::jsonb,
     '[["contact",24,"Hi! I ordered the Trail Backpack 45L last week and the tracking hasn''t moved since Monday.",true],
       ["system",22,"Emma Wilson joined the conversation",false,{"kind":"routing_agent_joined","agent_name":"Emma Wilson"}],
       ["contact",6,"The order number is NW-48213. I need it before my trip on Saturday.",false],
       ["contact",2,"Is there any way to upgrade the shipping?",false]]'::jsonb),
    ('{"k":"sophia","s":"sophia","subject":"Delivery time to Texas","tags":["shipping"],"meta":{"ai_state":"ai_managed"}}',
     '[["contact",9,"How long does standard shipping take to Austin, Texas?",true],
       ["ai",9,"Standard shipping to Texas usually takes 3–5 business days. Orders placed before 2 pm ship the same day.",false],
       ["contact",8,"And is express available?",true],
       ["ai",7,"Yes — express delivery arrives in 1–2 business days for $14.90. You can choose it at checkout.",false]]'),
    ('{"k":"grace","s":"grace","subject":"Does the AI agent speak French?","tags":["product"],"meta":{"ai_state":"ai_managed"}}',
     '[["contact",5,"Can your AI agent answer customers in French as well as English?",true],
       ["ai",4,"Yes! The AI agent replies in the customer''s language, including French, and uses your knowledge base for every answer.",false]]'),
    ('{"k":"noah","s":"noah","subject":"Refund for a double charge","priority":"urgent","tags":["billing","refund"],"meta":{"ai_state":"needs_human"}}',
     '[["contact",48,"I was charged twice for my September invoice. Can I get a refund for the duplicate?",true],
       ["ai",47,"I''m sorry about that. Refunds need a team member to review, so I''m passing this to a colleague now.",false],
       ["system",47,"Waiting in the queue for an available agent",false,{"kind":"routing_in_queue"}],
       ["contact",40,"Thanks. The transaction ID is TXN-2093-77.",false]]')
  ) t(c, m);

  v_liam := public.app_review_seed_thread(_ws, _p, _ids,
    '{"k":"liam","s":"liam","subject":"Team plan for 12 agents","tags":["sales","pricing"],"mine":true}',
    '[["contact",180,"Hello, we have 12 support agents. Do you offer a discount for annual billing?",true],
      ["agent",175,"Hi Liam, thanks for reaching out! Yes, annual billing saves 20%, and teams over 10 agents get onboarding included.",false],
      ["contact",160,"Great. Could you send me a quote for 12 seats so I can share it with finance?",true],
      ["agent",155,"Of course. I''ll email the quote to liam.foster@example.co.uk within the hour.",false]]');
  INSERT INTO public.conversation_notes (workspace_id, conversation_id, author_id, body, created_at, updated_at)
  VALUES (_ws, v_liam, (_p->>'owner')::uuid,
          'Liam is evaluating us against two other tools. Offer the onboarding call if he asks about migration.',
          now() - interval '170 minutes', now() - interval '170 minutes');
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_inbox(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_inbox(uuid, jsonb, jsonb) TO service_role;

-- Waiting on the customer, resolved after a call, WhatsApp, Telegram,
-- email, a new visitor, spam, and an old resolved thread.
CREATE OR REPLACE FUNCTION public.app_review_seed_inbox_more(_ws uuid, _p jsonb, _ids jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM public.app_review_seed_thread(_ws, _p, _ids, t.c, t.m) FROM (VALUES
    ('{"k":"ava","subject":"Widget not showing on Shopify","status":"pending","tags":["technical"],"mine":true}'::jsonb,
     '[["contact",1620,"The chat widget doesn''t appear on my Shopify store after I pasted the code.",true],
       ["agent",1560,"Thanks Ava. Could you send a screenshot of your theme.liquid file where you pasted the snippet? It should go right before </body>.",false]]'::jsonb),
    ('{"k":"ethan","s":"ethan","subject":"Setting up the call center","status":"resolved","tags":["onboarding"],"mine":true}',
     '[["contact",1560,"Could someone walk me through setting up call queues? A quick call would be easiest.",true],
       ["system",1555,"Alex Morgan invited the visitor to an audio call",false,{"kind":"call_invitation","channel":"audio","operator_name":"Alex Morgan","status":"accepted"}],
       ["system",1550,"Call ended",false,{"kind":"call_ended","duration_seconds":252,"ended_by":"operator","end_reason":"hangup"}],
       ["agent",1548,"Great talking to you, Ethan! As promised, here''s the guide: help.webyar.ai/call-queues",false],
       ["contact",1500,"All set, the queue is working. Thank you!",true]]'),
    ('{"k":"mia","subject":"Reschedule my appointment","tags":["booking"],"meta":{"channel":"whatsapp"}}',
     '[["contact",35,"Hi, can I move my fitting appointment from Thursday to Friday morning?",false],
       ["contact",33,"Any time before 11am works for me.",false]]'),
    ('{"k":"lucas","subject":"Webhook for new orders","priority":"low","tags":["api"],"mine":true,"meta":{"channel":"telegram"}}',
     '[["contact",300,"Is there a webhook I can use to get notified about new conversations?",true],
       ["agent",285,"Yes — under Settings → Integrations → Webhooks you can subscribe to conversation.created.",false],
       ["contact",270,"Perfect, found it. Thanks!",true]]'),
    ('{"k":"charlotte","subject":"Invoice for September","tags":["billing"],"meta":{"channel":"email"}}',
     '[["contact",120,"Hello,\n\nCould you resend the invoice for September with our VAT number (GB 123 4567 89) on it?\n\nKind regards,\nCharlotte Davies",false]]'),
    ('{"k":"anon","s":"anon"}',
     '[["contact",1,"Hi, is anyone there? I have a question about the Pro plan.",false]]'),
    ('{"k":"spam","subject":"Grow your sales 10x","priority":"low","spam":true}',
     '[["contact",2880,"Grow your sales 10x with our guaranteed marketing package! Reply YES for a free trial.",false]]'),
    ('{"k":"ben","subject":"Feature request: dark mode","status":"resolved","priority":"low","tags":["feedback"],"mine":true}',
     '[["contact",8640,"Love the product! Any plans for a dark mode in the dashboard?",true],
       ["agent",7200,"Thanks Ben! Dark mode is now live — switch it on under Settings → Appearance.",false]]')
  ) t(c, m);
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_inbox_more(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_inbox_more(uuid, jsonb, jsonb) TO service_role;

-- Colleagues' messages and the saved replies.
CREATE OR REPLACE FUNCTION public.app_review_seed_team(_ws uuid, _p jsonb)
RETURNS void
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $$
  INSERT INTO public.team_messages (workspace_id, sender_id, recipient_id, body, read_at, created_at)
  SELECT _ws, (_p->>f)::uuid, (_p->>t)::uuid, body,
         now() - make_interval(mins => read_ago), now() - make_interval(mins => ago)
    FROM (VALUES ('owner', 'me', 'Morning Alex! Could you pick up Olivia Bennett''s chat? Her order is stuck in transit.', 21, 20),
                 ('me', 'owner', 'On it. I''ll check with the carrier and upgrade her shipping if needed.', 19, NULL),
                 ('owner', 'me', 'Thanks! Also, Liam''s quote is approved — 20% annual discount.', 10, NULL),
                 ('mate', 'me', 'I updated the shipping saved reply with the new express price.', 180, 120),
                 ('me', 'mate', 'Perfect, thank you Daniel!', 175, NULL)) m(f, t, body, ago, read_ago);

  INSERT INTO public.canned_responses (workspace_id, created_by, locale, shortcut, title, body, is_active)
  SELECT _ws, (_p->>who)::uuid, 'en', shortcut, title, body, true
    FROM (VALUES ('owner', 'hello', 'Greeting', 'Hi {{contact.name}}, thanks for reaching out! How can I help you today?'),
                 ('mate', 'shipping', 'Shipping times', 'Standard shipping takes 3–5 business days. Express delivery arrives in 1–2 business days for $14.90.'),
                 ('owner', 'refund', 'Refund policy', 'Refunds are processed within 5 business days and go back to the original payment method.'),
                 ('owner', 'pricing', 'Pricing', 'You can compare all plans at webyar.ai/pricing. Annual billing saves 20%.'),
                 ('mate', 'bye', 'Closing', 'Glad I could help, {{contact.name}}! Have a great day.')) r(who, shortcut, title, body);
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_team(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_team(uuid, jsonb) TO service_role;

-- Six months of website traffic: more on weekdays, slowly growing, and
-- visitors who come back.
CREATE OR REPLACE FUNCTION public.app_review_seed_traffic(_ws uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  geo text[] := ARRAY[
    'US|United States|New York|New York|40.7128|-74.006|America/New_York|en-US',
    'US|United States|California|Los Angeles|34.0522|-118.2437|America/Los_Angeles|en-US',
    'US|United States|Illinois|Chicago|41.8781|-87.6298|America/Chicago|en-US',
    'US|United States|Texas|Austin|30.2672|-97.7431|America/Chicago|en-US',
    'GB|United Kingdom|England|London|51.5074|-0.1278|Europe/London|en-GB',
    'GB|United Kingdom|England|Manchester|53.4808|-2.2426|Europe/London|en-GB',
    'CA|Canada|Ontario|Toronto|43.6532|-79.3832|America/Toronto|en-CA',
    'DE|Germany|Berlin|Berlin|52.52|13.405|Europe/Berlin|de-DE',
    'AU|Australia|New South Wales|Sydney|-33.8688|151.2093|Australia/Sydney|en-AU',
    'FR|France|Île-de-France|Paris|48.8566|2.3522|Europe/Paris|fr-FR',
    'NL|Netherlands|North Holland|Amsterdam|52.3676|4.9041|Europe/Amsterdam|nl-NL',
    'IN|India|Karnataka|Bengaluru|12.9716|77.5946|Asia/Kolkata|en-IN'];
  src text[] := ARRAY['https://www.google.com/|||', 'https://www.google.com/|||', 'https://www.google.com/|||',
    '|||', '|||', 'https://www.linkedin.com/|||', 'https://twitter.com/|||', 'https://www.bing.com/|||',
    '|newsletter|email|autumn_launch', 'https://www.facebook.com/|facebook|cpc|retargeting'];
  dev text[] := ARRAY['Chrome|Windows|desktop', 'Chrome|macOS|desktop', 'Safari|macOS|desktop', 'Safari|iOS|mobile',
    'Safari|iOS|mobile', 'Chrome|Android|mobile', 'Edge|Windows|desktop', 'Safari|iPadOS|tablet'];
  page text[] := ARRAY['/', '/', '/pricing', '/features', '/blog/live-chat-best-practices', '/integrations',
    '/products/trail-backpack-45l'];
BEGIN
  INSERT INTO public.visitor_sessions (workspace_id, visitor_id, current_page, referrer, browser, device, os,
           country, city, started_at, last_seen_at, identity_state, metadata, language,
           geo_country_code, geo_country_name, geo_region, geo_city, geo_latitude, geo_longitude,
           geo_timezone, geo_accuracy_level, geo_source_provider, geo_resolved_at,
           utm_source, utm_medium, utm_campaign)
  SELECT _ws, visitor, page[1 + floor(random() * 7)::int], s[1], dv[1], dv[3], dv[2], g[2], g[4], started,
         started + make_interval(secs => 20 + floor(random() * 480)::int), 'anonymous',
         '{"app_review_seed":true,"app_review_traffic":true}', g[8], g[1], g[2], g[3], g[4],
         g[5]::float8, g[6]::float8, g[7], 'city', 'maxmind_local', started,
         nullif(s[2], ''), nullif(s[3], ''), nullif(s[4], '')
    FROM (SELECT (current_date - d) + make_interval(secs => floor(random() * 86000)::int) AS started,
                 'demo-' || lpad(floor(random() * 700)::int::text, 3, '0') AS visitor,
                 string_to_array(geo[1 + floor(random() * 12)::int], '|') AS g,
                 string_to_array(src[1 + floor(random() * 10)::int], '|') AS s,
                 string_to_array(dev[1 + floor(random() * 8)::int], '|') AS dv
            FROM generate_series(1, 180) d,
                 generate_series(1, greatest(3, round((9 + 10 * (1 - d / 180.0))
                   * CASE WHEN extract(isodow FROM current_date - d) IN (6, 7) THEN 0.6 ELSE 1 END
                   + random() * 5))::int)) x;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_traffic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_traffic(uuid) TO service_role;

-- Where every visitor has been: the demo's own (Olivia browsed before
-- checking out) and one to four pages a visit for the traffic; a few
-- visits reached a goal.
CREATE OR REPLACE FUNCTION public.app_review_seed_page_views(_ws uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  page text[] := ARRAY['/', '/pricing', '/features', '/blog/live-chat-best-practices', '/integrations',
    '/products/trail-backpack-45l', '/contact', '/signup'];
BEGIN
  INSERT INTO public.visitor_page_views (workspace_id, visitor_session_id, url, title, viewed_at)
  SELECT _ws, s.id, s.current_page, public.app_review_seed_title(s.current_page),
         greatest(s.started_at, s.last_seen_at - interval '1 minute')
    FROM public.visitor_sessions s
   WHERE s.workspace_id = _ws AND s.metadata->>'app_review_traffic' IS NULL
  UNION ALL
  SELECT _ws, s.id, pv.url, public.app_review_seed_title(pv.url), now() - make_interval(mins => pv.ago)
    FROM public.visitor_sessions s
    JOIN (VALUES ('demo-olivia', '/', 25), ('demo-olivia', '/products/trail-backpack-45l', 21),
                 ('demo-olivia', '/account/orders', 12), ('demo-anon', '/', 15)) pv(v, url, ago) ON pv.v = s.visitor_id
   WHERE s.workspace_id = _ws
  UNION ALL
  SELECT _ws, s.id, x.p, public.app_review_seed_title(x.p),
         s.started_at + (s.last_seen_at - s.started_at) * ((n - 1)::float8 / 4)
    FROM public.visitor_sessions s,
         LATERAL generate_series(1, 1 + floor(random() * random() * 4)::int) n,
         LATERAL (SELECT CASE WHEN n = 1 THEN s.current_page ELSE page[1 + floor(random() * 8)::int] END AS p) x
   WHERE s.workspace_id = _ws AND s.metadata->>'app_review_traffic' = 'true';

  INSERT INTO public.web_analytics_events (workspace_id, visitor_session_id, event_name, properties, page_url, created_at)
  SELECT _ws, id, CASE WHEN random() < 0.6 THEN 'signup_click' ELSE 'demo_request' END, '{}', current_page, last_seen_at
    FROM public.visitor_sessions
   WHERE workspace_id = _ws AND metadata->>'app_review_traffic' = 'true' AND random() < 0.08;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_page_views(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_page_views(uuid) TO service_role;

-- Same name, arguments and result as 248's.
CREATE OR REPLACE FUNCTION public.app_review_seed(_password_hash text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_p   jsonb;
  v_ws  uuid;
  v_ids jsonb;
BEGIN
  v_p := public.app_review_seed_people(_password_hash);
  v_ws := public.app_review_seed_workspace(v_p, public.app_review_seed_plan());
  v_ids := jsonb_build_object('contacts', public.app_review_seed_contacts(v_ws));
  v_ids := v_ids || jsonb_build_object('visitors', public.app_review_seed_visitors(v_ws, v_ids->'contacts'));
  PERFORM public.app_review_seed_inbox(v_ws, v_p, v_ids);
  PERFORM public.app_review_seed_inbox_more(v_ws, v_p, v_ids);
  PERFORM public.app_review_seed_team(v_ws, v_p);
  PERFORM public.app_review_seed_traffic(v_ws);
  PERFORM public.app_review_seed_page_views(v_ws);

  UPDATE public.mobile_app_settings
     SET app_review_seeded_at = now(), demo_account_username = 'apple@webyar.ai';
  RETURN public.app_review_status();
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed(text) TO service_role;
