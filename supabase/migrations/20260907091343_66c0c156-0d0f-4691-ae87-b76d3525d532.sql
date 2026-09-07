CREATE OR REPLACE FUNCTION public.billing_sync_applied_invoice_payment(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.billing_invoice_applications
    WHERE invoice_id = p_invoice_id AND application_status = 'applied'
  ) THEN
    UPDATE public.billing_payment_intents
       SET status = 'succeeded',
           succeeded_at = COALESCE(succeeded_at, now()),
           failure_reason = NULL,
           updated_at = now()
     WHERE invoice_id = p_invoice_id
       AND status IN ('pending', 'processing');

    UPDATE public.billing_invoice_collections
       SET status = 'released',
           released_at = COALESCE(released_at, now()),
           release_reason = COALESCE(release_reason, 'payment_applied')
     WHERE invoice_id = p_invoice_id
       AND status = 'active';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.billing_sync_applied_invoice_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_sync_applied_invoice_payment(uuid) TO service_role;