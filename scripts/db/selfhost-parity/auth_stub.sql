create extension if not exists pg_stat_statements;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users(
  id uuid primary key default gen_random_uuid(), instance_id uuid, aud text, role text,
  email text, encrypted_password text, email_confirmed_at timestamptz, phone text,
  phone_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb, last_sign_in_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  deleted_at timestamptz, is_sso_user boolean default false, is_anonymous boolean default false,
  banned_until timestamptz, confirmed_at timestamptz);
create table if not exists auth.sessions(id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade, created_at timestamptz default now(),
  updated_at timestamptz, user_agent text, ip inet, not_after timestamptz, refreshed_at timestamp, aal text, factor_id uuid, tag text);
create table if not exists auth.schema_migrations(version text primary key);
insert into auth.schema_migrations values ('stub') on conflict do nothing;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(current_setting('request.jwt.claim.sub',true),(current_setting('request.jwt.claims',true)::jsonb->>'sub')),'')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role',true),(current_setting('request.jwt.claims',true)::jsonb->>'role')) $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create or replace function extensions.gen_random_bytes(int) returns bytea language sql as $$ select public.gen_random_bytes($1) $$;
-- Supabase platform default privileges (supabase/postgres image / hosted projects)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
