-- 222: BRIN indexes on conversation_messages.created_at and
-- conversations.created_at, built without blocking writes.
--
-- business_metrics_rollup_and_prune() — the heaviest query the API issues —
-- selects messages and conversations by created_at range (the previous hour,
-- and messages from the last seven hours for first-response times). Neither
-- table has an index that leads with created_at, so every run scanned both
-- in full. Both are append-mostly, so created_at follows physical order and
-- a BRIN index answers those ranges for a tiny fraction of a btree's size
-- and upkeep: it stores one min/max summary per 128 pages, and an insert
-- only widens the summary of the page it lands on.
--
-- CONCURRENTLY: scripts/migrate-database.sh and CI apply this chain with
-- `psql -f` outside a transaction block, so messages keep flowing while the
-- index builds. (The hosted mirror runs inside a transaction and cannot; it
-- builds only on small tables and otherwise prints this file's command.)
--
-- A failed CONCURRENTLY build leaves an INVALID index behind under its name,
-- which IF NOT EXISTS would then skip forever while writes keep maintaining
-- it. Clear such a leftover first so a re-run builds a usable one.

do $$
declare
  v_name text;
begin
  foreach v_name in array array['idx_conversation_messages_created_brin', 'idx_conversations_created_brin'] loop
    if exists (
      select 1
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = v_name
         and not i.indisvalid
    ) then
      execute format('drop index public.%I', v_name);
    end if;
  end loop;
end;
$$;

create index concurrently if not exists idx_conversation_messages_created_brin
  on public.conversation_messages using brin (created_at);

create index concurrently if not exists idx_conversations_created_brin
  on public.conversations using brin (created_at);
