GRANT SELECT, INSERT, UPDATE, DELETE ON public.telephony_registrations TO service_role;
GRANT ALL ON public.telephony_registrations TO service_role;
GRANT ALL ON public.telephony_calls TO service_role;
GRANT EXECUTE ON FUNCTION public.telephony_claim_call(uuid, uuid, uuid) TO service_role;