
-- Admin: get full workspace details
CREATE OR REPLACE FUNCTION public.admin_get_workspace_detail(_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _result jsonb;
BEGIN
  -- Only global admins
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'workspace', row_to_json(w.*),
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', wm.id,
        'user_id', wm.user_id,
        'role', wm.role,
        'created_at', wm.created_at,
        'email', p.email,
        'full_name', p.full_name
      ))
      FROM workspace_members wm
      LEFT JOIN profiles p ON p.id = wm.user_id
      WHERE wm.workspace_id = w.id
    ), '[]'::jsonb),
    'branding', (SELECT row_to_json(wb.*) FROM workspace_branding wb WHERE wb.workspace_id = w.id),
    'widget_settings', (SELECT row_to_json(ws.*) FROM widget_settings ws WHERE ws.workspace_id = w.id),
    'contact_count', (SELECT count(*) FROM contacts c WHERE c.workspace_id = w.id),
    'conversation_count', (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id)
  ) INTO _result
  FROM workspaces w
  WHERE w.id = _workspace_id;

  RETURN _result;
END;
$$;

-- Admin: delete a workspace and all related data
CREATE OR REPLACE FUNCTION public.admin_delete_workspace(_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only global admins
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Verify workspace exists
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = _workspace_id) THEN
    RAISE EXCEPTION 'Workspace not found';
  END IF;

  -- Delete related data (order matters for FK constraints)
  DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = _workspace_id);
  DELETE FROM conversations WHERE workspace_id = _workspace_id;
  DELETE FROM contacts WHERE workspace_id = _workspace_id;
  DELETE FROM visitor_presence WHERE workspace_id = _workspace_id;
  DELETE FROM visitor_sessions WHERE workspace_id = _workspace_id;
  DELETE FROM widget_settings WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_branding WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_branding_localized WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_domains WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_domains_extended WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_settings WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_members WHERE workspace_id = _workspace_id;
  DELETE FROM knowledge_base_articles WHERE workspace_id = _workspace_id;
  DELETE FROM knowledge_base_categories WHERE workspace_id = _workspace_id;
  DELETE FROM email_logs WHERE workspace_id = _workspace_id;
  DELETE FROM email_settings WHERE workspace_id = _workspace_id;
  DELETE FROM email_settings_localized WHERE workspace_id = _workspace_id;
  DELETE FROM email_templates WHERE workspace_id = _workspace_id;
  DELETE FROM provider_configs WHERE workspace_id = _workspace_id;
  DELETE FROM audit_logs WHERE workspace_id = _workspace_id;
  DELETE FROM ai_usage_logs WHERE workspace_id = _workspace_id;
  DELETE FROM billing_payments WHERE workspace_id = _workspace_id;
  DELETE FROM billing_events WHERE workspace_id = _workspace_id;
  DELETE FROM feature_flags WHERE workspace_id = _workspace_id;
  DELETE FROM translations WHERE workspace_id = _workspace_id;
  DELETE FROM storage_usage_logs WHERE workspace_id = _workspace_id;
  DELETE FROM security_events WHERE workspace_id = _workspace_id;

  -- Finally delete the workspace itself
  DELETE FROM workspaces WHERE id = _workspace_id;

  RETURN true;
END;
$$;
