-- 282 — An operator's own "Away from desk" (audit finding R-26).
--
-- What it adds: user_availability_prefs.manual_away. The account menu's
-- status offers Online / Away from desk / Offline; until now the server had
-- only the two switches that both mean offline (force_offline, "Appear
-- offline", and available_when_using_app = false, invisible), so "Away" could
-- only be the automatic idle state. An operator who sets themselves Away
-- (manual_away = true):
--   - gets no new chats from automatic routing: not as the visitor's previous
--     operator, not from the team or a department, not as the owner fallback
--     (server/services/chatRouting.ts routingTierOf);
--   - keeps the conversations they already hold;
--   - does not make the widget "online" (customer-facing availability reads
--     it as unavailable, server/services/widget/customerAvailability.ts);
--   - shows to teammates as away while a panel or app of theirs is open.
-- "Appear offline" and invisible still win over it. A client that knows only
-- force_offline (the desktop and phone apps today) clears it whenever it
-- writes force_offline, so their Online/Offline switch means what it says.
--
-- Locks: ADD COLUMN with a constant default is metadata only on PostgreSQL 11
-- and later (no table rewrite, no scan): ACCESS EXCLUSIVE on the table for an
-- instant, and none on a second run (IF NOT EXISTS). Every existing row reads
-- false, i.e. exactly what it meant before. The file sets lock_timeout 5s
-- itself (RESPOK's migrator runs without PGOPTIONS); a statement stopped by
-- it is simply run again. Dry run: the file inside BEGIN … ROLLBACK. Drops
-- nothing; touches no archive schema or table; grants and row security of
-- the table are unchanged (the backend reads and writes it as service_role).

SET lock_timeout = '5s';

ALTER TABLE public.user_availability_prefs
  ADD COLUMN IF NOT EXISTS manual_away boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_availability_prefs.manual_away IS
  'The operator chose "Away from desk": no new automatic chats, keeps the ones they hold, unavailable to visitors. force_offline and available_when_using_app = false take precedence. Migration 282.';
