-- claim_conversation is SECURITY DEFINER and trusts its p_user_id /
-- p_workspace_id arguments with no internal auth.uid() check — it is only
-- ever meant to be called server-side (service role) after the caller has
-- already been verified as a member of the target workspace
-- (server/routes/conversations.ts authorizeWorkspaceMember,
-- server/services/chatRouting.ts). Supabase grants EXECUTE on newly
-- created public-schema functions to anon/authenticated via default
-- privileges — REVOKE ... FROM public in the original migration did not
-- remove those direct grants (confirmed via information_schema.routine_privileges
-- after applying 20260807132846_chat_routing_assignment.sql). Close that off
-- explicitly so this can never be called directly via PostgREST by a
-- browser/visitor client to hijack a conversation in an arbitrary workspace.
REVOKE EXECUTE ON FUNCTION public.claim_conversation(uuid, uuid, uuid, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_conversation(uuid, uuid, uuid, boolean) FROM authenticated;
