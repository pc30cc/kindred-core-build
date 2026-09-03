/**
 * Iran billing display helpers — raw backend enums NEVER reach the UI.
 * Every mapping here is total (an unknown value falls back to a safe label,
 * never the raw string).
 */
import { formatDate } from '@/lib/date';

export type TxStatus = 'succeeded' | 'pending' | 'failed' | 'refunded' | 'canceled';

/** billing_payments.status / provider verify result → customer-facing Persian. */
export function mapPaymentStatus(raw: string | null | undefined): TxStatus {
  switch (raw) {
    case 'succeeded': return 'succeeded';
    case 'refunded':
    case 'partially_refunded': return 'refunded';
    case 'canceled': return 'canceled';
    case 'pending': return 'pending';
    default: return 'failed';
  }
}

export function jalaliDate(value: string | null | undefined): string {
  if (!value) return '—';
  return formatDate(value, { year: 'numeric', month: 'long', day: 'numeric' }, 'fa');
}

/** Purchase description for a billing_events / billing_payments row. */
export function describeTransaction(event: { event_type?: string; metadata?: any }): 'renewal' | 'topup' | 'upgrade' | 'other' {
  const type = event.event_type || '';
  if (type === 'ai_credit_topup') return 'topup';
  if (event.metadata?.purchase_type === 'ai_credit_topup') return 'topup';
  if (event.metadata?.isUpgrade) return 'upgrade';
  return 'renewal';
}
