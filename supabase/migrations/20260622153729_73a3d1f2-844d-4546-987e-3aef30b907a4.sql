UPDATE public.billing_plans
   SET limits = jsonb_set(
     COALESCE(limits, '{}'::jsonb),
     '{max_concurrent_calls}',
     to_jsonb(-1),
     true
   )
 WHERE NOT (COALESCE(limits, '{}'::jsonb) ? 'max_concurrent_calls');