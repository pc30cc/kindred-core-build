/**
 * The launch loader's two arcs, small: the brand-blue comet running into
 * cyan with a bead at its head, and a fainter cyan arc turning the other way
 * inside it. No wordmark — this stands in buttons, rows and panels.
 *
 * Drop-in for lucide's `Loader2`: same props, sized by `className`
 * (`h-4 w-4`) or `size`. `animate-spin` from the caller is dropped because
 * the arcs carry their own opposite rotations.
 */
import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

const DEEP = '#0c50e9';
const CYAN = '#2ed6ff';

export const BrandSpinner = forwardRef<SVGSVGElement, LucideProps>(function BrandSpinner(
  // Lucide-only props are accepted and ignored: the arcs keep their own colours.
  { className, size = 24, color, strokeWidth, absoluteStrokeWidth, ...rest },
  ref,
) {
  const cls = cn('wy-spinner shrink-0', className?.replace(/\banimate-spin\b/g, ''));
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cls}
      aria-hidden
      {...rest}
    >
      <defs>
        <linearGradient id="wy-spinner-comet" gradientUnits="userSpaceOnUse" x1="12" y1="2" x2="21.06" y2="16.23">
          <stop offset="0" stopColor={DEEP} stopOpacity="0" />
          <stop offset="0.55" stopColor={DEEP} />
          <stop offset="1" stopColor={CYAN} />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" stroke="rgb(59 122 242 / 0.12)" strokeWidth="2.5" />
      <g className="wy-spinner-cw">
        <path d="M12 2 A10 10 0 0 1 21.06 16.23" stroke="url(#wy-spinner-comet)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="21.06" cy="16.23" r="1.5" fill={CYAN} />
      </g>
      <g className="wy-spinner-ccw">
        <path d="M12 18 A6 6 0 0 1 6.11 13.14" stroke={CYAN} strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
});
