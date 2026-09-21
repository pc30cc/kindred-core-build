/**
 * The WEBYAR app mark.
 *
 * One place owns the logo bitmap, so every surface that shows "the app icon"
 * (auth screens, sidebar fallback, loading screen) stays in sync. Operator
 * branding still wins where it exists — pass `src` to override.
 */
import { cn } from '@/lib/utils';
import webyarLogo from '@/assets/webyar-logo.png';

export function BrandLogo({
  src,
  alt = 'WEBYAR',
  className,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
}) {
  return (
    <img
      src={src || webyarLogo}
      alt={alt}
      className={cn('rounded-xl object-cover', className)}
      draggable={false}
    />
  );
}

export { webyarLogo };
