-- ============================================================
-- Operator-presence fallback state: explicit roster completeness.
-- Forward-only, idempotent.
--
-- WHY: the transition roster is bounded. Silently truncating it would mark
-- every operator past the cap offline. Instead an oversized (or unknown)
-- roster is stored as INCOMPLETE and the handoff fails open for that
-- workspace until the first fallback heartbeat lands.
--
-- The global breaker row NEVER carries a roster: it only states that
-- Centrifugo presence is unavailable, so one workspace's roster can never
-- be applied to another workspace.
-- ============================================================

ALTER TABLE public.operator_presence_fallback_state
  ADD COLUMN IF NOT EXISTS roster_complete boolean NOT NULL DEFAULT false;
