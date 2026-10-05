-- Reset before every parity case: the same rows, the same identity values.
TRUNCATE pgrst_parity.child, pgrst_parity.profile, pgrst_parity.member, pgrst_parity.workspace,
         pgrst_parity.kv, pgrst_parity.parent RESTART IDENTITY CASCADE;

INSERT INTO pgrst_parity.parent (id, name, meta, tags, n, status, doc) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alpha', '{"k": "v", "num": 5}', '{a,b}', 7, 'open', to_tsvector('simple', 'alpha first')),
  ('22222222-2222-2222-2222-222222222222', 'beta', NULL, NULL, 1, 'closed', to_tsvector('simple', 'beta second')),
  ('33333333-3333-3333-3333-333333333333', 'gamma', '{"k": "w"}', '{c}', 7, 'open', NULL);

INSERT INTO pgrst_parity.child (parent_id, other_parent_id, label, score, payload, sent_at) VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'c1', 1.5, '{"message_id": "m1"}', '2026-02-01T00:00:00Z'),
  ('11111111-1111-1111-1111-111111111111', NULL, 'c2', 2, NULL, NULL),
  ('22222222-2222-2222-2222-222222222222', NULL, 'c3', NULL, '[1, 2]', '2026-04-01T00:00:00Z');

INSERT INTO pgrst_parity.profile (parent_id, note) VALUES
  ('11111111-1111-1111-1111-111111111111', 'one-note');

INSERT INTO pgrst_parity.workspace (id, slug, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'one', 'Workspace One'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'two', 'Workspace Two');

INSERT INTO pgrst_parity.member (workspace_id, user_name, role, settings) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ann', 'owner', '{"theme": "dark"}'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bob', 'agent', NULL),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'cat', 'viewer', NULL);

INSERT INTO pgrst_parity.kv (key, value, updated_at) VALUES
  ('k1', '{"a": 1}', '2026-01-01T00:00:00Z'),
  ('lease', '{"lease_until": "2026-01-15T00:00:00Z"}', '2026-01-01T00:00:00Z');
