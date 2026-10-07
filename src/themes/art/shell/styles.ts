/**
 * Class strings the Art shell's pieces share, so the header, its menus and
 * the phone drawer read as one family.
 */

/** A round 40px icon button in the header. */
export const artIconButton =
  'relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors ' +
  'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ' +
  'data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:h-5 [&_svg]:w-5';

/** A menu's panel: 1rem corners, 6px inset, a hairline and a soft warm shadow. */
export const artMenuContent =
  'rounded-2xl border-0 p-1.5 ring-1 ring-foreground/[0.07] ' +
  'shadow-[0_18px_40px_-16px_hsl(var(--art-shadow)/0.28),0_2px_6px_-2px_hsl(var(--art-shadow)/0.08)]';

/** A menu row: 40px tall, an icon before the label. */
export const artMenuItem =
  'min-h-10 cursor-pointer gap-2.5 rounded-[0.625rem] px-3 py-2 text-sm focus:bg-muted focus:text-foreground ' +
  '[&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground';

/** The small heading above a group of menu rows. */
export const artMenuLabel = 'px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground';

/** A count on a pill: an 18px circle; the caller gives its colours. */
export const artCount =
  'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums leading-none';
