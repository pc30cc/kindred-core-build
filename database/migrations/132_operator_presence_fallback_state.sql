-- ============================================================
-- Shared operator-presence fallback (circuit-breaker) state.
-- Forward-only, idempotent.
--
-- WHY: live presence is realtime-first (Centrifugo channel membership) and
-- performs ZERO PostgreSQL writes while healthy. When a presence read fails,
-- the heartbeat must resume refreshing the `operator_presence_live` lease —
-- but that decision was process-local, so instance B kept skipping writes
-- while instance A was already in fallback.
--
-- This table is the smallest possible shared signal:
--   * at most one row per failing scope ('global' or a workspace id),
--   * written ONLY on activation / renewal / recovery (never per heartbeat),
--   * auto-expiring, so a forgotten row cannot pin the platform in
--     high-write fallback forever,
--   * `roster` carries the last known-good connected operators so a
--     transition can hand off even when no DB lease row exists yet.
--
-- Service-role only: this is backend circuit-breaker state, never client data.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.operator_presence_fallback_state (
  scope text PRIMARY KEY,
  reason text,
  roster jsonb NOT NULL DEFAULT '[]'::jsonb,
  activated_at timestamptz NOT NULL DEFAULT now(),
  handoff_until timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_presence_fallback_expires
  ON public.operator_presence_fallback_state (expires_at);

GRANT ALL ON public.operator_presence_fallback_state TO service_role;

ALTER TABLE public.operator_presence_fallback_state ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authenticated have no grants and no access.
