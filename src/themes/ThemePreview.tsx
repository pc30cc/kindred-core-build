import { cn } from '@/lib/utils';
import { previewSwatches, type ArtPreviewOptions, type PanelThemeInfo, type PanelThemeSwatches } from './registry';
import type { ArtLayout } from '../../shared/panelThemes';

const NAV_WIDTHS = [62, 48, 70, 54, 66, 44];
const SIDE_WIDTHS = [58, 72, 50, 64, 46, 68, 54];
const PILL_WIDTHS = [11, 9, 12, 10, 9];
const BARS = [38, 56, 44, 72, 58, 84, 64, 92, 70];

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

type Mode = 'light' | 'dark';

/**
 * A miniature workspace panel painted with a theme's colours and drawn in its
 * layout (a sidebar rail; a top bar with navigation pills; or, for Art's
 * side-menu layout, an inset menu panel) — for the theme cards on Super
 * Admin → Panel theme. Purely decorative: the card around it carries the
 * theme's name. `art`: Art's chosen layout and colour scheme.
 */
export function ThemePreview({
  theme,
  mode,
  art,
  className,
}: {
  theme: PanelThemeInfo;
  mode: Mode;
  art?: ArtPreviewOptions;
  className?: string;
}) {
  const s = previewSwatches(theme, mode, art?.palette);
  const ring = `0 0 0 1px ${s.line}`;
  const frame = theme.id === 'art' && art ? (art.layout === 'sidebar' ? 'inset' : 'topnav') : theme.layout;

  return (
    <div
      aria-hidden
      data-preview-frame={frame}
      className={cn(
        'relative flex aspect-[16/10] w-full select-none overflow-hidden rounded-xl',
        frame === 'topnav' && 'flex-col',
        frame === 'inset' && 'gap-[2%] p-[2%]',
        className,
      )}
      style={{ background: s.canvas, boxShadow: ring }}
    >
      {frame === 'topnav' ? <TopBar s={s} /> : frame === 'inset' ? <InsetSide s={s} /> : <SideRail s={s} />}
      <Page s={s} variant={frame === 'sidebar' ? 'classic' : frame} />
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

/**
 * Art's side menu: an inset panel a step deeper than the paper, with the
 * workspace, a search field, grouped rows (one current, as a tinted pill)
 * and the account at its foot.
 */
function InsetSide({ s }: { s: PanelThemeSwatches }) {
  return (
    <div
      className="flex w-[23%] shrink-0 flex-col gap-[5%] rounded-[10px] p-[2%]"
      style={{ background: s.sidebar, boxShadow: `0 0 0 1px ${s.line}` }}
    >
      <div className="flex items-center gap-1.5 px-[5%] pt-[5%]">
        <span className="aspect-square w-[18%] shrink-0 rounded-[30%]" style={{ background: s.mark }} />
        <span className="h-[5px] w-[52%] rounded-full" style={{ background: s.ink, opacity: 0.75 }} />
      </div>
      <span className="mx-[4%] h-[9%] max-h-[14px] rounded-full" style={{ background: s.card, boxShadow: `0 0 0 1px ${s.line}` }} />
      <div className="flex flex-col gap-[3px] px-[2%]">
        {SIDE_WIDTHS.map((width, i) => {
          const active = i === 1;
          return (
            <div key={i} className="flex flex-col">
              {(i === 1 || i === 4) && (
                <span className="mb-[3px] ms-[8%] mt-[4px] h-[2px] w-[26%] rounded-full" style={{ background: s.muted, opacity: 0.4 }} />
              )}
              <div
                className="flex items-center gap-1.5 rounded-full px-[7%] py-[3.5%]"
                style={{ background: active ? tint(s.primary, 14) : 'transparent' }}
              >
                <span
                  className="aspect-square w-[9%] shrink-0 rounded-full"
                  style={{ background: active ? s.primary : s.muted, opacity: active ? 1 : 0.45 }}
                />
                <span
                  className="h-[3px] rounded-full"
                  style={{ width: `${width}%`, background: active ? s.primary : s.ink, opacity: active ? 0.95 : 0.4 }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-auto flex items-center gap-1.5 px-[5%] pb-[5%] pt-[4%]" style={{ borderTop: `1px solid ${s.line}` }}>
        <span className="aspect-square w-[14%] shrink-0 rounded-full" style={{ background: tint(s.muted, 45) }} />
        <span className="h-[3px] w-[40%] rounded-full" style={{ background: s.ink, opacity: 0.55 }} />
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
          key={i}
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

/**
 * The page: a title with its main button, three figures and a chart.
 * `classic`: beside the classic rail, under its own top bar; `topnav`: a
 * centred column; `inset`: on the paper beside Art's side menu.
 */
function Page({ s, variant }: { s: PanelThemeSwatches; variant: 'classic' | 'topnav' | 'inset' }) {
  const ring = `0 0 0 1px ${s.line}`;
  const art = variant !== 'classic';
  const radius = art ? 9 : 7;
  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: variant === 'inset' ? 'transparent' : s.surface }}
    >
      {variant === 'classic' && (
        <div className="flex h-[11%] shrink-0 items-center gap-1.5 px-[4%]" style={{ borderBottom: `1px solid ${s.line}` }}>
          <span className="h-[46%] w-[34%] rounded-[5px]" style={{ background: tint(s.muted, 14), boxShadow: ring }} />
          <span className="ms-auto aspect-square h-[36%] rounded-full" style={{ background: tint(s.muted, 40) }} />
          <span className="aspect-square h-[52%] rounded-full" style={{ background: s.mark }} />
        </div>
      )}
      <div
        className={cn(
          'flex flex-1 flex-col gap-[4%]',
          variant === 'topnav' ? 'px-[12%] py-[4%]' : variant === 'inset' ? 'px-[5%] py-[5%]' : 'px-[4%] py-[4%]',
        )}
      >
        <div className="flex items-end justify-between gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="h-[8px] w-[40%] rounded-full" style={{ background: s.ink, opacity: 0.85 }} />
            <span className="h-[4px] w-[62%] rounded-full" style={{ background: s.muted, opacity: 0.55 }} />
          </div>
          <span
            className={cn('flex h-[15px] w-[18%] items-center justify-center', art ? 'rounded-full' : 'rounded-[5px]')}
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
                background: i === 0 && !art ? `linear-gradient(135deg, ${tint(s.primary, 16)}, ${s.card})` : s.card,
                boxShadow: ring,
              }}
            >
              <span className="h-[3px] w-[48%] rounded-full" style={{ background: s.muted, opacity: 0.6 }} />
              <span className="h-[7px] w-[62%] rounded-full" style={{ background: s.ink, opacity: 0.85 }} />
              <span className="h-[3px] w-[36%] rounded-full" style={{ background: art ? s.accents[i] : s.accents[i + 1], opacity: 0.9 }} />
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
              className={art ? 'flex-1 rounded-full' : 'flex-1 rounded-t-[3px]'}
              style={{ height: `${height}%`, background: i % 3 === 2 ? s.accents[1] : s.accents[0], opacity: i % 3 === 2 ? 0.85 : 1 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A small sketch of one of Art's layouts, for the layout choice on Super
 * Admin → Panel theme: the top menu (a bar with pills over a centred page) or
 * the side menu (an inset panel beside the page), in the chosen colours.
 * Mirrors with the page's direction, as the real frame does.
 */
export function ArtLayoutSketch({ layout, swatches: s }: { layout: ArtLayout; swatches: PanelThemeSwatches }) {
  const ring = `0 0 0 1px ${s.line}`;
  const page = (
    <span className="flex min-w-0 flex-1 flex-col gap-[7%]">
      <span className="flex items-center justify-between gap-[6%]">
        <span className="h-[6px] w-[42%] rounded-full" style={{ background: s.ink, opacity: 0.7 }} />
        <span className="h-[7px] w-[18%] rounded-full" style={{ background: s.primary }} />
      </span>
      <span className="grid h-[20%] grid-cols-3 gap-[5%]">
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex items-end rounded-[4px] p-[8%]" style={{ background: s.card, boxShadow: ring }}>
            <span className="h-[3px] w-[60%] rounded-full" style={{ background: s.accents[i], opacity: 0.9 }} />
          </span>
        ))}
      </span>
      <span className="flex flex-1 items-end gap-[5%] rounded-[4px] px-[6%] pb-[5%] pt-[8%]" style={{ background: s.card, boxShadow: ring }}>
        {[46, 70, 54, 88, 62, 78].map((h, i) => (
          <span key={i} className="flex-1 rounded-full" style={{ height: `${h}%`, background: i % 3 === 2 ? s.accents[1] : s.accents[0] }} />
        ))}
      </span>
    </span>
  );
  return (
    <span
      aria-hidden
      className={cn('flex aspect-[16/10] w-full overflow-hidden rounded-lg', layout === 'topnav' ? 'flex-col' : 'gap-[4%] p-[4%]')}
      style={{ background: s.canvas, boxShadow: ring }}
    >
      {layout === 'topnav' ? (
        <>
          <span className="flex h-[17%] shrink-0 items-center gap-[3%] px-[6%]" style={{ background: s.surface, boxShadow: `inset 0 -1px 0 ${s.line}` }}>
            <span className="aspect-square h-[50%] rounded-[30%]" style={{ background: s.mark }} />
            {[15, 11, 13, 10].map((w, i) => (
              <span
                key={i}
                className="h-[38%] rounded-full"
                style={{ width: `${w}%`, background: i === 0 ? tint(s.primary, 22) : tint(s.muted, 16) }}
              />
            ))}
            <span className="ms-auto aspect-square h-[46%] rounded-full" style={{ background: tint(s.muted, 30) }} />
          </span>
          <span className="flex min-h-0 flex-1 px-[16%] py-[6%]">{page}</span>
        </>
      ) : (
        <>
          <span className="flex w-[27%] shrink-0 flex-col gap-[6%] rounded-[6px] p-[4%]" style={{ background: s.sidebar, boxShadow: ring }}>
            <span className="flex items-center gap-[8%]">
              <span className="aspect-square w-[24%] rounded-[30%]" style={{ background: s.mark }} />
              <span className="h-[4px] w-[50%] rounded-full" style={{ background: s.ink, opacity: 0.6 }} />
            </span>
            {[86, 70, 78, 62, 74].map((w, i) => (
              <span
                key={i}
                className="h-[8%] rounded-full"
                style={{ width: `${w}%`, background: i === 1 ? tint(s.primary, 24) : tint(s.muted, 16) }}
              />
            ))}
            <span className="mt-auto aspect-square w-[22%] rounded-full" style={{ background: tint(s.muted, 30) }} />
          </span>
          <span className="flex min-h-0 min-w-0 flex-1 py-[4%] pe-[2%]">{page}</span>
        </>
      )}
    </span>
  );
}
