/**
 * Art's column chart: one column per day (or category), rounded at the top
 * and square on the baseline, each on a faint full-height track so the empty
 * days still read as days. Hovering a column brings it forward and quiets the
 * others; its tooltip names the day and the value. With nothing to show it
 * keeps its tracks and baseline and says so in the middle (`empty`).
 *
 * Counts per day are columns, not a line: a line drawn through days of zeros
 * and one busy day reads as a cliff. Its look is charts.css (`data-art-chart`).
 */
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { isEmptySeries } from './format';
import type { ArtAxisFormat, ArtChartKit } from './kit';

export function ArtColumns<Row extends object>({
  kit,
  data,
  xKey,
  valueKey,
  name,
  n = 1,
  xFormat = 'date',
  tooltipHeader = 'date',
  empty,
  className,
}: {
  kit: ArtChartKit;
  data: Row[];
  xKey: keyof Row & string;
  valueKey: keyof Row & string;
  /** The series' name in the tooltip. */
  name: ReactNode;
  n?: number;
  xFormat?: ArtAxisFormat;
  tooltipHeader?: 'date' | 'raw';
  /** Said in the middle of the plot when every value is 0. */
  empty?: ReactNode;
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const nothing = isEmptySeries(data.map((d) => d[valueKey]));

  return (
    <div data-art-chart="columns" className={className} style={{ width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={kit.margin()}
          barCategoryGap="22%"
          accessibilityLayer
          onMouseMove={(state) => {
            const index = state?.isTooltipActive ? Number(state.activeTooltipIndex) : NaN;
            setActive(Number.isFinite(index) ? index : null);
          }}
          onMouseLeave={() => setActive(null)}
        >
          <CartesianGrid {...kit.grid()} />
          <XAxis {...kit.xAxis({ format: xFormat })} dataKey={xKey} minTickGap={12} />
          <YAxis {...kit.yAxis({ width: kit.axisWidth(data.map((d) => d[valueKey])) })} />
          <Tooltip {...kit.tooltip({ cursor: 'band', header: tooltipHeader, keyShape: 'dot', series: [{ key: valueKey, label: name, n }] })} />
          <Bar {...kit.bar(n, { track: true, size: 26 })} dataKey={valueKey} name={typeof name === 'string' ? name : valueKey}>
            {data.map((_, i) => (
              <Cell key={i} fillOpacity={active === null || active === i ? 1 : 0.38} style={{ transition: 'fill-opacity 160ms ease-out' }} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {nothing && empty ? (
        <div data-art-chart-empty="">
          <span>{empty}</span>
        </div>
      ) : null}
    </div>
  );
}
