/**
 * OS-aware avatar icon for visitors.
 *
 * Picks a brand-appropriate Lucide glyph based on the OS string captured
 * by the widget loader (`detectOS()`):
 * Two render shapes:
 *  - <OsIcon ... />     → bare glyph (inherits color via className)
 *  - <OsAvatar ... />   → filled circle in the brand color of that OS,
 *                        sized to fill the parent (Crisp/Intercom style).
 */
import { Apple, Smartphone, MonitorSmartphone, type LucideProps } from 'lucide-react';
import type { SVGProps } from 'react';

interface Props extends Omit<LucideProps, 'name'> {
  os?: string | null;
  device?: string | null;
}

function WindowsGlyph(props: SVGProps<SVGSVGElement>) {
  // Simple 4-pane Windows monogram.
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M3 5.5l8-1.1v7.1H3V5.5zm0 13l8 1.1v-7H3v5.9zm9 1.2l9 1.3v-8.5h-9v7.2zm0-15.4l9-1.3v8.5h-9V4.3z" />
    </svg>
  );
}

function LinuxGlyph(props: SVGProps<SVGSVGElement>) {
  // Tux-inspired silhouette (simplified).
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 2.4c-2 0-3.4 1.7-3.4 3.9 0 1 .3 1.9.7 2.6-.9.6-1.8 1.6-2.4 2.9-.9 2-1.4 4-2.2 5.5-.4.7-.9 1.2-.9 1.8 0 .8.8 1.3 1.7 1.5.7.2 1.4.3 1.7.6.4.4.8 1 2.1 1.2 1 .2 2.1-.1 2.7-.5.6.4 1.7.7 2.7.5 1.3-.2 1.7-.8 2.1-1.2.3-.3 1-.4 1.7-.6.9-.2 1.7-.7 1.7-1.5 0-.6-.5-1.1-.9-1.8-.8-1.5-1.3-3.5-2.2-5.5-.6-1.3-1.5-2.3-2.4-2.9.4-.7.7-1.6.7-2.6 0-2.2-1.4-3.9-3.4-3.9zm-1.4 4.1c.3 0 .5.4.5.9 0 .2 0 .4-.1.5-.1-.1-.3-.1-.4-.1-.4 0-.7.3-.7.7v.1c-.2-.2-.3-.5-.3-.8 0-.7.5-1.3 1-1.3zm2.8 0c.5 0 1 .6 1 1.3 0 .3-.1.6-.3.8v-.1c0-.4-.3-.7-.7-.7-.1 0-.3 0-.4.1-.1-.1-.1-.3-.1-.5 0-.5.2-.9.5-.9z" />
    </svg>
  );
}

/** Resolve OS string → brand identity (background gradient + foreground). */
type OsKind = 'apple' | 'windows' | 'linux' | 'android' | 'other';

function resolveOsKind(os?: string | null, device?: string | null): OsKind {
  const o = (os || '').toLowerCase();
  const d = (device || '').toLowerCase();
  if (o.includes('mac') || o === 'macos' || o === 'ios' || /iphone|ipad/.test(o)) return 'apple';
  if (o.includes('win')) return 'windows';
  if (o.includes('linux')) return 'linux';
  if (o.includes('android')) return 'android';
  if (d === 'mobile') return 'other';
  return 'other';
}

/**
 * Brand-coloured chip backgrounds. We use Tailwind utility classes so they
 * theme correctly in light/dark mode, with a soft gradient + foreground for
 * a polished, recognisable feel (similar to Intercom/Crisp visitor avatars).
 */
const OS_BRAND: Record<OsKind, { bg: string; fg: string; label: string }> = {
  apple:   { bg: 'bg-gradient-to-br from-zinc-700 to-zinc-900',         fg: 'text-white',  label: 'Apple' },
  windows: { bg: 'bg-gradient-to-br from-sky-500 to-blue-600',          fg: 'text-white',  label: 'Windows' },
  linux:   { bg: 'bg-gradient-to-br from-amber-400 to-orange-500',      fg: 'text-white',  label: 'Linux' },
  android: { bg: 'bg-gradient-to-br from-emerald-400 to-green-600',     fg: 'text-white',  label: 'Android' },
  other:   { bg: 'bg-gradient-to-br from-violet-500 to-fuchsia-600',    fg: 'text-white',  label: 'Device' },
};

function GlyphFor({ kind, className }: { kind: OsKind; className?: string }) {
  switch (kind) {
    case 'apple':   return <Apple className={className} fill="currentColor" />;
    case 'windows': return <WindowsGlyph className={className} />;
    case 'linux':   return <LinuxGlyph className={className} />;
    case 'android': return <Smartphone className={className} />;
    default:        return <MonitorSmartphone className={className} />;
  }
}

export function OsIcon({ os, device, className, ...rest }: Props) {
  const kind = resolveOsKind(os, device);
  // Bare glyph — inherits color from the parent's text color.
  return <GlyphFor kind={kind} className={className} />;
}

/**
 * Filled circular avatar coloured by OS brand. Use this anywhere we used to
 * wrap <OsIcon /> in a `bg-secondary rounded-full` container — replaces both
 * the wrapper and the icon in a single component for a cleaner, branded look.
 */
interface OsAvatarProps {
  os?: string | null;
  device?: string | null;
  /** Tailwind size classes for the circle (e.g. "w-9 h-9"). */
  className?: string;
  /** Tailwind size classes for the inner glyph (e.g. "w-4 h-4"). */
  iconClassName?: string;
  title?: string;
}

export function OsAvatar({ os, device, className, iconClassName, title }: OsAvatarProps) {
  const kind = resolveOsKind(os, device);
  const brand = OS_BRAND[kind];
  return (
    <div
      className={`flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${brand.bg} ${brand.fg} ${className ?? 'w-9 h-9'}`}
      title={title ?? brand.label}
      aria-label={brand.label}
    >
      <GlyphFor kind={kind} className={iconClassName ?? 'w-4 h-4'} />
    </div>
  );
}
