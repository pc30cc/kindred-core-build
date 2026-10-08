/**
 * Art's donut: a thin ring of rounded, parted slices with the headline figure
 * in its middle, and beside it the slices as a list — key, name, value and
 * share — so nothing depends on hovering or on telling colours apart. Its look
 * is charts.css (`data-art-donut`).
 */
import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { artSeriesColor } from './format';
import type { ArtChartKit } from './kit';

export interface ArtDonutSlice {
  key: string;
  label: ReactNode;
  value: number;
  /** The slice's colour number (1 ... 6), unless `color` is given. */
  n?: number;
  color?: string;
}

export function ArtDonut({
  kit,
  slices,
  centerValue,
  centerLabel,
  size = 148,
  className,
}: {
  kit: ArtChartKit;
  slices: ArtDonutSlice[];
  centerValue: ReactNode;
  centerLabel?: ReactNode;
  size?: number;
  className?: string;
}) {
  const total = slices.reduce((sum, s) => sum + (Number.isFinite(s.value) ? Math.max(0, s.value) : 0), 0);
  const shown = slices.filter((s) => s.value > 0);
  const colorOf = (s: ArtDonutSlice) => s.color ?? artSeriesColor(s.n ?? 1);
  const data = shown.map((s) => ({ key: s.key, name: s.label, value: s.value, fill: colorOf(s) }));

  return (
    <div data-art-donut="" className={className}>
      <div data-art-donut-ring="" style={{ width: size, height: size }}>
        <PieChart width={size} height={size} margin={kit.margin('pie')}>
          {/* The ring's own track, under the slices: it never takes the pointer
              (charts.css), so the air between slices shows no tooltip. */}
          <Pie
            className="art-donut-track"
            data={[{ value: 1 }]}
            dataKey="value"
            innerRadius="78%"
            outerRadius="100%"
            startAngle={90}
            endAngle={-270}
            fill="var(--art-chart-track)"
            stroke="none"
            isAnimationActive={false}
            tooltipType="none"
            legendType="none"
          />
          <Pie {...kit.pie({ slices: data.length })} data={data} dataKey="value" nameKey="name">
            {data.map((d) => (
              <Cell key={d.key} fill={d.fill} />
            ))}
          </Pie>
          <Tooltip {...kit.tooltip({ header: null, keyShape: 'dot', cursor: false })} />
        </PieChart>
        <div data-art-donut-center="" aria-hidden>
          <b>{centerValue}</b>
          {centerLabel ? <span>{centerLabel}</span> : null}
        </div>
      </div>
      <ul data-art-donut-legend="">
        {slices.map((s) => (
          <li key={s.key} data-art-donut-item="">
            <i data-art-chart-key="dot" style={{ backgroundColor: colorOf(s) }} aria-hidden />
            <span data-art-donut-name="">{s.label}</span>
            <b data-art-donut-value="">{kit.number(s.value, 0)}</b>
            <span data-art-donut-share="">{total > 0 ? kit.percent(s.value / total) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
