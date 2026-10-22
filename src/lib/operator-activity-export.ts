/**
 * CSV export helpers for the operator activity report (owner/admin only).
 * Files are UTF-8 with BOM so Excel renders Persian/Turkish correctly.
 * While the server does not record online time (`online_time_tracked:
 * false`) the online-time columns and the daily breakdown are left out, as
 * on the page, rather than exported as zeros.
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

/** The server records online minutes (an older server always did). */
const tracksOnlineTime = (data: OperatorActivityStats) => data.online_time_tracked !== false;

function summaryHead(tracked: boolean): string[] {
  return [
    'operator', 'email', 'role', 'current_state', 'presence_state',
    ...(tracked ? ['online_minutes', 'online_hours', 'present_minutes', 'active_days', 'avg_minutes_per_active_day'] : []),
    'replies_sent', 'conversations_assigned', 'conversations_resolved',
    ...(tracked ? ['last_seen'] : []),
  ];
}

function summaryRow(o: OperatorActivityRow, tracked: boolean) {
  return [
    name(o), o.profile?.email || '', o.role, o.current_state, o.presence_state || '',
    ...(tracked
      ? [o.online_minutes, (o.online_minutes / 60).toFixed(2), o.present_minutes, o.active_days, o.avg_minutes_per_active_day]
      : []),
    o.replies_sent, o.conversations_assigned, o.conversations_resolved,
    ...(tracked ? [o.last_seen || ''] : []),
  ];
}

export function exportSummaryCsv(data: OperatorActivityStats) {
  const rows: (string | number | null)[][] = [
    ['report', 'operator activity'],
    ['since', data.since],
    ['days', data.days],
    ['generated_at', new Date().toISOString()],
    [],
    summaryHead(tracksOnlineTime(data)),
    ...data.operators.map((o) => summaryRow(o, tracksOnlineTime(data))),
  ];
  download(`operator-activity-${data.days}d-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
}

/** Summary + one row per operator per day (full detail). */
export function exportDetailedCsv(data: OperatorActivityStats) {
  const tracked = tracksOnlineTime(data);
  const rows: (string | number | null)[][] = [
    ['report', 'operator activity (detailed)'],
    ['since', data.since],
    ['days', data.days],
    ['generated_at', new Date().toISOString()],
    [],
    summaryHead(tracked),
    ...data.operators.map((o) => summaryRow(o, tracked)),
  ];
  if (tracked) rows.push([], ['operator', 'email', 'date', 'online_minutes', 'online_hours']);
  for (const o of tracked ? data.operators : []) {
    for (const date of Object.keys(o.daily).sort()) {
      const m = o.daily[date];
      rows.push([name(o), o.profile?.email || '', date, m, (m / 60).toFixed(2)]);
    }
  }
  download(`operator-activity-detailed-${data.days}d-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
}

/** Per-operator export with the daily breakdown. */
export function exportOperatorCsv(o: OperatorActivityRow, data: OperatorActivityStats) {
  const tracked = tracksOnlineTime(data);
  const rows: (string | number | null)[][] = [
    ['operator', name(o)],
    ['email', o.profile?.email || ''],
    ['role', o.role],
    ['current_state', o.current_state],
    ['current_reason', o.current_reason],
    ['since', data.since],
    ['days', data.days],
    [],
    summaryHead(tracked),
    summaryRow(o, tracked),
    ...(tracked
      ? [[], ['date', 'online_minutes', 'online_hours'],
        ...Object.keys(o.daily).sort().map((d) => [d, o.daily[d], (o.daily[d] / 60).toFixed(2)])]
      : []),
  ];
  const slug = name(o).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);
  download(`operator-${slug}-${data.days}d.csv`, toCsv(rows));
}
