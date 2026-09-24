import { cn } from '@/lib/utils';
import webyarW from '@/assets/webyar-w.png';

/** The bare W mark, painted via CSS mask so it takes `currentColor` (or any bg-* class passed). */
export function WebyarMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block bg-current', className)}
      style={{
        WebkitMaskImage: `url(${webyarW})`,
        maskImage: `url(${webyarW})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        ...style,
      }}
    />
  );
}
