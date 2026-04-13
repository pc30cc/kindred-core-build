-- Migration: 004_seed_defaults.sql
-- Default feature flags and system configuration.
-- Run AFTER 001, 002, 003.

-- Default feature flags (global, no workspace)
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('widget', true, 'Enable embeddable widget system'),
  ('knowledge_base', true, 'Enable knowledge base / help center'),
  ('visitor_tracking', true, 'Enable visitor tracking and online presence'),
  ('ai_assistant', false, 'Enable AI-powered chat assistant'),
  ('email_campaigns', false, 'Enable email campaign features'),
  ('billing', false, 'Enable billing and subscription management')
ON CONFLICT DO NOTHING;
