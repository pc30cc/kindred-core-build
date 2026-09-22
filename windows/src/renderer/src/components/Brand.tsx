import icon from '@/assets/icon.png'
import { cx } from '@/lib/cx'

/**
 * The wordmark, which is the same in every language: it is the mark on the
 * product, not a word in a sentence. Doubles as the loading indicator.
 */
export function Wordmark({ size = 20, loading, className }: { size?: number; loading?: boolean; className?: string }) {
  return (
    <span
      dir="ltr"
      className={cx('font-extrabold select-none', loading ? 'wordmark-loading' : 'text-brand', className)}
      style={{ fontSize: size, letterSpacing: size * 0.18, fontFamily: "'Inter Variable', sans-serif" }}
    >
      WEBYAR
    </span>
  )
}

export function BrandMark({ size = 28 }: { size?: number }) {
  return <img src={icon} alt="" width={size} height={size} draggable={false} className="shrink-0 shadow-card" style={{ borderRadius: size * 0.24 }} />
}
