/**
 * Art's chart legend: one quiet pill per series — a key in the series' colour,
 * its name, and (optionally) its total — written in the reader's direction.
 * A chart with a single series needs none (its title names it). Its look is
 * charts.css (`data-art-chart-legend`).
 */
import type { ReactNode } from 'react';
import { artSeriesColor } from './format';

export interface ArtLegendItem {
  key: string;
  label: ReactNode;
  /** The series' colour number (1 ... 6), unless `color` is given. */
  n?: number;
  color?: string;
  /** A figure after the name, e.g. the series' total in the range. */
  value?: ReactNode;
}

export function ArtChartLegend({
  items,
  align = 'start',
  shape = 'line',
  className,
}: {
  items: ArtLegendItem[];
  align?: 'start' | 'center' | 'end';
  /** Mirrors the marks: a short line for lines and areas, a dot for bars and slices. */
  shape?: 'line' | 'dot';
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul data-art-chart-legend={align} className={className}>
      {items.map((item) => (
        <li key={item.key} data-art-chart-legend-item="">
          <i data-art-chart-key={shape} style={{ backgroundColor: item.color ?? artSeriesColor(item.n ?? 1) }} aria-hidden />
          <span data-art-chart-legend-name="">{item.label}</span>
          {item.value !== undefined && item.value !== null ? <b data-art-chart-legend-value="">{item.value}</b> : null}
        </li>
      ))}
    </ul>
  );
}
