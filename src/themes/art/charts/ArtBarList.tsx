/**
 * Art's ranked bars: a "top N" chart drawn as a list — each row the
 * category's name and its value on one line, and a thin rounded bar under
 * them, as long as the value is against the largest (or against `max`, e.g.
 * 100 for a score). The values are written out, so there is nothing to hover
 * for, and long names (URLs, keywords, domains) keep their own line in either
 * direction. Its look is charts.css (`data-art-bar-list`).
 */
import type { ReactNode } from 'react';
import { artSeriesColor, formatArtNumber } from './format';

export interface ArtBarItem {
  key: string;
  label: ReactNode;
  value: number;
  /** The value as written (default: the exact, grouped number). */
  display?: ReactNode;
  /** The full name, shown on hover when the label is cut. */
  title?: string;
  /** A status the bar takes instead of the series colour (e.g. a score's band). */
  tone?: 'good' | 'warn' | 'bad';
  /** The label's text direction when it differs from the page's (URLs, domains). */
  labelDir?: 'ltr' | 'rtl' | 'auto';
}

export function ArtBarList({
  items,
  locale,
  n = 1,
  max,
  className,
}: {
  items: ArtBarItem[];
  locale: string;
  /** The bars' colour number (1 ... 6) when an item has no `tone`. */
  n?: number;
  /** The value of a full bar (default: the largest value). */
  max?: number;
  className?: string;
}) {
  const top = max ?? Math.max(0, ...items.map((i) => (Number.isFinite(i.value) ? i.value : 0)));
  return (
    <ol data-art-bar-list="" className={className}>
      {items.map((item, index) => {
        const share = top > 0 ? Math.max(0, Math.min(1, item.value / top)) : 0;
        return (
          <li key={item.key} data-art-bar-row="" style={{ ['--art-bar-delay' as string]: `${index * 40}ms` }}>
            <div data-art-bar-head="">
              <span data-art-bar-label="" title={item.title} dir={item.labelDir}>{item.label}</span>
              <span data-art-bar-value="">{item.display ?? formatArtNumber(item.value, locale)}</span>
            </div>
            <div data-art-bar-track="" aria-hidden>
              <span
                data-art-bar-fill=""
                data-zero={share > 0 ? undefined : ''}
                data-tone={item.tone}
                style={{
                  width: `${(share * 100).toFixed(2)}%`,
                  ...(item.tone ? {} : { backgroundColor: artSeriesColor(n) }),
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
