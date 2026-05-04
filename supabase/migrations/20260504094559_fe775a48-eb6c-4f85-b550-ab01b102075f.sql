-- Target (oldest) conversation
DO $$
DECLARE
  target_id uuid := 'e92a8332-2a17-429f-9b38-f60cf3449544';
  dup_ids uuid[] := ARRAY['09ee273d-b87e-4c54-ac53-02baade242d5'::uuid, 'c6bd5174-3b20-48e4-be05-39fa882c601e'::uuid];
BEGIN
  -- Move messages
  UPDATE conversation_messages SET conversation_id = target_id WHERE conversation_id = ANY(dup_ids);

  -- Move notes if table exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_notes') THEN
    EXECUTE format('UPDATE conversation_notes SET conversation_id = %L WHERE conversation_id = ANY(%L::uuid[])', target_id, dup_ids);
  END IF;

  -- Move events if table exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_events') THEN
    EXECUTE format('UPDATE conversation_events SET conversation_id = %L WHERE conversation_id = ANY(%L::uuid[])', target_id, dup_ids);
  END IF;

  -- Move attachments if table exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversation_attachments') THEN
    EXECUTE format('UPDATE conversation_attachments SET conversation_id = %L WHERE conversation_id = ANY(%L::uuid[])', target_id, dup_ids);
  END IF;

  -- Close & flag the duplicates
  UPDATE conversations
  SET status = 'closed',
      updated_at = now(),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('merged_into', target_id::text, 'merged_at', now()::text)
  WHERE id = ANY(dup_ids);

  -- Bump target updated_at to reflect latest merged activity
  UPDATE conversations SET updated_at = now() WHERE id = target_id;
END $$;