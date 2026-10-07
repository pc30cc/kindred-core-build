import { cn } from '@/lib/utils';
import type { PanelThemeInfo } from './registry';

const NAV_WIDTHS = [62, 48, 70, 54, 66, 44];
const BARS = [38, 56, 44, 72, 58, 84, 64, 92, 70];

/**
 * A miniature workspace panel painted with a theme's colours — sidebar, top
 * bar, figures and a chart — for the theme cards on Super Admin → Panel
 * theme. Purely decorative: the card around it carries the theme's name.
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
  const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  const ring = `0 0 0 1px ${s.line}`;

  return (
    <div
      aria-hidden
      className={cn('relative flex aspect-[16/10] w-full select-none overflow-hidden rounded-xl', className)}
      style={{ background: s.canvas, boxShadow: ring }}
    >
      {/* Sidebar */}
      <div
        className="flex w-[24%] shrink-0 flex-col gap-3 p-[2.5%]"
        style={{ background: s.sidebar, borderInlineEnd: theme.inset ? undefined : `1px solid ${s.line}` }}
      >
        <div className="flex items-center gap-1.5 px-[4%] pt-[4%]">
          <span className="aspect-square w-[20%] shrink-0 rounded-[28%]" style={{ background: s.mark }} />
          <span className="h-[5px] flex-1 rounded-full" style={{ background: s.ink, opacity: 0.7 }} />
        </div>
        <div className="flex flex-col gap-1">
          {NAV_WIDTHS.map((width, i) => {
            const active = i === 1;
            const chip = theme.inset
              ? { background: active ? s.primary : s.muted, opacity: active ? 1 : 0.45, borderRadius: '30%' }
              : { background: `linear-gradient(135deg, ${s.accents[i % 4]}, ${s.accents[(i + 1) % 4]})`, borderRadius: '30%' };
            return (
              <div
                key={width}
                className="relative flex items-center gap-1.5 rounded-[5px] px-[5%] py-[4%]"
                style={{
                  background: active ? (theme.inset ? tint(s.ink, 7) : tint(s.primary, 14)) : 'transparent',
                }}
              >
                {active && theme.inset && (
                  <span className="absolute -start-[5%] top-[22%] h-[56%] w-[2px] rounded-full" style={{ background: s.primary }} />
                )}
                <span className="aspect-square w-[15%] shrink-0" style={chip} />
                <span
                  className="h-[4px] rounded-full"
                  style={{ width: `${width}%`, background: active ? s.ink : s.muted, opacity: active ? 0.8 : 0.45 }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Page */}
      <div
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
        style={{
          background: s.surface,
          marginBlock: theme.inset ? '1.6%' : 0,
          marginInlineEnd: theme.inset ? '1.6%' : 0,
          borderRadius: theme.inset ? 10 : 0,
          boxShadow: theme.inset ? `${ring}, 0 8px 18px -12px rgba(40, 28, 18, 0.35)` : undefined,
        }}
      >
        <div className="flex h-[11%] shrink-0 items-center gap-1.5 px-[4%]" style={{ borderBottom: `1px solid ${s.line}` }}>
          <span className="h-[46%] w-[34%] rounded-[5px]" style={{ background: tint(s.muted, 14), boxShadow: ring }} />
          <span className="ms-auto aspect-square h-[36%] rounded-full" style={{ background: tint(s.muted, 40) }} />
          <span className="aspect-square h-[36%] rounded-full" style={{ background: tint(s.muted, 40) }} />
          <span className="aspect-square h-[52%] rounded-full" style={{ background: s.mark }} />
        </div>

        <div className="flex flex-1 flex-col gap-[4%] p-[4%]">
          <div className="flex items-end justify-between gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="h-[7px] w-[42%] rounded-full" style={{ background: s.ink, opacity: 0.85 }} />
              <span className="h-[4px] w-[64%] rounded-full" style={{ background: s.muted, opacity: 0.55 }} />
            </div>
            <span
              className="flex h-[14px] w-[18%] items-center justify-center rounded-[5px]"
              style={{ background: s.primary }}
            >
              <span className="h-[3px] w-[55%] rounded-full" style={{ background: s.primaryInk, opacity: 0.9 }} />
            </span>
          </div>

          <div className="grid grid-cols-3 gap-[3%]">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-1.5 rounded-[7px] p-[7%]"
                style={{
                  background: i === 0 ? `linear-gradient(135deg, ${tint(s.primary, 16)}, ${s.card})` : s.card,
                  boxShadow: ring,
                }}
              >
                <span className="h-[3px] w-[48%] rounded-full" style={{ background: s.muted, opacity: 0.6 }} />
                <span className="h-[7px] w-[62%] rounded-full" style={{ background: s.ink, opacity: 0.85 }} />
                <span className="h-[3px] w-[36%] rounded-full" style={{ background: s.accents[i + 1], opacity: 0.9 }} />
              </div>
            ))}
          </div>

          <div className="flex flex-1 items-end gap-[3%] rounded-[7px] px-[4%] pb-[4%] pt-[6%]" style={{ background: s.card, boxShadow: ring }}>
            {BARS.map((height, i) => (
              <span
                key={height}
                className="flex-1 rounded-t-[3px]"
                style={{ height: `${height}%`, background: i % 3 === 2 ? s.accents[1] : s.accents[0], opacity: i % 3 === 2 ? 0.85 : 1 }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
