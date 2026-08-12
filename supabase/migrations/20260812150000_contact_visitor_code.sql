-- 021 — Stable anonymous display code for contacts.
--
-- Operator surfaces must never show a raw contact id, and the ad-hoc
-- `metadata.anon_code` hash (server/services/widget/anonymousContact.ts) has
-- no uniqueness guarantee and was never set on the identity-merge creation
-- path (server/services/widget/identityMerge.ts). This adds a real column so
-- the code can be generated once, retried on collision, and enforced unique
-- per workspace — the same scope contacts already dedupe email/phone on.
--
-- Nullable, no backfill: existing anonymous contacts get their code lazily
-- the next time they're touched through ensureVisitorContact() or
-- mergeVisitorIdentity() (both updated alongside this migration), so this
-- migration is a plain metadata-only ALTER TABLE — no table rewrite, no lock
-- beyond the instant one for adding a nullable column.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS visitor_code text;

-- Partial + workspace-scoped: mirrors how email/phone lookups in
-- ensureVisitorContact/mergeVisitorIdentity are already scoped, and NULL
-- (not-yet-generated) contacts never collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_visitor_code_idx
  ON public.contacts (workspace_id, visitor_code)
  WHERE visitor_code IS NOT NULL;
