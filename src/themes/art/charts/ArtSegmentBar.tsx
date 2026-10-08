/**
 * Art's distribution bar: one rounded bar split into its parts (2px of paper
 * between them), with the parts listed under it — key, name, count and share
 * — so the order and the numbers read without hovering. For an ordered
 * breakdown (best to worst) give the parts one hue at falling strengths.
 * Its look is charts.css (`data-art-segments`).
 */
import type { ReactNode } from 'react';
import { artSeriesTint } from './format';
import type { ArtChartKit } from './kit';

export interface ArtSegment {
  key: string;
  label: ReactNode;
  value: number;
  /** The part's colour (default: series 1 at `strength`). */
  color?: string;
  /** Series 1's strength for this part, 0 ... 1, as a solid tint (ignored when `color` is given). */
  strength?: number;
}

export function ArtSegmentBar({ kit, segments, className }: { kit: ArtChartKit; segments: ArtSegment[]; className?: string }) {
  const total = segments.reduce((sum, s) => sum + (Number.isFinite(s.value) ? Math.max(0, s.value) : 0), 0);
  const colorOf = (s: ArtSegment) => s.color ?? artSeriesTint(1, s.strength ?? 1);
  return (
    <div data-art-segments="" className={className}>
      <div data-art-segments-bar="" aria-hidden>
        {total > 0
          ? segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <span key={s.key} data-art-segment="" style={{ flexGrow: s.value, backgroundColor: colorOf(s) }} title={kit.number(s.value, 0)} />
              ))
          : null}
      </div>
      <ul data-art-segments-legend="">
        {segments.map((s) => (
          <li key={s.key} data-art-segments-item="">
            <i data-art-chart-key="dot" style={{ backgroundColor: colorOf(s) }} aria-hidden />
            <span data-art-segments-name="">{s.label}</span>
            <b data-art-segments-value="">{kit.number(s.value, 0)}</b>
            <span data-art-segments-share="">{total > 0 ? kit.percent(s.value / total) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
