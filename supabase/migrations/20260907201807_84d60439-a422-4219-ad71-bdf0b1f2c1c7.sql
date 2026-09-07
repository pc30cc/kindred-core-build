DO $$
DECLARE
  r record; v_usd numeric; v_irr numeric;
BEGIN
  FOR r IN
    SELECT id, sell_multiplier FROM public.ai_runs
     WHERE status IN ('USAGE_RECORDED','SETTLEMENT_PENDING')
  LOOP
    SELECT COALESCE(SUM(provider_cost_usd),0), COALESCE(SUM(internal_cost_irr),0)
      INTO v_usd, v_irr FROM public.ai_usage_events WHERE run_id = r.id;
    PERFORM public.ai_settle_run(
      r.id,
      'settle:' || r.id::text,
      v_usd,
      v_irr,
      round(v_irr * COALESCE(r.sell_multiplier, 1), 6),
      to_char(now(), 'YYYY-MM')
    );
  END LOOP;
END $$;