/**
 * Call Center → Settings → Presentation: the call button's style (the 2026-10
 * call widget design, boards 01 L1–L9 of both brands; migration 277's
 * `call_center_settings.launcher_style`).
 *
 * Nine tiles in the order of shared/callLauncherStyles.ts, each a small
 * drawing of the launcher on the workspace's colour (the edition's design
 * default while none is set). The stored style is checked as the widget
 * wears it (an unknown or missing one is round_label). Under the tiles, the
 * chosen style's note: card and operator_face publish the names and photos
 * of the operators who are available, mobile_bar exists on phones only,
 * edge_tab sits on a page edge. Disabled while the server has no migration
 * 277 (a rolling deploy): the setting could not be saved yet.
 */
import type { CSSProperties, ReactNode } from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Check, Phone, Video, User } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { CALL_LAUNCHER_STYLES, normalizeCallLauncherStyle, type CallLauncherStyle } from '../../../../shared/callLauncherStyles';

export interface CallLauncherStylePickerProps {
  /** The stored launcher_style (any string; unknown reads as round_label). */
  value: string | null | undefined;
  onChange: (style: CallLauncherStyle) => void;
  /** The workspace's primary colour; empty: the edition's design default. */
  accent?: string | null;
  /** International edition (its design default colour and ink). */
  international: boolean;
  /** The server cannot store the style yet (no migration 277). */
  disabled?: boolean;
}

/** The design defaults (tokens.json): WebYar's teal and ink, Respok's Ink. */
const ACCENT_DEFAULT = { iran: '#0B7D6C', international: '#16142B' } as const;
const INK = { iran: '#0F1217', international: '#16142B' } as const;
const LIVE = '#12A150';
const HEX = /^#[0-9a-f]{6}$/i;

/** White or the ink on a colour, whichever reads better (the widget's own rule for `--on-a`). */
function onColour(hex: string, ink: string): string {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const bg = lum(hex);
  return contrast(bg, 1) >= contrast(bg, lum(ink)) ? '#FFFFFF' : ink;
}

const HINTS: Partial<Record<CallLauncherStyle, 'launcherStyleHintPresence' | 'launcherStyleHintMobileBar' | 'launcherStyleHintEdge'>> = {
  card: 'launcherStyleHintPresence',
  operator_face: 'launcherStyleHintPresence',
  mobile_bar: 'launcherStyleHintMobileBar',
  edge_tab: 'launcherStyleHintEdge',
};

