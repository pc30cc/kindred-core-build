/**
 * Phase 4c — Tiny dependency-free relative-time helper.
 * Returns a short label ("just now", "5m", "2h", "Mon", "Mar 14") plus a
 * human-friendly tooltip ("Apr 19, 2026, 14:32").
 */

export function formatRelativeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 90) return '1m';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 7200) return '1h';
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 2) return 'yesterday';
  if (diff < 86400 * 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (diff < 86400 * 365) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatAbsoluteTooltip(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
