
-- Phase 7.6 — Enforcement priority + normalization audit

-- 1. Priority column on enforcement_rules (higher = applied first)
ALTER TABLE public.enforcement_rules
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;

ALTER TABLE public.enforcement_rules
  DROP CONSTRAINT IF EXISTS enforcement_rules_priority_range;
ALTER TABLE public.enforcement_rules
  ADD CONSTRAINT enforcement_rules_priority_range
  CHECK (priority BETWEEN 0 AND 1000);

CREATE INDEX IF NOT EXISTS enforcement_rules_priority_idx
  ON public.enforcement_rules (priority DESC);

-- 2. Seed sensible priority defaults for built-in rules.
UPDATE public.enforcement_rules SET priority = 900
  WHERE slug = 'health_score_critical' AND is_builtin = true;
UPDATE public.enforcement_rules SET priority = 800
  WHERE slug = 'platform_uptime_breach_degraded' AND is_builtin = true;
UPDATE public.enforcement_rules SET priority = 700
  WHERE slug = 'health_score_warning' AND is_builtin = true;
UPDATE public.enforcement_rules SET priority = 500
  WHERE slug = 'frt_p95_breach_throttle' AND is_builtin = true;
UPDATE public.enforcement_rules SET priority = 400
  WHERE slug = 'alert_rate_high_priority_only' AND is_builtin = true;

-- 3. Normalization audit table
CREATE TABLE IF NOT EXISTS public.enforcement_normalizations (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cycle_ran_at    timestamptz NOT NULL DEFAULT now(),
  raw_actions     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  normalized_actions jsonb    NOT NULL DEFAULT '[]'::jsonb,
  reasons         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  context         jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS enforcement_normalizations_created_idx
  ON public.enforcement_normalizations (created_at DESC);

ALTER TABLE public.enforcement_normalizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read enforcement_normalizations" ON public.enforcement_normalizations;
CREATE POLICY "Admins read enforcement_normalizations" ON public.enforcement_normalizations
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Server-only writes via service role.

-- 4. Allow priority editing on the builtin protection trigger.
-- The protect_builtin trigger only restricts shape (slug/title/condition_json/actions_json/trigger_type/is_builtin).
-- Priority is a tunable property, so no trigger change is needed if the trigger only blocks those fields.
-- Verify: re-create trigger to be explicit.
CREATE OR REPLACE FUNCTION public.enforcement_rules_protect_builtin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_builtin THEN
    IF NEW.slug          IS DISTINCT FROM OLD.slug          THEN RAISE EXCEPTION 'cannot rename builtin rule slug'; END IF;
    IF NEW.trigger_type  IS DISTINCT FROM OLD.trigger_type  THEN RAISE EXCEPTION 'cannot change builtin rule trigger_type'; END IF;
    IF NEW.condition_json IS DISTINCT FROM OLD.condition_json THEN RAISE EXCEPTION 'cannot change builtin rule condition_json'; END IF;
    IF NEW.actions_json  IS DISTINCT FROM OLD.actions_json  THEN RAISE EXCEPTION 'cannot change builtin rule actions_json'; END IF;
    IF NEW.is_builtin    IS DISTINCT FROM OLD.is_builtin    THEN RAISE EXCEPTION 'cannot toggle is_builtin'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
