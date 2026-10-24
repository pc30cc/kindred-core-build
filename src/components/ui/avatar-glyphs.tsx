/**
 * The platform's avatar glyphs in the panel (shared/avatarGlyphs.ts): the
 * person silhouette for an operator or team member without a photo, the
 * workspace icon for a workspace without a logo. Never a letter in their
 * place (owner, 2026-10-24).
 *
 * Each fills with `currentColor`, so it takes the colour the initial's text
 * had; the default box is the glyph's share of its tile (62% / 58%). It is
 * decoration: aria-hidden, the name stays in the text beside it.
 */
import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { PERSON_SILHOUETTE, WORKSPACE_MARK } from '../../../shared/avatarGlyphs';

export type AvatarGlyphProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'fill'>;

/** An operator or team member without a photo. */
export function OperatorSilhouette({ className, ...rest }: AvatarGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-glyph="person"
      className={cn('h-[62%] w-[62%] shrink-0', className)}
      {...rest}
    >
      <path d={PERSON_SILHOUETTE} />
    </svg>
  );
}

/** A workspace without a logo. */
export function WorkspaceGlyph({ className, ...rest }: AvatarGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-glyph="workspace"
      className={cn('h-[58%] w-[58%] shrink-0', className)}
      {...rest}
    >
      <path d={WORKSPACE_MARK} />
    </svg>
  );
}
