-- ============================================================
-- THREE MORE PUSH SWITCHES, ONE PER KIND OF EVENT
--
-- Hosted twin: supabase/migrations/20260928160000_notification_prefs_event_switches.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- The phone now hears about more than customer messages, and each new kind
-- of event gets its own switch on `user_notification_prefs`, read by
-- server/services/push/recipients.ts and set from the app's Notification
-- settings (GET/PATCH /api/notifications/prefs):
--
--   • push_team_chat   — a colleague's direct message in team chat
--   • push_assignments — a conversation handed to me: by a colleague, by
--                        automatic routing, or by the AI letting go of it
--   • push_email       — a new email in the workspace's shared inbox
--                        (for those whose scope is "all conversations")
--
-- Default on, like every push switch before them: an operator who has never
-- opened the page gets the notifications, and turns off what they don't
-- want. Additive and idempotent.
-- ============================================================

ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS push_team_chat boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_assignments boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_email boolean NOT NULL DEFAULT true;
