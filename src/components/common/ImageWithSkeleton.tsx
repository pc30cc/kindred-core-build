/**
 * Image that paints a skeleton until the bitmap has actually decoded.
 *
 * Project rule: no image slot ever renders empty — avatars, workspace logos
 * and icon tiles show a pulsing placeholder while the network fetch is in
 * flight, then cross-fade to the real image. On error the skeleton is dropped
 * so the caller's own fallback (initials, icon) shows through.
 */
import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface ImageWithSkeletonProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'onLoad' | 'onError'> {
  /** Extra classes for the pulsing placeholder layer. */
  skeletonClassName?: string;
}

export function ImageWithSkeleton({
  className,
  skeletonClassName,
  src,
  alt = '',
  ...rest
}: ImageWithSkeletonProps) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');

  if (state === 'error' || !src) return null;

  return (
    <>
      {state === 'loading' && (
        <Skeleton className={cn('absolute inset-0 h-full w-full rounded-[inherit]', skeletonClassName)} />
      )}
      <img
        {...rest}
        src={src}
        alt={alt}
        className={cn(className, 'transition-opacity duration-200', state === 'loaded' ? 'opacity-100' : 'opacity-0')}
        onLoad={() => setState('loaded')}
        onError={() => setState('error')}
      />
    </>
  );
}
