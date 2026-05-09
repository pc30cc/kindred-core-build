CREATE OR REPLACE FUNCTION public.business_metrics_rollup_and_prune()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  bucket      timestamptz := date_trunc('hour', now()) - interval '1 hour';
  bucket_end  timestamptz := bucket + interval '1 hour';
  rolled      integer := 0;
  pruned      integer := 0;
BEGIN
  WITH conv_window AS (
    SELECT c.id, c.workspace_id, c.created_at, c.updated_at, c.status
      FROM public.conversations c
     WHERE c.created_at >= bucket AND c.created_at < bucket_end
  ),
  resolved_window AS (
    SELECT c.workspace_id, c.id,
           EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) AS dur_s
      FROM public.conversations c
     WHERE c.status = 'resolved'
       AND c.updated_at >= bucket AND c.updated_at < bucket_end
  ),
  msgs_window AS (
    SELECT cm.id, cm.conversation_id, cm.sender_type, cm.created_at, cm.sender_id,
           c.workspace_id
      FROM public.conversation_messages cm
      JOIN public.conversations c ON c.id = cm.conversation_id
     WHERE cm.created_at >= bucket AND cm.created_at < bucket_end
  ),
  first_contact AS (
    SELECT DISTINCT ON (cm.conversation_id) cm.conversation_id, cm.created_at AS contact_at, c.workspace_id
      FROM public.conversation_messages cm
      JOIN public.conversations c ON c.id = cm.conversation_id
     WHERE cm.sender_type = 'contact'
       AND cm.created_at >= bucket - interval '6 hours'
     ORDER BY cm.conversation_id, cm.created_at ASC
  ),
  first_agent AS (
    SELECT DISTINCT ON (cm.conversation_id) cm.conversation_id, cm.created_at AS agent_at, c.workspace_id
      FROM public.conversation_messages cm
      JOIN public.conversations c ON c.id = cm.conversation_id
     WHERE cm.sender_type = 'agent'
       AND cm.created_at >= bucket - interval '6 hours'
     ORDER BY cm.conversation_id, cm.created_at ASC
  ),
  frt AS (
    SELECT fc.workspace_id,
           EXTRACT(EPOCH FROM (fa.agent_at - fc.contact_at)) AS frt_s
      FROM first_contact fc
      JOIN first_agent fa ON fa.conversation_id = fc.conversation_id
     WHERE fa.agent_at >= bucket AND fa.agent_at < bucket_end
       AND fa.agent_at >= fc.contact_at
  ),
  per_ws AS (
    SELECT
      w.id AS workspace_id,
      (SELECT COUNT(*) FROM conv_window x WHERE x.workspace_id = w.id) AS new_c,
      (SELECT COUNT(*) FROM resolved_window x WHERE x.workspace_id = w.id) AS res_c,
      (SELECT AVG(dur_s) FROM resolved_window x WHERE x.workspace_id = w.id) AS avg_res_s,
      (SELECT COUNT(*) FROM msgs_window x WHERE x.workspace_id = w.id) AS msgs,
      (SELECT COUNT(DISTINCT sender_id) FROM msgs_window x
        WHERE x.workspace_id = w.id AND sender_type = 'agent') AS active_ops,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id AND x.status IN ('open','pending')) AS active_c,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id
          AND x.status IN ('open','pending')
          AND NOT EXISTS (
            SELECT 1 FROM public.conversation_messages m
             WHERE m.conversation_id = x.id AND m.sender_type = 'agent')
      ) AS unanswered,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id
          AND x.status IN ('open','pending')
          AND x.updated_at < now() - interval '24 hours'
      ) AS stale_open,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY frt_s) FROM frt f WHERE f.workspace_id = w.id) AS frt_p50,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY frt_s) FROM frt f WHERE f.workspace_id = w.id) AS frt_p95
    FROM public.workspaces w
   WHERE EXISTS (
     SELECT 1 FROM conv_window x WHERE x.workspace_id = w.id
     UNION SELECT 1 FROM msgs_window x WHERE x.workspace_id = w.id
     UNION SELECT 1 FROM resolved_window x WHERE x.workspace_id = w.id
   )
  )
  INSERT INTO public.business_metrics_hourly (
    bucket_hour, workspace_id,
    new_conversations, resolved_conversations, unanswered_conversations, stale_open_conversations,
    avg_conversation_duration_seconds,
    avg_messages_per_conversation,
    first_response_time_p50, first_response_time_p95,
    messages_sent, active_operators, active_conversations,
    conversation_to_resolution_rate,
    avg_resolution_time_seconds,
    support_load_score
  )
  SELECT
    bucket,
    workspace_id,
    new_c,
    res_c,
    unanswered,
    stale_open,
    avg_res_s,
    CASE WHEN new_c > 0 THEN msgs::numeric / NULLIF(new_c,0) ELSE NULL END,
    frt_p50,
    frt_p95,
    msgs,
    active_ops,
    active_c,
    CASE WHEN new_c > 0 THEN res_c::numeric / NULLIF(new_c,0) ELSE NULL END,
    avg_res_s,
    LEAST(1.0, (
      COALESCE(active_c,0)::numeric / GREATEST(1, COALESCE(active_ops,1)) / 25.0
      + COALESCE(unanswered,0)::numeric / 10.0
      + COALESCE(stale_open,0)::numeric / 10.0
    ) / 3.0)
  FROM per_ws
  ON CONFLICT (bucket_hour, workspace_id) DO UPDATE SET
    new_conversations = EXCLUDED.new_conversations,
    resolved_conversations = EXCLUDED.resolved_conversations,
    unanswered_conversations = EXCLUDED.unanswered_conversations,
    stale_open_conversations = EXCLUDED.stale_open_conversations,
    avg_conversation_duration_seconds = EXCLUDED.avg_conversation_duration_seconds,
    avg_messages_per_conversation = EXCLUDED.avg_messages_per_conversation,
    first_response_time_p50 = EXCLUDED.first_response_time_p50,
    first_response_time_p95 = EXCLUDED.first_response_time_p95,
    messages_sent = EXCLUDED.messages_sent,
    active_operators = EXCLUDED.active_operators,
    active_conversations = EXCLUDED.active_conversations,
    conversation_to_resolution_rate = EXCLUDED.conversation_to_resolution_rate,
    avg_resolution_time_seconds = EXCLUDED.avg_resolution_time_seconds,
    support_load_score = EXCLUDED.support_load_score;
  GET DIAGNOSTICS rolled = ROW_COUNT;

  DELETE FROM public.business_metrics_hourly WHERE bucket_hour < now() - interval '180 days';
  GET DIAGNOSTICS pruned = ROW_COUNT;

  RETURN jsonb_build_object('rolled', rolled, 'pruned', pruned, 'bucket', bucket, 'ran_at', now());
END
$$;