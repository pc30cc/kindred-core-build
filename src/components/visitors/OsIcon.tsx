/**
 * OS-aware avatar icon for visitors.
 *
 * Picks a brand-appropriate Lucide glyph based on the OS string captured
 * by the widget loader (`detectOS()`):
 *   - macOS / iOS  → Apple
 *   - Windows      → Windows-monogram (custom inline SVG, since Lucide
 *                    doesn't ship a Windows-brand icon)
 *   - Linux        → Penguin-style glyph (custom inline SVG)
 *   - Android      → Smartphone (Android uses phone form-factor today)
 *   - Other        → MonitorSmartphone (generic desktop+phone)
 *
 * Mobile UAs override OS-only choice with phone glyphs, so a "Mobile"
 * device + "iOS" still maps to the Apple glyph (recognisable iPhone vibe).
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

export function OsIcon({ os, device, className, ...rest }: Props) {
  const o = (os || '').toLowerCase();
  const d = (device || '').toLowerCase();
  const isMobile = d === 'mobile' || /android|ios|iphone|ipad/.test(o);

  if (o.includes('mac') || o === 'macos' || o === 'ios') {
    return <Apple className={className} {...rest} />;
  }
  if (o.includes('win')) {
    return <WindowsGlyph className={className} />;
  }
  if (o.includes('linux')) {
    return <LinuxGlyph className={className} />;
  }
  if (o.includes('android')) {
    return <Smartphone className={className} {...rest} />;
  }
  if (isMobile) return <Smartphone className={className} {...rest} />;
  return <MonitorSmartphone className={className} {...rest} />;
}
