/**
 * Art's chart kit: the props that give a Recharts chart Art's look, so a page
 * keeps its own chart and only spreads them in its Art branch:
 *
 *   const art = useArtCharts();            // null unless the panel wears Art
 *   <Area {...art.area(1)} dataKey="sessions" />
 *
 * The look, in one place:
 *   - series in the active colour scheme (hsl(var(--art-chart-N)));
 *   - areas: a monotone 2px line with round ends over a vertical wash of its
 *     own colour (one gradient per chart and series, `art.gradient(n)`);
 *   - bars: rounded at the value end, square at the baseline, at most 28px
 *     thick, optionally on a faint track;
 *   - donuts: a thin ring of rounded, parted slices;
 *   - a faint dashed horizontal grid only; axes without rules or ticks, small
 *     muted tabular labels, compact numbers and the reader's dates and digits;
 *   - the point under the pointer on a ring of paper, a hairline cursor (a
 *     soft band for bars), and Art's tooltip card (ArtChartTooltip);
 *   - a 600ms ease-out entrance, none when the reader asks for less motion.
 * The CSS half is src/themes/art/charts.css.
 */
import type { ReactElement } from 'react';
import type { AreaProps, BarProps, CartesianGridProps, LineProps, PieProps, TooltipProps, XAxisProps, YAxisProps } from 'recharts';
import { ArtChartTooltip, type ArtChartTooltipProps } from './ArtChartTooltip';
import {
  artAxisTop,
  artAxisWidth,
  artGradientId,
  artSeriesColor,
  formatArtCompact,
  formatArtDate,
  formatArtNumber,
  formatArtPercent,
  type ArtChartLocale,
  type ArtDateStyle,
} from './format';

export const ART_CHART_ANIMATION_MS = 600;

/** A Recharts component's props without `ref` (its SVG ref type is not the component's). */
type Props<T> = Partial<Omit<T, 'ref'>>;

/** What an axis' labels are: dates, compact numbers, exact numbers, or a formatter of the page's own. */
export type ArtAxisFormat = 'date' | 'compact' | 'number' | 'percent' | 'raw' | ((value: unknown) => string);

export type ArtTooltipOptions = Omit<ArtChartTooltipProps, 'active' | 'payload' | 'label' | 'locale' | 'dir'> & {
  /** A hairline that follows the pointer (lines, areas) or a soft band (bars). */
  cursor?: 'line' | 'band' | false;
  /**
   * Whether the card may leave the plot above or below it (default: yes, so a
   * short plot's card is not cut). False keeps it inside its plot, for plots
   * stacked on one another (small multiples), whose neighbour it would cover.
   */
  escapeY?: boolean;
};

export interface ArtChartKitOptions {
  locale: ArtChartLocale | string;
  dir: 'ltr' | 'rtl';
  /** React's useId() of the chart: makes its gradient ids unique on the page. */
  uid: string;
  /** False when the reader prefers reduced motion. */
  animate: boolean;
}

const MUTED = 'hsl(var(--muted-foreground))';
const PAPER = 'hsl(var(--card))';

