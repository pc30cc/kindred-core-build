-- 277 — Call widget design (the 2026-10 call widget): the launcher style and
-- the callback slots per workspace, on public.call_center_settings.
--
-- 1. launcher_style: one of the nine launchers (round, round_label, pill,
--    card, split, edge_tab, dark_square, operator_face, mobile_bar). The
--    CHECK is a shape only (like 275's template ids): which styles exist is
--    the code's (shared/callLauncherStyles.ts), so a new one needs no
--    migration; an unknown stored value reads as round_label.
-- 2. callback_slots_enabled: whether a visitor books a callback from slots
--    (screen 17's day chips and times) computed from business_hours. Off by
--    default, so no existing row's business_hours (a free JSON object until
--    now, read by nothing) can change a live widget when this is applied.
-- 3. callback_slot_minutes (10–240), callback_days_ahead (1–14 open days,
--    today included) and callback_slot_capacity (1–100 callbacks per slot;
--    NULL = unlimited): the slots' shape (shared/callbackSlots.ts).
-- 4. widget_position's default becomes 'right' (the five placements: right,
--    left, top_right, top_left, bottom_center). Existing rows keep their
--    value: the code reads the older spellings (bottom-right, bottom-left, …)
--    as their placement, so nothing is rewritten.
--
-- Metadata only: each ADD COLUMN has a constant default (no table rewrite),
-- the CHECKs scan the table once (one row per workspace). Locks: ACCESS
-- EXCLUSIVE on call_center_settings for an instant, once (one DO block).
-- Re-runnable: every step is guarded, and a second run takes no lock on the
-- table but the comments' (SHARE UPDATE EXCLUSIVE, which readers and writers
-- pass). Rows are
-- never inserted with these columns named (new rows take the defaults); only
-- PUT /api/call-center/settings writes them, and answers 503
-- migration_pending (not 500) while this file is not applied. Every read
-- defaults a missing column (round_label, false, 30, 4, NULL).
-- The file sets lock_timeout 5s itself (a runner without PGOPTIONS, such as
-- RESPOK's migrator, must not leave the widget's reads queued behind a lock
-- that waits for an open transaction); a statement stopped by it is simply
-- run again. Dry run: the file inside BEGIN … ROLLBACK. Changes no existing
-- row; drops nothing; touches no archive schema or table.

SET lock_timeout = '5s';

DO $$
BEGIN
  -- Only while a column is missing: a second run takes no lock here.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'call_center_settings'
         AND column_name IN ('launcher_style', 'callback_slots_enabled', 'callback_slot_minutes',
                             'callback_days_ahead', 'callback_slot_capacity')) < 5 THEN
    ALTER TABLE public.call_center_settings
      ADD COLUMN IF NOT EXISTS launcher_style text NOT NULL DEFAULT 'round_label',
      ADD COLUMN IF NOT EXISTS callback_slots_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS callback_slot_minutes smallint NOT NULL DEFAULT 30,
      ADD COLUMN IF NOT EXISTS callback_days_ahead smallint NOT NULL DEFAULT 4,
      ADD COLUMN IF NOT EXISTS callback_slot_capacity smallint;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_settings_launcher_style_check') THEN
    ALTER TABLE public.call_center_settings
      ADD CONSTRAINT call_center_settings_launcher_style_check
      CHECK (launcher_style ~ '^[a-z][a-z_]{0,31}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_settings_callback_slot_minutes_check') THEN
    ALTER TABLE public.call_center_settings
      ADD CONSTRAINT call_center_settings_callback_slot_minutes_check
      CHECK (callback_slot_minutes BETWEEN 10 AND 240);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_settings_callback_days_ahead_check') THEN
    ALTER TABLE public.call_center_settings
      ADD CONSTRAINT call_center_settings_callback_days_ahead_check
      CHECK (callback_days_ahead BETWEEN 1 AND 14);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_settings_callback_slot_capacity_check') THEN
    ALTER TABLE public.call_center_settings
      ADD CONSTRAINT call_center_settings_callback_slot_capacity_check
      CHECK (callback_slot_capacity IS NULL OR callback_slot_capacity BETWEEN 1 AND 100);
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'call_center_settings' AND column_name = 'widget_position')
     IS DISTINCT FROM '''right''::text' THEN
    ALTER TABLE public.call_center_settings ALTER COLUMN widget_position SET DEFAULT 'right';
  END IF;
END $$;

COMMENT ON COLUMN public.call_center_settings.launcher_style IS
  'The call widget launcher (round, round_label, pill, card, split, edge_tab, dark_square, operator_face, mobile_bar; shared/callLauncherStyles.ts). Shape-checked only; an unknown value reads as round_label. Migration 277.';
COMMENT ON COLUMN public.call_center_settings.callback_slots_enabled IS
  'Visitors book callbacks from slots computed from business_hours (shared/callbackSlots.ts). Off by default: business_hours alone never turns slots on. Migration 277.';
COMMENT ON COLUMN public.call_center_settings.callback_slot_minutes IS
  'Callback slot length in minutes (10-240). Migration 277.';
COMMENT ON COLUMN public.call_center_settings.callback_days_ahead IS
  'Open days offered for callback slots, today included (1-14). Migration 277.';
COMMENT ON COLUMN public.call_center_settings.callback_slot_capacity IS
  'Callbacks per slot (1-100); NULL = unlimited. A soft limit, checked when a visitor books. Migration 277.';

RESET lock_timeout;