export function CallLauncherStylePicker({ value, onChange, accent, international, disabled = false }: CallLauncherStylePickerProps) {
  const { t } = useTranslation();
  const edition = international ? 'international' : 'iran';
  const colour = HEX.test(String(accent || '').trim()) ? String(accent).trim() : ACCENT_DEFAULT[edition];
  const ink = INK[edition];
  const on = onColour(colour, ink);
  const selected = normalizeCallLauncherStyle(value);
  const hint = HINTS[selected];

  const fill: CSSProperties = { background: colour, color: on };
  /** A text line, drawn as a bar. */
  const bar = (w: string, tone: 'ink' | 'soft' | 'on' = 'soft') => (
    <span
      aria-hidden
      className={cn('block h-1.5 rounded-full', w)}
      style={{ background: tone === 'ink' ? ink : tone === 'on' ? on : '#D5D9DE', opacity: tone === 'on' ? 0.75 : 1 }}
    />
  );
  const dot = <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LIVE }} />;
  const label = (
    <span className="flex flex-col gap-1 rounded-lg bg-white px-2 py-1.5 shadow-sm ring-1 ring-black/5">
      {bar('w-10', 'ink')}
      <span className="flex items-center gap-1">{dot}{bar('w-7')}</span>
    </span>
  );
  const round = (size: string, icon: ReactNode = <Phone className="h-4 w-4" strokeWidth={2.2} />) => (
    <span data-accent className={cn('flex shrink-0 items-center justify-center rounded-full shadow-md', size)} style={fill}>{icon}</span>
  );

  const art: Record<CallLauncherStyle, ReactNode> = {
    round: round('h-10 w-10'),
    round_label: <span className="flex items-center gap-1.5">{label}{round('h-9 w-9')}</span>,
    pill: (
      <span data-accent className="flex h-9 items-center gap-1.5 rounded-full pe-3 ps-2.5 shadow-md" style={fill}>
        <Phone className="h-4 w-4" strokeWidth={2.2} />{bar('w-9', 'on')}
      </span>
    ),
    card: (
      <span className="flex items-center gap-2 rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5">
        <span className="flex -space-x-1.5 rtl:space-x-reverse">
          {['#FCE3D4', '#DCEBFF', '#E4F4E8'].map((c) => (
            <span key={c} className="block h-4 w-4 rounded-full ring-2 ring-white" style={{ background: c }} />
          ))}
        </span>
        <span className="flex flex-col gap-1">{bar('w-9', 'ink')}<span className="flex items-center gap-1">{dot}{bar('w-6')}</span></span>
        {round('h-6 w-6', <Phone className="h-3 w-3" strokeWidth={2.4} />)}
      </span>
    ),
    split: (
      <span data-accent className="flex h-9 items-stretch overflow-hidden rounded-full shadow-md" style={fill}>
        <span className="flex items-center px-3"><Phone className="h-4 w-4" strokeWidth={2.2} /></span>
        <span aria-hidden className="my-2 w-px" style={{ background: on, opacity: 0.35 }} />
        <span className="flex items-center px-3"><Video className="h-4 w-4" strokeWidth={2.2} /></span>
      </span>
    ),
    edge_tab: (
      <span className="relative flex h-12 w-20 items-center justify-end rounded-md bg-white ring-1 ring-black/5">
        <span data-accent className="flex h-11 w-5 flex-col items-center justify-center gap-1 rounded-s-md shadow-md" style={fill}>
          <Phone className="h-3 w-3" strokeWidth={2.4} />
          <span aria-hidden className="block h-4 w-1 rounded-full" style={{ background: on, opacity: 0.75 }} />
        </span>
      </span>
    ),
    dark_square: (
      <span className="flex h-10 w-10 items-center justify-center rounded-xl shadow-md" style={{ background: ink, color: '#FFFFFF' }}>
        <Phone className="h-4 w-4" strokeWidth={2.2} />
      </span>
    ),
    operator_face: (
      <span className="flex items-center gap-1.5">
        {label}
        <span className="relative">
          <span data-accent className="flex h-10 w-10 items-center justify-center rounded-full p-0.5 shadow-md" style={fill}>
            <span className="flex h-full w-full items-center justify-center rounded-full" style={{ background: '#FCE3D4', color: '#8A3410' }}>
              <User className="h-4 w-4" strokeWidth={2.2} />
            </span>
          </span>
          <span aria-hidden className="absolute bottom-0 end-0 h-2.5 w-2.5 rounded-full border-2 border-white" style={{ background: LIVE }} />
        </span>
      </span>
    ),
    mobile_bar: (
      <span className="relative flex h-14 w-10 items-end justify-center overflow-hidden rounded-lg bg-white p-1 ring-1 ring-black/10">
        <span data-accent className="flex h-3.5 w-full items-center justify-center gap-1 rounded" style={fill}>
          <Phone className="h-2.5 w-2.5" strokeWidth={2.6} />
          <Video className="h-2.5 w-2.5" strokeWidth={2.6} />
        </span>
      </span>
    ),
  };

  return (
    <div className="space-y-2" data-call-launcher-styles>
      <p className="text-xs font-medium">{t('callCenter.settingsPage.launcherStyle')}</p>
      <p className="text-[11px] text-muted-foreground">{t('callCenter.settingsPage.launcherStyleHint')}</p>
      <RadioGroupPrimitive.Root
        aria-label={t('callCenter.settingsPage.launcherStyle')}
        value={selected}
        disabled={disabled}
        onValueChange={(v) => onChange(normalizeCallLauncherStyle(v))}
        className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3', disabled && 'opacity-50')}
      >
        {CALL_LAUNCHER_STYLES.map((id) => (
          <RadioGroupPrimitive.Item
            key={id}
            value={id}
            disabled={disabled}
            data-call-launcher-style={id}
            className={cn(
              'relative flex flex-col items-center gap-2 rounded-xl border bg-background px-2 pb-2.5 pt-3 text-center transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-60',
              selected === id ? 'border-foreground ring-1 ring-foreground' : 'border-border/70 hover:border-foreground/25',
            )}
          >
            {selected === id && (
              <span className="absolute start-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background">
                <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
              </span>
            )}
            <span aria-hidden data-launcher-art className="flex h-16 w-full items-center justify-center rounded-lg bg-muted/40">
              {art[id]}
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-xs font-medium">{t(`callCenter.settingsPage.launcherStyles.${id}.name`)}</span>
              <span className="text-[10px] text-muted-foreground">{t(`callCenter.settingsPage.launcherStyles.${id}.sub`)}</span>
            </span>
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
      {hint && !disabled && <p className="text-[11px] text-muted-foreground">{t(`callCenter.settingsPage.${hint}`)}</p>}
      {disabled && <p className="text-[11px] text-warning">{t('callCenter.settingsPage.designSettingsPending')}</p>}
    </div>
  );
}
