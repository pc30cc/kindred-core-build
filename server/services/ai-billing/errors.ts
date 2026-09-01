/**
 * Domain errors of the AI billing boundary. Identical for every channel
 * (widget, telegram, bale, whatsapp, instagram, operator assist, KB worker).
 */
export class AiBillingError extends Error {
  constructor(
    public readonly code:
      | 'ai_allowance_exhausted'
      | 'billing_rate_not_configured'
      | 'billing_fx_not_configured'
      | 'billing_policy_not_configured'
      | 'idempotency_conflict'
      | 'ingestion_conflict'
      | 'refund_cap_exceeded'
      | 'billing_internal_error',
    message?: string,
    public readonly httpStatus: number = 403,
  ) {
    super(message || code);
    this.name = 'AiBillingError';
  }
}

export function isAllowanceExhausted(err: unknown): boolean {
  return err instanceof AiBillingError && err.code === 'ai_allowance_exhausted';
}
