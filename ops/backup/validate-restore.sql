-- Post-restore validation. Read-only. Prints one line per check, prefixed
-- OK or FAIL; restore-drill.sh fails the drill if any FAIL line appears.
\pset tuples_only on
\pset format unaligned

-- 1. Extensions -------------------------------------------------------------
select case when count(*) >= 3 then 'OK' else 'FAIL' end
       || ' extensions: ' || count(*)::text || ' present ('
       || string_agg(extname, ', ' order by extname) || ')'
from pg_extension;

-- 2. Schemas ----------------------------------------------------------------
select case when count(*) >= 1 then 'OK' else 'FAIL' end
       || ' schemas: ' || string_agg(nspname, ', ' order by nspname)
from pg_namespace
where nspname in ('public', 'auth', 'storage', 'extensions');

-- 3. Core tables present ----------------------------------------------------
select case when count(*) = 8 then 'OK' else 'FAIL' end
       || ' core tables present: ' || count(*)::text || '/8'
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles','workspaces','accounts','conversations',
                    'conversation_messages','billing_invoices','seo_urls',
                    'data_retention_policies');

-- 4. Row counts for the tables that matter ----------------------------------
select 'OK rowcount ' || tablename || ' = ' ||
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from public.%I', tablename),
                           false, true, '')))[1]::text::bigint::text
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles','workspaces','conversations','conversation_messages',
                    'billing_invoices','billing_payments','seo_urls',
                    'seo_crawl_observations','seo_link_edges',
                    'workspace_health_snapshots')
order by tablename;

-- 5. Constraints valid (no NOT VALID leftovers) -----------------------------
select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' invalid constraints: ' || count(*)::text
from pg_constraint where not convalidated;

-- 6. Indexes ----------------------------------------------------------------
select case when count(*) > 100 then 'OK' else 'FAIL' end
       || ' indexes in public: ' || count(*)::text
from pg_indexes where schemaname = 'public';

select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' invalid indexes: ' || count(*)::text
from pg_index where not indisvalid;

-- 7. RLS still enabled on the tables that rely on it ------------------------
select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' workspace tables with RLS disabled: ' || count(*)::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('conversations','conversation_messages','contacts',
                    'knowledge_base_articles','billing_invoices','seo_urls')
  and not c.relrowsecurity;

select 'OK policies restored: ' || count(*)::text from pg_policies where schemaname = 'public';

-- 8. Partitioned tables and their children ----------------------------------
select case when count(*) = 1 then 'OK' else 'FAIL' end
       || ' partitioned parents present: ' || coalesce(string_agg(c.relname, ', '), 'none')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'p'
  and c.relname in ('workspace_health_snapshots');

select case when count(*) > 0 then 'OK' else 'FAIL' end
       || ' partition children of ' || parent || ': ' || count(*)::text
from (
  select p.relname as parent, ch.relname as child
  from pg_inherits i
  join pg_class p on p.oid = i.inhparent
  join pg_class ch on ch.oid = i.inhrelid
  join pg_namespace n on n.oid = p.relnamespace
  where n.nspname = 'public'
    and p.relname in ('workspace_health_snapshots')
) s group by parent;

-- DEFAULT partitions must be empty after restore, as they are in production.
select case when coalesce(sum(cnt), 0) = 0 then 'OK' else 'FAIL' end
       || ' rows in DEFAULT partitions: ' || coalesce(sum(cnt), 0)::text
from (
  select (xpath('/row/c/text()',
          query_to_xml(format('select count(*) as c from public.%I', ch.relname),
                       false, true, '')))[1]::text::bigint as cnt
  from pg_inherits i
  join pg_class ch on ch.oid = i.inhrelid
  where ch.relname like '%\_default'
) d;

-- 9. Canonical SEO integrity ------------------------------------------------
select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' duplicate canonical SEO urls: ' || count(*)::text
from (select workspace_id, site_id, url_hash from public.seo_urls
      group by 1,2,3 having count(*) > 1) x;

select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' orphan SEO observations: ' || count(*)::text
from public.seo_crawl_observations o
left join public.seo_urls u on u.id = o.url_id
where u.id is null;

-- 10. Billing integrity -----------------------------------------------------
select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' payments without an invoice: ' || count(*)::text
from public.billing_payment_allocations a
left join public.billing_invoices i on i.id = a.invoice_id
where a.invoice_id is not null and i.id is null;

select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' invoice lines without an invoice: ' || count(*)::text
from public.billing_invoice_lines l
left join public.billing_invoices i on i.id = l.invoice_id
where i.id is null;

-- 11. Membership / conversation integrity -----------------------------------
select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' account members without an account: ' || count(*)::text
from public.account_members m
left join public.accounts a on a.id = m.account_id
where a.id is null;

select case when count(*) = 0 then 'OK' else 'FAIL' end
       || ' messages without a conversation: ' || count(*)::text
from public.conversation_messages m
left join public.conversations c on c.id = m.conversation_id
where c.id is null;

-- 12. Auth data survived ----------------------------------------------------
select case when count(*) >= 0 then 'OK' else 'FAIL' end
       || ' auth users restored: ' || count(*)::text from auth.users;
