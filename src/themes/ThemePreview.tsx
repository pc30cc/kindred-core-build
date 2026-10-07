import { cn } from '@/lib/utils';
import type { PanelThemeInfo, PanelThemeSwatches } from './registry';

const NAV_WIDTHS = [62, 48, 70, 54, 66, 44];
const PILL_WIDTHS = [11, 9, 12, 10, 9];
const BARS = [38, 56, 44, 72, 58, 84, 64, 92, 70];

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/**
 * A miniature workspace panel painted with a theme's colours and drawn in its
 * layout (a sidebar rail, or a top bar with navigation pills) — for the theme
 * cards on Super Admin → Panel theme. Purely decorative: the card around it
 * carries the theme's name.
 */
export function ThemePreview({
  theme,
  mode,
  className,
}: {
  theme: PanelThemeInfo;
  mode: 'light' | 'dark';
  className?: string;
}) {
  const s = theme[mode];
  const ring = `0 0 0 1px ${s.line}`;

  return (
    <div
      aria-hidden
      className={cn(
        'relative flex aspect-[16/10] w-full select-none overflow-hidden rounded-xl',
        theme.layout === 'topnav' && 'flex-col',
        className,
      )}
      style={{ background: s.canvas, boxShadow: ring }}
    >
      {theme.layout === 'topnav' ? <TopBar s={s} /> : <SideRail s={s} />}
      <Page s={s} centred={theme.layout === 'topnav'} />
    </div>
  );
}

/** A sidebar rail with colourful icon chips (the classic frame). */
function SideRail({ s }: { s: PanelThemeSwatches }) {
  return (
    <div className="flex w-[24%] shrink-0 flex-col gap-3 p-[2.5%]" style={{ background: s.sidebar, borderInlineEnd: `1px solid ${s.line}` }}>
      <div className="flex items-center gap-1.5 px-[4%] pt-[4%]">
        <span className="aspect-square w-[20%] shrink-0 rounded-[28%]" style={{ background: s.mark }} />
        <span className="h-[5px] flex-1 rounded-full" style={{ background: s.ink, opacity: 0.7 }} />
      </div>
      <div className="flex flex-col gap-1">
        {NAV_WIDTHS.map((width, i) => {
          const active = i === 1;
          return (
            <div
              key={width}
              className="flex items-center gap-1.5 rounded-[5px] px-[5%] py-[4%]"
              style={{ background: active ? tint(s.primary, 14) : 'transparent' }}
            >
              <span
                className="aspect-square w-[15%] shrink-0 rounded-[30%]"
                style={{ background: `linear-gradient(135deg, ${s.accents[i % 4]}, ${s.accents[(i + 1) % 4]})` }}
              />
              <span
                className="h-[4px] rounded-full"
                style={{ width: `${width}%`, background: active ? s.ink : s.muted, opacity: active ? 0.8 : 0.45 }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A top bar: workspace mark, navigation pills (one current), search and avatar. */
function TopBar({ s }: { s: PanelThemeSwatches }) {
  return (
    <div className="flex h-[12%] shrink-0 items-center gap-[1.5%] px-[3%]" style={{ background: s.surface, boxShadow: `inset 0 -1px 0 ${s.line}` }}>
      <span className="aspect-square h-[46%] shrink-0 rounded-[30%]" style={{ background: s.mark }} />
      <span className="me-[2%] h-[5px] w-[9%] rounded-full" style={{ background: s.ink, opacity: 0.75 }} />
      {PILL_WIDTHS.map((width, i) => (
        <span
          key={width + i}
          className="flex h-[44%] items-center justify-center rounded-full"
          style={{ width: `${width}%`, background: i === 1 ? tint(s.primary, 14) : 'transparent' }}
        >
          <span className="h-[3px] w-[60%] rounded-full" style={{ background: i === 1 ? s.primary : s.muted, opacity: i === 1 ? 1 : 0.5 }} />
        </span>
      ))}
      <span className="ms-auto h-[46%] w-[14%] rounded-full" style={{ background: tint(s.muted, 14), boxShadow: `0 0 0 1px ${s.line}` }} />
      <span className="aspect-square h-[46%] rounded-full" style={{ background: s.mark }} />
    </div>
  );
}

/** The page: a title with its main button, three figures and a chart. */
function Page({ s, centred }: { s: PanelThemeSwatches; centred: boolean }) {
  const ring = `0 0 0 1px ${s.line}`;
  const radius = centred ? 9 : 7;
  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden" style={{ background: s.surface }}>
      {!centred && (
        <div className="flex h-[11%] shrink-0 items-center gap-1.5 px-[4%]" style={{ borderBottom: `1px solid ${s.line}` }}>
          <span className="h-[46%] w-[34%] rounded-[5px]" style={{ background: tint(s.muted, 14), boxShadow: ring }} />
          <span className="ms-auto aspect-square h-[36%] rounded-full" style={{ background: tint(s.muted, 40) }} />
          <span className="aspect-square h-[52%] rounded-full" style={{ background: s.mark }} />
        </div>
      )}
      <div className={cn('flex flex-1 flex-col gap-[4%] py-[4%]', centred ? 'px-[12%]' : 'px-[4%]')}>
        <div className="flex items-end justify-between gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="h-[8px] w-[40%] rounded-full" style={{ background: s.ink, opacity: 0.85 }} />
            <span className="h-[4px] w-[62%] rounded-full" style={{ background: s.muted, opacity: 0.55 }} />
          </div>
          <span
            className={cn('flex h-[15px] w-[18%] items-center justify-center', centred ? 'rounded-full' : 'rounded-[5px]')}
            style={{ background: s.primary }}
          >
            <span className="h-[3px] w-[55%] rounded-full" style={{ background: s.primaryInk, opacity: 0.9 }} />
          </span>
        </div>

        <div className="grid grid-cols-3 gap-[3%]">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex flex-col gap-1.5 p-[7%]"
              style={{
                borderRadius: radius,
                background: i === 0 && !centred ? `linear-gradient(135deg, ${tint(s.primary, 16)}, ${s.card})` : s.card,
                boxShadow: ring,
              }}
            >
              <span className="h-[3px] w-[48%] rounded-full" style={{ background: s.muted, opacity: 0.6 }} />
              <span className="h-[7px] w-[62%] rounded-full" style={{ background: s.ink, opacity: 0.85 }} />
              <span className="h-[3px] w-[36%] rounded-full" style={{ background: centred ? s.primary : s.accents[i + 1], opacity: 0.9 }} />
            </div>
          ))}
        </div>

        <div
          className="flex flex-1 items-end gap-[3%] px-[4%] pb-[4%] pt-[6%]"
          style={{ borderRadius: radius, background: s.card, boxShadow: ring }}
        >
          {BARS.map((height, i) => (
            <span
              key={height}
              className={centred ? 'flex-1 rounded-full' : 'flex-1 rounded-t-[3px]'}
              style={{ height: `${height}%`, background: i % 3 === 2 ? s.accents[1] : s.accents[0], opacity: i % 3 === 2 ? 0.85 : 1 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
