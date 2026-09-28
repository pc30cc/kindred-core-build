-- ============================================================
-- THE iOS APP'S AI AND COLLEAGUES INBOX TABS
--
-- Self-host mirror: database/migrations/230_mobile_app_ios_inbox_tabs.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Two more switches on the `mobile_app_settings` singleton, set in Super
-- Admin → Mobile App → iOS → In-app settings and read by the app from
-- GET /api/mobile-app/config?platform=ios (showAIQueue, showColleagues):
--
--   • ios_app_show_ai_queue    — the Inbox's "AI" tab and the AI queue
--   • ios_app_show_colleagues  — the Inbox's "Colleagues" tab (team chat)
--
-- A switch can only take a tab away: the workspace's plan still decides
-- whether it has it at all (the AI queue: inbox_ai_queue, with the AI agent
-- on; Colleagues: inbox_team_chat).
--
-- Additive and idempotent; both default on, so applying this file changes
-- nothing until someone turns one off.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_app_show_ai_queue boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ios_app_show_colleagues boolean NOT NULL DEFAULT true;
