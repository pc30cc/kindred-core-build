-- Source data for scripts/ci/move-data-test.sh, on a database built by
-- scripts/migrate-database.sh. Shaped like production: users with first-party
-- credentials, workspaces created the normal way (their triggers seed billing
-- rows), chat, visitors, an identity sequence ahead of its rows, embeddings
-- (when the server has pgvector), Persian text, tabs, newlines and
-- backslashes, and production's known oddities: an account whose owner has no
-- profile, audit rows with no workspace. Then rows that reference each other
-- in a cycle (subscription <-> period <-> invoice) and a self-referencing pair
-- whose first row on disk points at a later one.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO profiles (id, email, full_name, preferred_locale, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test', 'مالک «آزمایشی»', 'fa', '2025-01-02 03:04:05.123456+00'),
  ('00000000-0000-0000-0000-0000000000a2', 'agent@example.test', E'Agent\twith\ttabs\nand a newline \\ backslash', 'en', '2025-02-03 04:05:06+00'),
  ('00000000-0000-0000-0000-0000000000a3', 'third@example.test', NULL, NULL, now());
INSERT INTO user_credentials (user_id, password_hash, password_algo, status, failed_login_count)
SELECT id, 'scrypt$placeholder$' || md5(id::text), 'scrypt', 'active', 0 FROM profiles;
INSERT INTO accounts (id, name, slug, owner_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Acme', 'acme', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'Orphan', 'orphan', '00000000-0000-0000-0000-00000000dead');
INSERT INTO account_members (account_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000dead', 'owner');
INSERT INTO workspaces (id, name, slug, owner_id, account_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'وب‌یار اصلی', 'main-ws', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c2', 'Second', 'second-ws', '00000000-0000-0000-0000-0000000000a2', NULL);
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2', 'agent'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', 'owner')
ON CONFLICT DO NOTHING;
INSERT INTO contacts (id, workspace_id, name, email, tags, metadata) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'مشتری ۱', 'c1@example.test', ARRAY['vip','تست'], '{"nested": {"a": [1, 2.5, null, "x"]}, "z": true}'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', NULL, NULL, '{}', NULL);
INSERT INTO visitor_sessions (id, workspace_id, visitor_id, contact_id, geo_latitude, geo_longitude, started_at)
VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'v-1', '00000000-0000-0000-0000-0000000000d1', 35.6891975, 51.3889736, '2025-03-01 10:00:00+00');
INSERT INTO conversations (id, workspace_id, contact_id, visitor_session_id, subject, tags, metadata)
VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'سلام', ARRAY['a'], '{"k": 1}');
INSERT INTO conversation_messages (conversation_id, sender_type, sender_id, body, created_at)
SELECT '00000000-0000-0000-0000-0000000000f1', CASE WHEN g % 2 = 0 THEN 'contact' ELSE 'agent' END::sender_type,
       CASE WHEN g % 2 = 0 THEN NULL ELSE '00000000-0000-0000-0000-0000000000a2'::uuid END,
       'پیام شماره ' || g || E' — ‌ نیم‌فاصله', '2025-03-01 10:00:00+00'::timestamptz + g * interval '1 minute'
  FROM generate_series(1, 200) g;
INSERT INTO visitor_page_views (workspace_id, visitor_session_id, url, title, viewed_at)
SELECT '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '/p/' || g, NULL, '2025-03-01'::timestamptz + g * interval '1 second'
  FROM generate_series(1, 500) g;
DELETE FROM visitor_page_views WHERE id % 7 = 0 OR id > (SELECT max(id) - 10 FROM visitor_page_views);  -- gaps, and the sequence ahead of max(id)
INSERT INTO bot_log_imports (id, workspace_id, filename, format) VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000c1', 'access.log', 'nginx');
INSERT INTO bot_visits (workspace_id, import_id, bot_name, bot_category, user_agent, path, visited_at)
SELECT '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000101', 'GPTBot', 'ai', 'Mozilla/5.0', '/x/' || g, now() FROM generate_series(1, 50) g;
DO $kb$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.ai_knowledge_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped) THEN
    EXECUTE $q$
      INSERT INTO ai_knowledge_chunks (workspace_id, source_type, source_id, title, content, content_hash, embedding)
      SELECT '00000000-0000-0000-0000-0000000000c1', 'qna', 'doc-' || g, 'Doc ' || g, 'محتوا ' || g, md5(g::text),
             (SELECT array_agg(round((sin(g * 1000 + i))::numeric, 6)::real) FROM generate_series(1, 1536) i)::vector
        FROM generate_series(1, 20) g$q$;
  ELSE  -- a server without pgvector: the chain leaves the column out
    INSERT INTO ai_knowledge_chunks (workspace_id, source_type, source_id, title, content, content_hash)
    SELECT '00000000-0000-0000-0000-0000000000c1', 'qna', 'doc-' || g, 'Doc ' || g, 'محتوا ' || g, md5(g::text)
      FROM generate_series(1, 20) g;
  END IF;
END
$kb$;
INSERT INTO audit_logs (workspace_id, user_id, action, entity_type, old_value, new_value)
SELECT NULL, '00000000-0000-0000-0000-0000000000a1', 'platform.settings.update', 'platform_settings', '{"a": 1}', '{"a": 2}' FROM generate_series(1, 6);
COMMIT;

BEGIN;
INSERT INTO workspace_subscriptions (id, workspace_id, plan_id, status, billing_interval)
VALUES ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-0000000000c1', (SELECT id FROM billing_plans WHERE name = 'Pro'), 'active', 'monthly');
INSERT INTO billing_invoices (id, workspace_id, subscription_id, invoice_number, invoice_type, status, subtotal_irr, total_irr, amount_paid_irr, amount_due_irr)
VALUES ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000201', 'INV-0001', 'new_subscription', 'paid', 1000, 1000, 1000, 0);
INSERT INTO billing_subscription_periods (id, workspace_id, subscription_id, invoice_id, period_start, period_end, status, source, ai_allowance_irr)
VALUES ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000202', '2025-01-01', '2025-02-01', 'active', 'invoice', 0);
UPDATE workspace_subscriptions SET current_period_id = '00000000-0000-0000-0000-000000000203', v2_allowance_effective_period_id = '00000000-0000-0000-0000-000000000203'
 WHERE id = '00000000-0000-0000-0000-000000000201';
INSERT INTO team_messages (id, workspace_id, sender_id, recipient_id, body) VALUES
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'first'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'reply');
UPDATE team_messages SET reply_to_id = '00000000-0000-0000-0000-000000000301' WHERE id = '00000000-0000-0000-0000-000000000302';
UPDATE team_messages SET reply_to_id = '00000000-0000-0000-0000-000000000302' WHERE id = '00000000-0000-0000-0000-000000000301';
COMMIT;
