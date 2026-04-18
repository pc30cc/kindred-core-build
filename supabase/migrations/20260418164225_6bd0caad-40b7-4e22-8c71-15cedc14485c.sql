-- Allow workspace admins/owners to delete conversations and their messages
CREATE POLICY "Admins+ can delete conversations"
ON public.conversations
FOR DELETE
TO authenticated
USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Admins+ can delete messages"
ON public.conversation_messages
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_messages.conversation_id
      AND get_workspace_role(c.workspace_id, auth.uid()) IN ('owner', 'admin')
  )
);