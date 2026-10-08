/**
 * Art's chart kit (src/themes/art/charts): the pure helpers — series colours
 * from the active colour scheme, numbers and dates in the reader's digits and
 * calendar, round axis tops, unique gradient ids — the props the kit gives a
 * Recharts chart, the tooltip card, and that the kit exists only while the
 * panel wears Art, so a Classic chart can never reach it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, isValidElement } from 'react';
import { render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ theme: 'art' as string, locale: 'en' as string, dir: 'ltr' as 'ltr' | 'rtl' }));

vi.mock('@/themes/usePanelTheme', () => ({
  usePanelTheme: () => ({ theme: env.theme, options: {} }),
}));

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: env.locale, dir: env.dir }),
}));

import {
  ART_SERIES_COUNT,
  artAxisTop,
  artAxisWidth,
  artGradientId,
  artNiceStep,
  artRankTicks,
  artSeriesColor,
  artSeriesIndex,
  artSeriesTint,
  formatArtCompact,
  formatArtDate,
  formatArtNumber,
  formatArtPercent,
  isEmptySeries,
  parseArtChartDate,
  seriesTotal,
  zeroShare,
} from '@/themes/art/charts/format';
import { ART_CHART_ANIMATION_MS, createArtChartKit } from '@/themes/art/charts/kit';
import { ArtChartTooltip } from '@/themes/art/charts/ArtChartTooltip';
import { ArtBarList } from '@/themes/art/charts/ArtBarList';
import { ArtSegmentBar } from '@/themes/art/charts/ArtSegmentBar';
import { useArtCharts } from '@/themes/art/charts/useArtCharts';

const PERSIAN_DIGIT = /[۰-۹]/;
const LATIN_DIGIT = /[0-9]/;

beforeEach(() => {
  env.theme = 'art';
  env.locale = 'en';
  env.dir = 'ltr';
});

describe('series colours', () => {
  it('reads series N from the active scheme as an HSL triplet', () => {
    expect(artSeriesColor(1)).toBe('hsl(var(--art-chart-1))');
    expect(artSeriesColor(6)).toBe('hsl(var(--art-chart-6))');
    expect(artSeriesColor(3, 0.2)).toBe('hsl(var(--art-chart-3) / 0.2)');
    expect(artSeriesColor(2, 1)).toBe('hsl(var(--art-chart-2))');
  });

  it('draws a lighter step of an ordered scale as a solid tint over the card, not see-through', () => {
    expect(artSeriesTint(1)).toBe('hsl(var(--art-chart-1))');
    expect(artSeriesTint(1, 1)).toBe('hsl(var(--art-chart-1))');
    expect(artSeriesTint(1, 0.5)).toBe('color-mix(in oklab, hsl(var(--art-chart-1)) 50%, hsl(var(--card)))');
    expect(artSeriesTint(2, 0.34)).toBe('color-mix(in oklab, hsl(var(--art-chart-2)) 34%, hsl(var(--card)))');
    expect(artSeriesTint(1, -1)).toBe('color-mix(in oklab, hsl(var(--art-chart-1)) 0%, hsl(var(--card)))');
    expect(artSeriesTint(1, 0.3)).not.toContain(' / ');
  });

  it('folds any series number into the scheme’s six colours, never a new hue', () => {
    expect(ART_SERIES_COUNT).toBe(6);
    expect(artSeriesIndex(7)).toBe(1);
    expect(artSeriesIndex(12)).toBe(6);
    expect(artSeriesIndex(0)).toBe(6);
    expect(artSeriesIndex(-1)).toBe(5);
    expect(artSeriesIndex(Number.NaN)).toBe(1);
    for (let n = -20; n <= 20; n += 1) {
      expect(artSeriesColor(n)).toMatch(/^hsl\(var\(--art-chart-[1-6]\)\)$/);
    }
  });
});

describe('numbers', () => {
  it('is compact from a thousand up, in the reader’s digits', () => {
    expect(formatArtCompact(1234, 'en')).toBe('1.2K');
    expect(formatArtCompact(950, 'en')).toBe('950');
    expect(formatArtCompact(2.5, 'en')).toBe('2.5');
    expect(formatArtCompact(12_300_000, 'en')).toBe('12.3M');
    const fa = formatArtCompact(1234, 'fa');
    expect(fa).toMatch(PERSIAN_DIGIT);
    expect(fa).not.toMatch(LATIN_DIGIT);
    expect(fa).toContain('هزار');
    expect(formatArtCompact(950, 'fa')).toBe('۹۵۰');
    expect(formatArtCompact(1234, 'tr')).toMatch(/^1,2/);
  });

  it('writes exact values grouped, in the reader’s digits', () => {
    expect(formatArtNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatArtNumber(1234567, 'tr')).toBe('1.234.567');
    const fa = formatArtNumber(1234567, 'fa');
    expect(fa).toMatch(PERSIAN_DIGIT);
    expect(fa).not.toMatch(LATIN_DIGIT);
    expect(formatArtNumber('42', 'en')).toBe('42');
  });

  it('writes shares as percentages', () => {
    expect(formatArtPercent(0.73, 'en')).toBe('73%');
    expect(formatArtPercent(0.73, 'fa')).toMatch(/۷۳/);
  });

  it('shows a dash for what is not a number', () => {
    for (const value of [null, undefined, Number.NaN, Infinity, 'abc', '']) {
      expect(formatArtNumber(value, 'en')).toBe('—');
      expect(formatArtCompact(value, 'en')).toBe('—');
    }
  });
});

describe('dates', () => {
  it('reads a bare day as that day whatever the clock', () => {
    const parsed = parseArtChartDate('2026-09-14');
    expect(parsed?.utc).toBe(true);
    expect(parsed?.date.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(parseArtChartDate('not a date')).toBeNull();
    expect(parseArtChartDate(null)).toBeNull();
  });

  it('writes short axis labels in the reader’s calendar', () => {
    expect(formatArtDate('2026-09-14', 'en', 'axis')).toBe('Sep 14');
    expect(formatArtDate('2026-09-14', 'tr', 'axis')).toBe('14 Eyl');
    // 14 September 2026 is 23 Shahrivar 1405 in the Jalali calendar.
    const fa = formatArtDate('2026-09-14', 'fa', 'axis');
    expect(fa).toContain('شهریور');
    expect(fa).toContain('۲۳');
  });

  it('names the weekday in a tooltip, in Persian’s own order', () => {
    expect(formatArtDate('2026-09-14', 'en', 'tooltip')).toBe('Mon, Sep 14');
    const fa = formatArtDate('2026-09-14', 'fa', 'tooltip');
    expect(fa.startsWith('دوشنبه')).toBe(true);
    expect(fa).toContain('۲۳ شهریور');
  });

  it('leaves a label that is not a date as it is', () => {
    expect(formatArtDate('/blog', 'en')).toBe('/blog');
  });
});

describe('gradient ids', () => {
  it('are unique per chart and per series, and safe inside url(#...)', () => {
    const ids = new Set<string>();
    for (const uid of [':r1:', ':r2:', ':r10:', 'r1']) {
      for (const n of [1, 2, 3]) ids.add(artGradientId('area', uid, n));
    }
    // ':r1:' and 'r1' clean to the same characters; every other pair differs.
    expect(ids.size).toBe(9);
    expect(artGradientId('area', ':r1:', 1)).not.toBe(artGradientId('area', ':r2:', 1));
    expect(artGradientId('area', ':r1:', 1)).not.toBe(artGradientId('area', ':r1:', 2));
    expect(artGradientId('area', ':r1:', 1)).not.toBe(artGradientId('bar', ':r1:', 1));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });

  it('differ between two charts of the same page (two kits)', () => {
    const a = createArtChartKit({ locale: 'en', dir: 'ltr', uid: ':r3:', animate: false });
    const b = createArtChartKit({ locale: 'en', dir: 'ltr', uid: ':r4:', animate: false });
    expect(a.gradientId(1)).not.toBe(b.gradientId(1));
    expect(a.area(1).fill).toBe(`url(#${a.gradientId(1)})`);
    const gradient = a.gradient(1);
    expect(isValidElement(gradient)).toBe(true);
    expect((gradient.props as { id: string }).id).toBe(a.gradientId(1));
  });
});

describe('value axes', () => {
  it('stop at a round number just above the data', () => {
    expect(artAxisTop(1356)).toBe(1600);
    expect(artAxisTop(58)).toBe(60);
    expect(artAxisTop(99)).toBe(100);
    expect(artAxisTop(8)).toBe(8);
    expect(artAxisTop(9)).toBe(9);
    expect(artAxisTop(1600)).toBe(1600);
  });

  it('keep a series of zeros on the baseline under a few grid lines', () => {
    expect(artAxisTop(0)).toBe(4);
    expect(artAxisTop(Number.NaN, 10)).toBe(10);
  });

  it('use whole steps for counts', () => {
    for (const max of [1, 3, 5, 7, 9, 13, 27]) {
      expect(Number.isInteger(artNiceStep(max, 4, true))).toBe(true);
    }
  });

  it('read a search position from 1 down in fives and tens', () => {
    expect(artRankTicks(19.7)).toEqual([1, 5, 10, 15, 20]);
    expect(artRankTicks(26)).toEqual([1, 10, 20, 30]);
    expect(artRankTicks(3)).toEqual([1, 2, 3]);
  });

  it('make room for Persian’s longer compact labels', () => {
    expect(artAxisWidth(['۲٫۷ هزار'])).toBeGreaterThan(artAxisWidth(['2.7K']));
    expect(artAxisWidth([''])).toBe(28);
    expect(artAxisWidth(['x'.repeat(40)])).toBe(76);
  });
});

describe('series helpers', () => {
  it('know an empty, a sparse and a full series apart', () => {
    expect(isEmptySeries([0, 0, null, undefined])).toBe(true);
    expect(isEmptySeries([0, 0, 3])).toBe(false);
    expect(zeroShare([0, 0, 0, 8])).toBe(0.75);
    expect(zeroShare([])).toBe(1);
    expect(seriesTotal([1, '2', null, 3])).toBe(6);
  });
});

describe('the kit’s props', () => {
  const kit = createArtChartKit({ locale: 'fa', dir: 'rtl', uid: ':r9:', animate: true });

  it('draws areas and lines as 2px monotone curves in the series colour', () => {
    const area = kit.area(2);
    expect(area).toMatchObject({ type: 'monotone', stroke: 'hsl(var(--art-chart-2))', strokeWidth: 2, strokeLinecap: 'round', dot: false });
    expect(area.activeDot).toMatchObject({ fill: 'hsl(var(--art-chart-2))', stroke: 'hsl(var(--card))' });
    const line = kit.line(3, { dots: true });
    expect(line).toMatchObject({ type: 'monotone', stroke: 'hsl(var(--art-chart-3))', strokeWidth: 2, connectNulls: true });
    expect(kit.line(1, { color: 'hsl(var(--success))' }).stroke).toBe('hsl(var(--success))');
  });

  it('rounds a bar at its value end only, on an optional track', () => {
    expect(kit.bar(1).radius).toEqual([6, 6, 0, 0]);
    expect(kit.bar(1, { layout: 'horizontal' }).radius).toEqual([0, 6, 6, 0]);
    expect(kit.bar(1, { layout: 'horizontal', reversed: true }).radius).toEqual([6, 0, 0, 6]);
    expect(kit.bar(1).maxBarSize).toBe(28);
    expect(kit.bar(1).background).toBeUndefined();
    expect(kit.bar(1, { track: true }).background).toMatchObject({ fill: 'var(--art-chart-track)' });
  });

  it('keeps only a faint dashed value grid and bare axes', () => {
    expect(kit.grid()).toMatchObject({ vertical: false, horizontal: true, stroke: 'var(--art-chart-grid)' });
    expect(kit.grid({ vertical: true })).toMatchObject({ vertical: true, horizontal: false });
    expect(kit.grid().strokeDasharray).toBeTruthy();
    for (const axis of [kit.xAxis(), kit.yAxis()]) {
      expect(axis).toMatchObject({ axisLine: false, tickLine: false });
    }
  });

  it('labels axes in the reader’s digits and calendar', () => {
    const y = kit.yAxis().tickFormatter as (v: unknown, i: number) => string;
    expect(y(1234, 0)).toContain('هزار');
    const x = kit.xAxis().tickFormatter as (v: unknown, i: number) => string;
    expect(x('2026-09-14', 0)).toContain('شهریور');
  });

  it('enters in 600ms ease-out, and not at all for a reader who asks for less motion', () => {
    expect(ART_CHART_ANIMATION_MS).toBe(600);
    expect(kit.area(1)).toMatchObject({ isAnimationActive: true, animationDuration: 600, animationEasing: 'ease-out' });
    const still = createArtChartKit({ locale: 'en', dir: 'ltr', uid: 'x', animate: false });
    expect(still.area(1).isAnimationActive).toBe(false);
    expect(still.bar(1).isAnimationActive).toBe(false);
    expect(still.pie().isAnimationActive).toBe(false);
  });

  it('gives tooltips Art’s card, written in the reader’s direction', () => {
    const tooltip = kit.tooltip({ cursor: 'band' });
    expect(isValidElement(tooltip.content)).toBe(true);
    const content = tooltip.content as unknown as { type: unknown; props: { locale: string; dir: string } };
    expect(content.type).toBe(ArtChartTooltip);
    expect(content.props).toMatchObject({ locale: 'fa', dir: 'rtl' });
    expect(tooltip.cursor).toMatchObject({ fill: 'var(--art-chart-band)' });
    expect(kit.tooltip().cursor).toMatchObject({ stroke: 'var(--art-chart-cursor)' });
    expect(kit.tooltip({ cursor: false }).cursor).toBe(false);
  });

  it('parts a donut’s slices with air, and draws one slice whole', () => {
    expect(kit.pie({ slices: 2 })).toMatchObject({ paddingAngle: 3, startAngle: 90, endAngle: -270 });
    expect(kit.pie({ slices: 1 })).toMatchObject({ paddingAngle: 0, cornerRadius: 0 });
  });

  it('lets a card leave a short plot, but keeps a stacked plot’s card inside it', () => {
    expect(kit.tooltip().allowEscapeViewBox).toEqual({ x: false, y: true });
    expect(kit.tooltip({ escapeY: false }).allowEscapeViewBox).toEqual({ x: false, y: false });
    // The option is the kit's, not the card's.
    const content = kit.tooltip({ escapeY: false }).content as unknown as { props: Record<string, unknown> };
    expect(content.props).not.toHaveProperty('escapeY');
  });

  it('spaces date labels evenly from the first, instead of forcing the last one in', () => {
    expect(kit.xAxis().interval).toBe('equidistantPreserveStart');
  });
});

describe('the tooltip card', () => {
  const row = { date: '2026-09-14', sessions: 1234, pageviews: 5 };
  const payload = [{ dataKey: 'pageviews', value: 5, payload: row }];
  const series = [
    { key: 'sessions', label: 'Sessions', n: 1 },
    { key: 'pageviews', label: 'Pageviews', n: 2 },
  ];

  it('names the day and lists every series of the hovered day, in order, with exact values', () => {
    const { container } = render(
      createElement(ArtChartTooltip, { active: true, payload, label: '2026-09-14', locale: 'en', dir: 'ltr', series }),
    );
    const card = container.querySelector('[data-art-chart-tooltip]');
    expect(card).not.toBeNull();
    expect(container.querySelector('[data-art-chart-tooltip-label]')?.textContent).toBe('Mon, Sep 14');
    const rows = [...container.querySelectorAll('[data-art-chart-tooltip-row]')].map((r) => r.textContent);
    expect(rows).toEqual(['Sessions1,234', 'Pageviews5']);
  });

  it('is written right to left in Persian, with Persian digits', () => {
    const { container } = render(
      createElement(ArtChartTooltip, { active: true, payload, label: '2026-09-14', locale: 'fa', dir: 'rtl', series }),
    );
    expect(container.querySelector('[data-art-chart-tooltip]')?.getAttribute('dir')).toBe('rtl');
    const value = container.querySelector('[data-art-chart-tooltip-value]')?.textContent ?? '';
    expect(value).toMatch(PERSIAN_DIGIT);
    expect(value).not.toMatch(LATIN_DIGIT);
  });

  it('draws nothing while no point is hovered', () => {
    const { container } = render(createElement(ArtChartTooltip, { active: false, payload, locale: 'en', dir: 'ltr', series }));
    expect(container.innerHTML).toBe('');
  });

  it('leaves out a series that keeps out of the tooltip (a donut’s track)', () => {
    const track = [{ name: 0, value: 1, type: 'none', payload: { value: 1 } }];
    const slice = { name: 'dofollow', value: 73, payload: { fill: 'hsl(var(--art-chart-1))' } };
    const alone = render(createElement(ArtChartTooltip, { active: true, payload: track, locale: 'en', dir: 'ltr', header: null }));
    expect(alone.container.innerHTML).toBe('');
    const both = render(
      createElement(ArtChartTooltip, { active: true, payload: [...track, slice], locale: 'en', dir: 'ltr', header: null, keyShape: 'dot' }),
    );
    const rows = [...both.container.querySelectorAll('[data-art-chart-tooltip-row]')].map((r) => r.textContent);
    expect(rows).toEqual(['dofollow73']);
  });
});

describe('ranked bars and the distribution bar', () => {
  it('draws no stub for a value of 0', () => {
    const { container } = render(
      createElement(ArtBarList, {
        locale: 'en',
        items: [
          { key: 'a', label: 'a', value: 40 },
          { key: 'b', label: 'b', value: 0 },
        ],
      }),
    );
    const fills = [...container.querySelectorAll('[data-art-bar-fill]')];
    expect(fills.map((f) => f.hasAttribute('data-zero'))).toEqual([false, true]);
  });

  it('writes a part’s count in the reader’s digits', () => {
    const kit = createArtChartKit({ locale: 'fa', dir: 'rtl', uid: ':s1:', animate: false });
    const { container } = render(
      createElement(ArtSegmentBar, {
        kit,
        segments: [
          { key: 'top', label: 'top', value: 3, strength: 1 },
          { key: 'low', label: 'low', value: 12, strength: 0.5 },
        ],
      }),
    );
    const parts = [...container.querySelectorAll<HTMLElement>('[data-art-segment]')];
    expect(parts.map((p) => p.title)).toEqual(['۳', '۱۲']);
  });
});

describe('useArtCharts', () => {
  it('gives no kit while the panel wears Classic, so Classic charts stay as they are', () => {
    env.theme = 'classic';
    const { result } = renderHook(() => useArtCharts());
    expect(result.current).toBeNull();
  });

  it('gives the kit under Art, in the reader’s locale and direction', () => {
    env.locale = 'fa';
    env.dir = 'rtl';
    const { result } = renderHook(() => useArtCharts());
    expect(result.current).not.toBeNull();
    expect(result.current?.locale).toBe('fa');
    expect(result.current?.dir).toBe('rtl');
    // src/test/setup.ts answers matchMedia with "no preference": the charts animate.
    expect(result.current?.animate).toBe(true);
  });

  it('gives each chart its own gradient ids', () => {
    const one = renderHook(() => useArtCharts()).result.current;
    const two = renderHook(() => useArtCharts()).result.current;
    expect(one?.gradientId(1)).not.toBe(two?.gradientId(1));
  });
});

describe('the pages that draw Art charts', () => {
  const PAGES = [
    'src/pages/app/OverviewPage.tsx',
    'src/pages/app/seo/SeoPage.tsx',
    'src/pages/app/seo/GscInsightsSection.tsx',
    'src/pages/app/seo/WebAnalyticsSection.tsx',
    'src/pages/app/seo/BotAnalyticsSection.tsx',
    'src/pages/app/seo/SiteExplorerSection.tsx',
    'src/pages/app/ai-agent/OperatorAssistAnalyticsPage.tsx',
  ];

  it.each(PAGES)('%s reaches the kit only through useArtCharts (null under Classic)', (path) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    expect(source).toContain("from '@/themes/art/charts/useArtCharts'");
    expect(source).toMatch(/const art = useArtCharts\(\);/);
    // Building a kit by hand would skip the theme check.
    expect(source).not.toContain('createArtChartKit');
  });
});
