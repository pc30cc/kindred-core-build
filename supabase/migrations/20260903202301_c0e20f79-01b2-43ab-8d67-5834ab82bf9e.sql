alter function public.admin_reset_identity_tables() set search_path = public;
alter function public.admin_reset_settings_tables() set search_path = public;
alter function public.admin_reset_preserved_tables(text) set search_path = public;
revoke all on function public.admin_reset_identity_tables() from public, anon, authenticated;
revoke all on function public.admin_reset_settings_tables() from public, anon, authenticated;
revoke all on function public.admin_reset_preserved_tables(text) from public, anon, authenticated;
revoke all on function public.admin_reset_target_tables(text) from public, anon, authenticated;
grant execute on function public.admin_reset_target_tables(text) to service_role;