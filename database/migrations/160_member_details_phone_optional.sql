-- =========================================================================
-- Team invitations — phone number is optional
-- =========================================================================
-- The invite form no longer collects a contact phone, and
-- workspace_invitations.invited_phone_e164 is nullable. But
-- workspace_member_details.work_phone_e164 was still NOT NULL, so accepting
-- an invitation with an existing account failed inside
-- accept_invitation_existing_user_v2 with a raw 23502 error, surfaced to the
-- browser as a generic network failure.
-- =========================================================================

ALTER TABLE public.workspace_member_details
  ALTER COLUMN work_phone_e164 DROP NOT NULL;
