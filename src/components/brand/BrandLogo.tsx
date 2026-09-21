/**
 * The WEBYAR app mark.
 *
 * One place owns the logo bitmap, so every surface that shows "the app icon"
 * (auth screens, sidebar fallback, loading screen) stays in sync. Operator
 * branding still wins where it exists — pass `src` to override.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import webyarLogo from '@/assets/webyar-logo.png';

export function BrandLogo({
  src,
  alt = 'WEBYAR',
  className,
  style,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      src={src || webyarLogo}
      alt={alt}
      className={cn('rounded-xl object-cover', className)}
      style={style}
      draggable={false}
    />
  );
}

export { webyarLogo };
