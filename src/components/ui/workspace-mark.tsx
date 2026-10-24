/**
 * A workspace's mark: the logo its owner set, else the workspace icon
 * (shared/avatarGlyphs.ts) on the tile, never the workspace's first letter
 * (owner, 2026-10-24). The icon also stands in when the logo fails to load.
 *
 * The caller's classes are the tile (its size, corners, background and the
 * glyph's colour: `text-*`); `glyphClassName` sizes the glyph (58% of the
 * tile, 62% at 20-24px). Any other attribute (a theme's `data-*` hook) goes
 * on the tile.
 */
import { useState, type HTMLAttributes } from 'react';
import { ImageWithSkeleton } from '@/components/common/ImageWithSkeleton';
import { WorkspaceGlyph } from '@/components/ui/avatar-glyphs';
import { cn } from '@/lib/utils';

export interface WorkspaceMarkProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  logoUrl?: string | null;
  glyphClassName?: string;
  /** Classes for the logo image (default: cover the tile). */
  imageClassName?: string;
}

export function WorkspaceMark({ logoUrl, className, glyphClassName, imageClassName, ...rest }: WorkspaceMarkProps) {
  const url = typeof logoUrl === 'string' ? logoUrl.trim() : '';
  const [failed, setFailed] = useState<string | null>(null);
  const showLogo = !!url && failed !== url;
  return (
    <span
      data-workspace-mark={showLogo ? 'logo' : 'glyph'}
      {...rest}
      className={cn('relative flex shrink-0 items-center justify-center overflow-hidden', className)}
    >
      {showLogo ? (
        <ImageWithSkeleton
          key={url}
          src={url}
          className={cn('h-full w-full object-cover', imageClassName)}
          onFail={() => setFailed(url)}
        />
      ) : (
        <WorkspaceGlyph className={glyphClassName} />
      )}
    </span>
  );
}
