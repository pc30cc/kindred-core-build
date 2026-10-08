/**
 * Art's chart tooltip: a small card with the point's date (or category) on
 * top and one row per series under it — a key in the series' colour, the
 * series' name, and its exact value aligned at the row's end. It is written in
 * the reader's direction (the plot itself is drawn left to right).
 *
 * Recharts hands it `active`, `payload` and `label` (charts pass it as
 * `content={<ArtChartTooltip ... />}` through `kit.tooltip()`). Its look is
 * charts.css (`data-art-chart-tooltip`).
 */
import type { ReactNode } from 'react';
import { artSeriesColor, formatArtDate, formatArtNumber } from './format';

/** One series of the chart, in the order the tooltip lists them. */
export interface ArtTooltipSeries {
  /** The data row's field that holds this series' value. */
  key: string;
  label: ReactNode;
  /** The series' colour number (1 ... 6), unless `color` is given. */
  n?: number;
  color?: string;
  /** Formats this series' value (default: the exact, grouped number). */
  format?: (value: number) => string;
}

/** What Recharts passes a custom tooltip (only the fields read here). */
interface PayloadItem {
  dataKey?: string | number;
  name?: string | number;
  value?: unknown;
  color?: string;
  /** 'none' for a series that keeps out of the tooltip (`tooltipType="none"`, e.g. a donut's track). */
  type?: string;
  payload?: Record<string, unknown> & { fill?: string };
}

export interface ArtChartTooltipProps {
  active?: boolean;
  payload?: PayloadItem[];
  label?: unknown;
  locale: string;
  dir: 'ltr' | 'rtl';
  /** The rows to list, read from the hovered data row (default: Recharts' payload). */
  series?: ArtTooltipSeries[];
  /**
   * The header: `'date'` formats the point's label as a date (the default),
   * `'raw'` shows it as it is, a function builds it, `null` leaves it out.
   */
  header?: 'date' | 'raw' | null | ((label: unknown, row: Record<string, unknown> | undefined) => ReactNode);
  /** Formats every value (default: the exact, grouped number). */
  format?: (value: number, key: string) => string;
  /** The key's shape: a short line (lines, areas) or a dot (bars, slices). */
  keyShape?: 'line' | 'dot';
}

interface Row {
  id: string;
  label: ReactNode;
  color: string;
  value: string;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function ArtChartTooltip({
  active,
  payload,
  label,
  locale,
  dir,
  series,
  header = 'date',
  format,
  keyShape = 'line',
}: ArtChartTooltipProps) {
  // Recharts drops a `tooltipType="none"` series only from its own default
  // card, so a custom card filters it out itself.
  const items = payload?.filter((item) => item.type !== 'none') ?? [];
  if (!active || !items.length) return null;
  const row = items[0]?.payload;
  const show = (value: unknown, key: string, own?: (v: number) => string) => {
    const n = asNumber(value);
    if (n === null) return '—';
    if (own) return own(n);
    return format ? format(n, key) : formatArtNumber(n, locale);
  };

  const rows: Row[] = series
    ? series.map((s) => ({
        id: s.key,
        label: s.label,
        color: s.color ?? artSeriesColor(s.n ?? 1),
        value: show(row?.[s.key], s.key, s.format),
      }))
    : items.map((item, i) => {
        const key = String(item.dataKey ?? item.name ?? i);
        const fill = item.payload?.fill;
        const color = typeof fill === 'string' && !fill.startsWith('url(') ? fill : item.color ?? artSeriesColor(i + 1);
        return { id: `${key}-${i}`, label: item.name ?? key, color, value: show(item.value, key) };
      });

  const title =
    header === null
      ? null
      : typeof header === 'function'
        ? header(label, row)
        : header === 'raw'
          ? (label == null ? null : String(label))
          : formatArtDate(label, locale, 'tooltip');

  return (
    <div data-art-chart-tooltip="" dir={dir}>
      {title ? <div data-art-chart-tooltip-label="">{title}</div> : null}
      <ul data-art-chart-tooltip-rows="">
        {rows.map((r) => (
          <li key={r.id} data-art-chart-tooltip-row="">
            <i data-art-chart-key={keyShape} style={{ backgroundColor: r.color }} aria-hidden />
            <span data-art-chart-tooltip-name="">{r.label}</span>
            <b data-art-chart-tooltip-value="">{r.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
