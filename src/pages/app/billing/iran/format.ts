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

/**
 * Plan highlight rows for a plan card — 5 to 7 concrete, customer-readable
 * capabilities derived from the plan's own limits. Never invented copy: a
 * row only appears when the plan actually declares that limit.
 */
export interface PlanHighlight { key: string; value: number }

const HIGHLIGHT_KEYS = [
  'max_agents',
  'max_conversations',
  'max_visitors',
  'storage_gb',
  'max_call_minutes_per_month',
  'max_kb_articles',
  'max_departments',
];

export function planHighlights(plan: { limits?: Record<string, unknown> | null }): PlanHighlight[] {
  const limits = (plan?.limits || {}) as Record<string, unknown>;
  const rows: PlanHighlight[] = [];
  for (const key of HIGHLIGHT_KEYS) {
    const raw = limits[key];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || value === 0) continue;
    rows.push({ key, value });
    if (rows.length === 7) break;
  }
  return rows;
}
