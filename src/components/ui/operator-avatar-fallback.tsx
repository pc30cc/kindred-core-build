import { AvatarFallback } from '@/components/ui/avatar';
import { OperatorSilhouette } from '@/components/ui/avatar-glyphs';
import { cn } from '@/lib/utils';

/**
 * Shown wherever an operator or team member has no photo: the person
 * silhouette (shared/avatarGlyphs.ts) on a violet tile, never their initials
 * (owner, 2026-10-24). Art re-tints it by these classes (components.css).
 * `iconClassName` sizes the glyph: 62% of the avatar, 68% at 20-24px.
 */
export function OperatorAvatarFallback({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  return (
    <AvatarFallback className={cn('bg-brand-violet/15 text-brand-violet ring-1 ring-brand-violet/30', className)}>
      <OperatorSilhouette className={iconClassName} />
    </AvatarFallback>
  );
}
