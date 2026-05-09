-- E12-Fix Phase 1 — Make platform_ai_agent_settings a true singleton.
--
-- Idempotent: safe to run multiple times. Adds singleton_key column with
-- a CHECK + UNIQUE constraint, dedupes any historical duplicates, and
-- guarantees exactly one canonical row exists.

DO $$
BEGIN
  -- Add column if missing.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_ai_agent_settings'
      AND column_name = 'singleton_key'
  ) THEN
    ALTER TABLE public.platform_ai_agent_settings
      ADD COLUMN singleton_key boolean NOT NULL DEFAULT true;
  END IF;
END $$;

-- Dedupe: keep most recently updated row, drop the rest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST) AS rn
  FROM public.platform_ai_agent_settings
)
DELETE FROM public.platform_ai_agent_settings
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Force the surviving row to singleton_key=true.
UPDATE public.platform_ai_agent_settings SET singleton_key = true;

-- Add CHECK constraint (singleton_key must be true) — idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_ai_agent_settings_singleton_check'
  ) THEN
    ALTER TABLE public.platform_ai_agent_settings
      ADD CONSTRAINT platform_ai_agent_settings_singleton_check
      CHECK (singleton_key = true);
  END IF;
END $$;

-- Add UNIQUE constraint on singleton_key — idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_ai_agent_settings_singleton_unique'
  ) THEN
    ALTER TABLE public.platform_ai_agent_settings
      ADD CONSTRAINT platform_ai_agent_settings_singleton_unique
      UNIQUE (singleton_key);
  END IF;
END $$;

-- Ensure exactly one row exists (insert if table is empty).
INSERT INTO public.platform_ai_agent_settings (id, singleton_key)
SELECT gen_random_uuid(), true
WHERE NOT EXISTS (SELECT 1 FROM public.platform_ai_agent_settings);