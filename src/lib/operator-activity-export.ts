/**
 * CSV export helpers for the operator activity report (owner/admin only).
 * Files are UTF-8 with BOM so Excel renders Persian/Turkish correctly.
 */
import type { OperatorActivityRow, OperatorActivityStats } from '@/lib/operator-activity-api';

function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number | null)[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

export function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const name = (o: OperatorActivityRow) => o.profile?.full_name || o.profile?.email || o.user_id;

const SUMMARY_HEAD = [
  'operator', 'email', 'role', 'current_state',
  'online_minutes', 'online_hours', 'present_minutes',
  'active_days', 'avg_minutes_per_active_day',
  'replies_sent', 'conversations_assigned', 'conversations_resolved',
  'last_seen',
];

function summaryRow(o: OperatorActivityRow) {
  return [
    name(o), o.profile?.email || '', o.role, o.current_state,
    o.online_minutes, (o.online_minutes / 60).toFixed(2), o.present_minutes,
    o.active_days, o.avg_minutes_per_active_day,
    o.replies_sent, o.conversations_assigned, o.conversations_resolved,
    o.last_seen || '',
  ];
}

export function exportSummaryCsv(data: OperatorActivityStats) {
  const rows: (string | number | null)[][] = [
    ['report', 'operator activity'],
    ['since', data.since],
    ['days', data.days],
    ['generated_at', new Date().toISOString()],
    [],
    SUMMARY_HEAD,
    ...data.operators.map(summaryRow),
  ];
  download(`operator-activity-${data.days}d-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
}

/** Summary + one row per operator per day (full detail). */
export function exportDetailedCsv(data: OperatorActivityStats) {
  const rows: (string | number | null)[][] = [
    ['report', 'operator activity (detailed)'],
    ['since', data.since],
    ['days', data.days],
    ['generated_at', new Date().toISOString()],
    [],
    SUMMARY_HEAD,
    ...data.operators.map(summaryRow),
    [],
    ['operator', 'email', 'date', 'online_minutes', 'online_hours'],
  ];
  for (const o of data.operators) {
    for (const date of Object.keys(o.daily).sort()) {
      const m = o.daily[date];
      rows.push([name(o), o.profile?.email || '', date, m, (m / 60).toFixed(2)]);
    }
  }
  download(`operator-activity-detailed-${data.days}d-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
}

/** Per-operator export with the daily breakdown. */
export function exportOperatorCsv(o: OperatorActivityRow, data: OperatorActivityStats) {
  const rows: (string | number | null)[][] = [
    ['operator', name(o)],
    ['email', o.profile?.email || ''],
    ['role', o.role],
    ['current_state', o.current_state],
    ['current_reason', o.current_reason],
    ['since', data.since],
    ['days', data.days],
    [],
    SUMMARY_HEAD,
    summaryRow(o),
    [],
    ['date', 'online_minutes', 'online_hours'],
    ...Object.keys(o.daily).sort().map((d) => [d, o.daily[d], (o.daily[d] / 60).toFixed(2)]),
  ];
  const slug = name(o).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);
  download(`operator-${slug}-${data.days}d.csv`, toCsv(rows));
}
