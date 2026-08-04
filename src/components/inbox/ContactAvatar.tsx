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
  size?: 'xs' | 'sm' | 'md' | 'lg';
  presence?: AvatarPresence;
  className?: string;
  /** Optional ring color override (defaults to a subtle border to lift it from the row). */
  ringClassName?: string;
}

// Explicit min/max sizing: inside Radix ScrollArea the viewport child uses
// `display: table`, where `shrink-0` does not apply and the avatar could
// collapse to zero width. Locking min/max keeps it always visible.
const SIZE_PX: Record<NonNullable<ContactAvatarProps['size']>, { box: string; px: number; text: string; dot: string }> = {
  xs: { box: 'w-7 h-7',   px: 28, text: 'text-[10px]', dot: 'w-2 h-2' },
  sm: { box: 'w-9 h-9',   px: 36, text: 'text-[12px]', dot: 'w-2.5 h-2.5' },
  md: { box: 'w-10 h-10', px: 40, text: 'text-[13px]', dot: 'w-3 h-3' },
  lg: { box: 'w-12 h-12', px: 48, text: 'text-[15px]', dot: 'w-3.5 h-3.5' },
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
  size = 'md',
  presence = 'none',
  className,
  ringClassName,
}: ContactAvatarProps) {
  const sz = SIZE_PX[size];
  const seed = (name || email || '').toLowerCase();
  const bg = avatarUrl ? undefined : gradientFor(seed);
  const initials = initialsOf(name, email);

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
    </div>
  );
}