export function createArtChartKit({ locale, dir, uid, animate }: ArtChartKitOptions) {
  const motion = {
    isAnimationActive: animate,
    animationDuration: ART_CHART_ANIMATION_MS,
    animationEasing: 'ease-out' as const,
  };

  const formatter = (format: ArtAxisFormat | undefined) => (value: unknown): string => {
    if (typeof format === 'function') return format(value);
    switch (format) {
      case 'date':
        return formatArtDate(value, locale, 'axis');
      case 'number':
        return formatArtNumber(value, locale);
      case 'percent':
        return formatArtPercent(value, locale);
      case 'raw':
        return value == null ? '' : String(value);
      default:
        return formatArtCompact(value, locale);
    }
  };

  const tick = { fontSize: 11, fill: MUTED };

  /** The point under the pointer: a dot of the series' colour on a ring of paper. */
  const activeDot = (color: string) => ({ r: 4.5, fill: color, stroke: PAPER, strokeWidth: 2.5 });

  const gradientId = (n: number, scope = 'area') => artGradientId(scope, uid, n);

  const kit = {
    locale,
    dir,
    animate,
    uid,
    motion,

    /** Series `n`'s colour (1 ... 6), optionally see-through. */
    color: (n: number, alpha?: number) => artSeriesColor(n, alpha),
    number: (value: unknown, digits?: number) => formatArtNumber(value, locale, digits),
    compact: (value: unknown) => formatArtCompact(value, locale),
    percent: (share: unknown, digits?: number) => formatArtPercent(share, locale, digits),
    date: (value: unknown, style: ArtDateStyle = 'axis') => formatArtDate(value, locale, style),
    gradientId,

    /**
     * The width a value axis needs for these values' labels (its top tick and
     * the values' own, formatted as the axis formats them).
     */
    axisWidth(values: ReadonlyArray<unknown>, format: ArtAxisFormat = 'compact'): number {
      const nums = values.map(Number).filter((v) => Number.isFinite(v));
      const top = nums.length ? Math.max(...nums.map(Math.abs)) : 0;
      // The axis' ticks are round numbers up to just above the data's top.
      const axisTop = artAxisTop(top);
      const f = formatter(format);
      return artAxisWidth([f(top), f(axisTop), f(axisTop * 0.75), f(axisTop * 0.25)]);
    },

    /**
     * Series `n`'s wash for an area: its colour fading to nothing toward the
     * baseline (the top's strength is charts.css' --art-chart-wash, lighter in
     * light mode, a little stronger at night). Goes inside the chart's <defs>.
     */
    gradient(n: number, scope = 'area'): ReactElement {
      const color = artSeriesColor(n);
      const id = gradientId(n, scope);
      return (
        <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1" data-art-chart-wash="">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 'var(--art-chart-wash, 0.22)' }} />
          <stop offset="70%" style={{ stopColor: color, stopOpacity: 'calc(var(--art-chart-wash, 0.22) * 0.25)' }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      );
    },

    /** The value grid only: faint, dashed hairlines (vertical ones for a horizontal bar chart). */
    grid(opts: { vertical?: boolean } = {}): Props<CartesianGridProps> {
      const vertical = opts.vertical ?? false;
      return {
        vertical,
        horizontal: !vertical,
        stroke: 'var(--art-chart-grid)',
        strokeDasharray: '2 6',
        strokeWidth: 1,
      };
    },

    /** The category (usually time) axis: no rule, no ticks, small muted labels kept apart. */
    xAxis(opts: { format?: ArtAxisFormat; type?: 'category' | 'number'; reversed?: boolean } = {}): Props<XAxisProps> {
      const type = opts.type ?? 'category';
      return {
        type,
        axisLine: false,
        tickLine: false,
        tickMargin: 10,
        tick,
        minTickGap: 28,
        // Every k-th label from the first, k as small as fits: evenly spaced
        // to the end (forcing the last one in crowds the end unevenly).
        interval: 'equidistantPreserveStart',
        reversed: opts.reversed,
        tickFormatter: formatter(opts.format ?? (type === 'number' ? 'compact' : 'date')) as XAxisProps['tickFormatter'],
      };
    },

    /**
     * The value axis: compact labels, whole numbers, and a top that leaves a
     * series of zeros on its baseline under a few grid lines.
     */
    yAxis(opts: { format?: ArtAxisFormat; width?: number; reversed?: boolean; floor?: number; decimals?: boolean; domain?: YAxisProps['domain'] } = {}): Props<YAxisProps> {
      return {
        axisLine: false,
        tickLine: false,
        tickMargin: 8,
        width: opts.width ?? 40,
        tick,
        tickCount: 5,
        // The ticks are round steps that never crowd: show every one (the
        // default drops the baseline's 0 when it touches the plot's edge).
        interval: 0,
        allowDecimals: opts.decimals ?? false,
        reversed: opts.reversed,
        domain: opts.domain ?? [0, (dataMax: number) => artAxisTop(dataMax, opts.floor ?? 4, !(opts.decimals ?? false))],
        tickFormatter: formatter(opts.format ?? 'compact') as YAxisProps['tickFormatter'],
      };
    },

    /** An area series: a 2px monotone line over its wash (`gradient(n)` in the chart's defs). */
    area(n: number, opts: { wash?: boolean } = {}): Props<AreaProps> {
      return {
        type: 'monotone',
        stroke: artSeriesColor(n),
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: opts.wash === false ? 'transparent' : `url(#${gradientId(n)})`,
        fillOpacity: 1,
        dot: false,
        activeDot: activeDot(artSeriesColor(n)),
        ...motion,
      };
    },

    /**
     * A line series: 2px, monotone, round ends; `dots` marks every point.
     * `color` replaces the series colour where the line means a state
     * (good / bad feedback), which the scheme's series do not carry.
     */
    line(n: number, opts: { dots?: boolean; color?: string } = {}): Props<LineProps> {
      const color = opts.color ?? artSeriesColor(n);
      return {
        type: 'monotone',
        stroke: color,
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        dot: opts.dots ? { r: 3, fill: color, stroke: PAPER, strokeWidth: 2 } : false,
        activeDot: activeDot(color),
        connectNulls: true,
        ...motion,
      };
    },

    /**
     * A bar series: rounded at the value end and square at the baseline,
     * at most `size` thick; `track` lays each bar on a faint full-height track.
     * `layout: 'horizontal'` is a bar chart laid on its side (`reversed` when
     * its value axis runs right to left).
     */
    bar(n: number, opts: { layout?: 'columns' | 'horizontal'; reversed?: boolean; track?: boolean; size?: number; radius?: number } = {}): Props<BarProps> {
      const r = opts.radius ?? 6;
      const radius: [number, number, number, number] =
        opts.layout === 'horizontal' ? (opts.reversed ? [r, 0, 0, r] : [0, r, r, 0]) : [r, r, 0, 0];
      return {
        fill: artSeriesColor(n),
        radius,
        maxBarSize: opts.size ?? 28,
        ...(opts.track ? { background: { fill: 'var(--art-chart-track)', radius } as unknown as BarProps['background'] } : {}),
        ...motion,
      };
    },

    /** A donut: a thin ring of rounded slices parted by a little air, starting at 12 o'clock. */
    pie(opts: { slices?: number; inner?: number | string; outer?: number | string } = {}): Props<PieProps> {
      const single = (opts.slices ?? 2) < 2;
      return {
        innerRadius: opts.inner ?? '78%',
        outerRadius: opts.outer ?? '100%',
        paddingAngle: single ? 0 : 3,
        cornerRadius: single ? 0 : 999,
        startAngle: 90,
        endAngle: -270,
        stroke: 'none',
        ...motion,
      };
    },

    /** Art's tooltip card, with a hairline cursor (or a soft band for bars). */
    tooltip(opts: ArtTooltipOptions = {}): Props<TooltipProps<number, string>> {
      const { cursor = 'line', escapeY = true, ...content } = opts;
      return {
        content: <ArtChartTooltip locale={locale} dir={dir} {...content} />,
        cursor:
          cursor === false
            ? false
            : cursor === 'band'
              ? { fill: 'var(--art-chart-band)', radius: 8 } as unknown as TooltipProps<number, string>['cursor']
              : { stroke: 'var(--art-chart-cursor)', strokeWidth: 1, strokeDasharray: '3 3' },
        isAnimationActive: false,
        offset: 14,
        wrapperStyle: { outline: 'none', zIndex: 30 },
        allowEscapeViewBox: { x: false, y: escapeY },
      };
    },

    /** The plot's margins: room for the active dot's ring at the edges. */
    margin(kind: 'cartesian' | 'horizontal' | 'pie' = 'cartesian') {
      if (kind === 'pie') return { top: 4, right: 4, bottom: 4, left: 4 };
      if (kind === 'horizontal') return { top: 0, right: 12, bottom: 0, left: 0 };
      return { top: 10, right: 10, bottom: 0, left: 0 };
    },
  };
  return kit;
}

export type ArtChartKit = ReturnType<typeof createArtChartKit>;
