DELETE FROM public.workspace_subscriptions
WHERE workspace_id = '83b70735-aec7-41cc-a69c-b476016c5975'
  AND status = 'trialing'
  AND metadata->>'source' = 'signup_auto_trial';