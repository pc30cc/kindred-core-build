/**
 * Art's trend chart: one or more series over time, each an area (a 2px line
 * over a wash of its colour) or a plain line, on one value axis. The tooltip
 * lists every series at the hovered day, in the order given. Charts that
 * share `syncId` move their cursors together (small multiples).
 *
 * Its look is charts.css (`data-art-chart`); the props come from the kit.
 */
import type { ReactNode } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type YAxisProps } from 'recharts';
import type { ArtTooltipSeries } from './ArtChartTooltip';
import { artRankTicks, isEmptySeries } from './format';
import type { ArtAxisFormat, ArtChartKit } from './kit';

export interface ArtTrendSeries {
  key: string;
  label: ReactNode;
  /** The series' colour number (1 ... 6). */
  n: number;
  /** An area (the default) or a plain line. */
  kind?: 'area' | 'line';
  /** A line's colour when it means a state rather than a series (e.g. hsl(var(--success))). */
  color?: string;
  /** Formats this series' value in the tooltip. */
  format?: (value: number) => string;
}

export function ArtTrend<Row extends object>({
  kit,
  data,
  xKey,
  series,
  tooltipSeries,
  xFormat = 'date',
  yFormat = 'compact',
  yWidth,
  reversed,
  yDomain,
  decimals,
  syncId,
  hideXAxis,
  dots,
  tooltip = true,
  tooltipEscapeY,
  empty,
  className,
}: {
  kit: ArtChartKit;
  data: Row[];
  xKey: keyof Row & string;
  series: ArtTrendSeries[];
  /** The tooltip's rows when they differ from the plotted series (e.g. small multiples list every measure). */
  tooltipSeries?: ArtTooltipSeries[];
  xFormat?: ArtAxisFormat;
  yFormat?: ArtAxisFormat;
  yWidth?: number;
  /** A value axis where lower is better (a search position): 1 on top, round steps down to the worst value. */
  reversed?: boolean;
  yDomain?: YAxisProps['domain'];
  decimals?: boolean;
  syncId?: string;
  hideXAxis?: boolean;
  /** Marks every point (short series). */
  dots?: boolean;
  /** False: only the cursor follows the pointer (a small multiple whose sibling shows the card). */
  tooltip?: boolean;
  /**
   * Whether the card may leave the plot above or below it. Default: not when
   * the chart is synced with others (`syncId`, stacked small multiples), so a
   * card opened from the plot under it never covers that plot's head.
   */
  tooltipEscapeY?: boolean;
  /** Said in the middle of the plot when every value is 0. */
  empty?: ReactNode;
  className?: string;
}) {
  const values = data.flatMap((d) => series.map((s) => (d as Record<string, unknown>)[s.key]));
  const nothing = isEmptySeries(values);
  const worst = Math.max(0, ...values.map(Number).filter((v) => Number.isFinite(v)));
  const rankTicks = reversed ? artRankTicks(worst) : null;
  const rows: ArtTooltipSeries[] =
    tooltipSeries ?? series.map((s) => ({ key: s.key, label: s.label, n: s.n, color: s.kind === 'line' ? s.color : undefined, format: s.format }));
  // Drawn last to first, areas before lines: the first series (the main
  // one) and every line end up over the washes.
  const ordered = [...series].reverse().sort((a, b) => Number((a.kind ?? 'area') === 'line') - Number((b.kind ?? 'area') === 'line'));

  return (
    <div data-art-chart="trend" className={className} style={{ width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={hideXAxis ? { ...kit.margin(), bottom: 8 } : kit.margin()} syncId={syncId} accessibilityLayer>
          <defs>{series.filter((s) => (s.kind ?? 'area') === 'area').map((s) => kit.gradient(s.n))}</defs>
          <CartesianGrid {...kit.grid()} />
          <XAxis {...kit.xAxis({ format: xFormat })} dataKey={xKey} hide={hideXAxis} />
          <YAxis
            {...kit.yAxis({ format: yFormat, width: yWidth ?? kit.axisWidth(values, yFormat), reversed, decimals })}
            {...(rankTicks ? { domain: [1, rankTicks[rankTicks.length - 1]], ticks: rankTicks, interval: 0 as const } : {})}
            {...(yDomain ? { domain: yDomain } : {})}
          />
          {tooltip ? (
            <Tooltip {...kit.tooltip({ series: rows, escapeY: tooltipEscapeY ?? !syncId })} />
          ) : (
            <Tooltip {...kit.tooltip()} content={() => null} />
          )}
          {ordered.map((s) =>
            (s.kind ?? 'area') === 'line' ? (
              <Line key={s.key} {...kit.line(s.n, { dots, color: s.color })} dataKey={s.key} name={typeof s.label === 'string' ? s.label : s.key} />
            ) : (
              <Area key={s.key} {...kit.area(s.n)} dataKey={s.key} name={typeof s.label === 'string' ? s.label : s.key} />
            ),
          )}
        </ComposedChart>
      </ResponsiveContainer>
      {nothing && empty ? (
        <div data-art-chart-empty="">
          <span>{empty}</span>
        </div>
      ) : null}
    </div>
  );
}
