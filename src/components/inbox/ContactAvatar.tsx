/**
 * Professional contact avatar with stable hash-based gradient, initials,
 * and an optional online indicator dot.
 *
 * - Same name → always same gradient (deterministic hue).
 * - Falls back to email or '?' when name is missing.
 * - Honors `avatar_url` when provided.
 * - All colors use semantic tokens; gradients are HSL within the
 *   project's allowed range (matches the blue-leaning palette).
 */
import { cn } from '@/lib/utils';
import { OsIcon } from '@/components/visitors/OsIcon';

/** OS brand identity used when a contact has no picture but we know the device. */
type OsKind = 'apple' | 'windows' | 'linux' | 'android' | null;

function osKindOf(os?: string | null, device?: string | null): OsKind {
  const o = (os || '').toLowerCase();
  if (!o) return null;
  if (o.includes('mac') || o.includes('ios') || /iphone|ipad/.test(o)) return 'apple';
  if (o.includes('win')) return 'windows';
  if (o.includes('android')) return 'android';
  if (o.includes('linux') || o.includes('ubuntu')) return 'linux';
  return null;
}

/** Rich, brand-accurate gradients (kept in sync with the visitors OS chips). */
const OS_GRADIENT: Record<Exclude<OsKind, null>, string> = {
  apple:   'linear-gradient(140deg, hsl(220 8% 42%), hsl(220 12% 16%))',
  windows: 'linear-gradient(140deg, hsl(201 92% 56%), hsl(217 90% 44%))',
  linux:   'linear-gradient(140deg, hsl(38 96% 58%), hsl(22 90% 48%))',
  android: 'linear-gradient(140deg, hsl(150 68% 50%), hsl(142 72% 34%))',
};

/** ISO-3166 alpha-2 → regional-indicator flag emoji. */
function flagOf(code?: string | null): string | null {
  const cc = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return h >>> 0;
}

function gradientFor(seed: string): string {
  // Cycle through 12 visually distinct hues, all with consistent saturation
  // and lightness so every avatar feels part of the same family.
  const palette = [
    [212, 92], [262, 78], [192, 78], [152, 62],
    [172, 70], [232, 88], [292, 70], [332, 78],
    [16, 86], [36, 90], [142, 64], [202, 88],
  ] as const;
  const idx = djb2(seed || '?') % palette.length;
  const [h, h2off] = [palette[idx][0], 28];
  const s = palette[idx][1];
  const a = `hsl(${h} ${s}% 56%)`;
  const b = `hsl(${(h + h2off) % 360} ${s}% 44%)`;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function initialsOf(name?: string | null, email?: string | null): string {
  const src = (name || email || '').trim();
  if (!src) return '?';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  // Single token: use first character (and second character if available).
  if (parts[0].length >= 2) return (parts[0][0] + parts[0][1]).toUpperCase();
  return parts[0][0].toUpperCase();
}

export type AvatarPresence = 'online' | 'idle' | 'offline' | 'none';

export interface ContactAvatarProps {
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  /** Visitor OS string (e.g. "Windows", "macOS", "Android"). */
  os?: string | null;
  /** Visitor device class ("desktop" | "mobile" | "tablet"). */
  device?: string | null;
  /** ISO alpha-2 country code of the visitor's IP — renders a flag badge. */
  countryCode?: string | null;
  /** Human-readable country name, used as the flag badge tooltip. */
  countryName?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  presence?: AvatarPresence;
  className?: string;
  /** Optional ring color override (defaults to a subtle border to lift it from the row). */
  ringClassName?: string;
}

// Explicit min/max sizing: inside Radix ScrollArea the viewport child uses
// `display: table`, where `shrink-0` does not apply and the avatar could
// collapse to zero width. Locking min/max keeps it always visible.
const SIZE_PX: Record<NonNullable<ContactAvatarProps['size']>, { box: string; px: number; text: string; dot: string; flag: number }> = {
  xs: { box: 'w-7 h-7',   px: 28, text: 'text-[10px]', dot: 'w-2 h-2',     flag: 13 },
  sm: { box: 'w-9 h-9',   px: 36, text: 'text-[12px]', dot: 'w-2.5 h-2.5', flag: 15 },
  md: { box: 'w-10 h-10', px: 40, text: 'text-[13px]', dot: 'w-3 h-3',     flag: 16 },
  lg: { box: 'w-12 h-12', px: 48, text: 'text-[15px]', dot: 'w-3.5 h-3.5', flag: 18 },
};

const PRESENCE_DOT: Record<AvatarPresence, string> = {
  online: 'bg-emerald-500',
  idle:   'bg-amber-500',
  offline:'bg-muted-foreground/40',
  none:   '',
};

export function ContactAvatar({
  name,
  email,
  avatarUrl,
  os,
  device,
  countryCode,
  countryName,
  size = 'md',
  presence = 'none',
  className,
  ringClassName,
}: ContactAvatarProps) {
  const sz = SIZE_PX[size];
  const seed = (name || email || '').toLowerCase();
  const initials = initialsOf(name, email);
  const osKind = avatarUrl ? null : osKindOf(os, device);
  const bg = avatarUrl ? undefined : osKind ? OS_GRADIENT[osKind] : gradientFor(seed);
  const glyphPx = Math.round(sz.px * 0.5);
  const flag = flagOf(countryCode);

  return (
    <div
      className={cn('relative shrink-0 inline-block align-middle', className)}
      style={{ width: sz.px, height: sz.px, minWidth: sz.px, minHeight: sz.px }}
    >
      <div
        className={cn(
          sz.box,
          'rounded-full overflow-hidden flex items-center justify-center font-semibold text-white select-none',
          'ring-1',
          ringClassName ?? 'ring-border/40',
          sz.text,
        )}
        style={{
          width: sz.px,
          height: sz.px,
          minWidth: sz.px,
          minHeight: sz.px,
          ...(bg ? { backgroundImage: bg } : null),
        }}
        aria-hidden="true"
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : osKind ? (
          <span className="relative flex items-center justify-center w-full h-full">
            {/* soft top-light for a glossy, premium finish */}
            <span
              className="absolute inset-0 opacity-70"
              style={{ backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,.28), rgba(255,255,255,0) 55%)' }}
            />
            <OsIcon
              os={os}
              device={device}
              className="relative drop-shadow-[0_1px_2px_rgba(0,0,0,.35)]"
              style={{ width: glyphPx, height: glyphPx }}
              {...(osKind === 'apple' ? { fill: 'currentColor' } : null)}
            />
          </span>
        ) : (
          <span className="leading-none drop-shadow-sm">{initials}</span>
        )}
      </div>
      {presence !== 'none' && (
        <span
          className={cn(
            'absolute -bottom-0.5 -end-0.5 rounded-full border-2 border-card',
            sz.dot,
            PRESENCE_DOT[presence],
          )}
          aria-label={presence}
        />
      )}
      {flag && (
        <span
          title={countryName || countryCode || undefined}
          aria-label={countryName || countryCode || undefined}
          className="absolute -bottom-1 -start-1 flex items-center justify-center rounded-full bg-card ring-1 ring-border/70 shadow-sm overflow-hidden"
          style={{ width: sz.flag, height: sz.flag, fontSize: Math.round(sz.flag * 0.72), lineHeight: 1 }}
        >
          <span className="translate-y-[0.5px]">{flag}</span>
        </span>
      )}
    </div>
  );
}