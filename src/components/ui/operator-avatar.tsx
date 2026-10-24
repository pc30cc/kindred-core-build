/**
 * An operator's or team member's avatar: their photo, else the person
 * silhouette on the tile (OperatorAvatarFallback), never their initials
 * (owner, 2026-10-24). The silhouette also stands in while the photo loads
 * and when it fails. Decoration only: the name stays in the row's text.
 *
 * `tone`: `operator` is the panel's operator tile (violet; Art's clay tint),
 * `tint` the primary tint the settings and Super Admin lists use.
 * Visitors and contacts keep ContactAvatar.
 */
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { OperatorAvatarFallback } from '@/components/ui/operator-avatar-fallback';
import { cn } from '@/lib/utils';

export interface OperatorAvatarProps {
  src?: string | null;
  alt?: string;
  /** The tile's size (default 36px) and anything else on the avatar. */
  className?: string;
  tone?: 'operator' | 'tint';
  /** More classes for the tile without a photo (its background, the glyph's colour). */
  fallbackClassName?: string;
  /** The glyph's box: 62% of the tile by default, 68% at 20-24px. */
  glyphClassName?: string;
}

const TONE: Record<NonNullable<OperatorAvatarProps['tone']>, string> = {
  operator: '',
  tint: 'bg-primary/10 text-primary ring-0',
};

export function OperatorAvatar({ src, alt = '', className, tone = 'operator', fallbackClassName, glyphClassName }: OperatorAvatarProps) {
  const url = typeof src === 'string' ? src.trim() : '';
  return (
    <Avatar data-avatar="operator" className={cn('h-9 w-9', className)}>
      {url ? <AvatarImage src={url} alt={alt} /> : null}
      <OperatorAvatarFallback className={cn(TONE[tone], fallbackClassName)} iconClassName={glyphClassName} />
    </Avatar>
  );
}
