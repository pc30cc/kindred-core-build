import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, X, type LucideIcon } from 'lucide-react'
import { cx } from '@/lib/cx'


type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover shadow-card',
  secondary: 'bg-surface text-fg border border-line hover:bg-hover shadow-card',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90 shadow-card',
  soft: 'bg-brand-soft text-brand hover:brightness-95',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: LucideIcon; loading?: boolean }
>(function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, ...rest }, ref) {
  const sizes = { sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md', md: 'h-9 px-3.5 text-[13.5px] gap-2 rounded-lg', lg: 'h-11 px-5 text-[14.5px] gap-2 rounded-xl' }
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'no-drag inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors select-none',
        'disabled:opacity-50 disabled:pointer-events-none',
        sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} /> : null}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean; size?: 'sm' | 'md'; tone?: 'default' | 'danger' | 'brand' }
>(function IconButton({ icon: Icon, label, active, size = 'md', tone = 'default', className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      title={label}
      aria-label={label}
      className={cx(
        'no-drag inline-flex items-center justify-center rounded-lg transition-colors shrink-0',
        'disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'size-7' : 'size-9',
        active ? 'bg-brand-soft text-brand' : tone === 'danger' ? 'text-danger hover:bg-danger-soft' : tone === 'brand' ? 'text-brand hover:bg-brand-soft' : 'text-fg-2 hover:bg-hover hover:text-fg',
        className,
      )}
      {...rest}
    >
      <Icon className={size === 'sm' ? 'size-4' : 'size-[18px]'} strokeWidth={1.9} />
    </button>
  )
})

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon; trailing?: ReactNode }>(
  function TextField({ icon: Icon, trailing, className, dir, ...rest }, ref) {
    // The icon sits on the side the text starts from, so an LTR field keeps it on the left in Persian too.
    return (
      <div dir={dir === 'ltr' || dir === 'rtl' ? dir : undefined} className={cx('no-drag relative flex items-center', className)}>
        {Icon && <Icon className="pointer-events-none absolute start-3 size-4 text-fg-3" />}
        <input
          ref={ref}
          dir={dir}
          className={cx(
            'h-9 w-full rounded-lg border border-line bg-surface text-[13.5px] text-fg placeholder:text-fg-3',
            'outline-none transition-shadow focus:border-brand focus:ring-3 focus:ring-brand-soft',
            Icon ? 'ps-9' : 'ps-3',
            trailing ? 'pe-10' : 'pe-3',
          )}
          {...rest}
        />
        {trailing && <div className="absolute end-1.5 flex items-center">{trailing}</div>}
      </div>
    )
  },
)

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        'no-drag w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-fg placeholder:text-fg-3 resize-none',
        'outline-none transition-shadow focus:border-brand focus:ring-3 focus:ring-brand-soft',
        className,
      )}
      {...rest}
    />
  )
})

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] size-4 rounded-full bg-white shadow transition-all',
          checked ? 'start-[19px]' : 'start-[3px]',
        )}
      />
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-fg-3', className)} />
}

export function Pill({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger'; className?: string }) {
  const tones = {
    neutral: 'bg-elevated text-fg-2',
    brand: 'bg-brand-soft text-brand',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  }
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-semibold whitespace-nowrap', tones[tone], className)}>{children}</span>
}

export function CountBadge({ count, language, muted }: { count: number; language: string; muted?: boolean }) {
  if (count <= 0) return null
  const text = new Intl.NumberFormat(language === 'fa' ? 'fa-IR' : 'en-US').format(Math.min(count, 99)) + (count > 99 ? '+' : '')
  return (
    <span className={cx('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold', muted ? 'bg-elevated text-fg-2' : 'bg-brand text-on-brand')}>
      {text}
    </span>
  )
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="fade-in flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-elevated text-fg-3">
        <Icon className="size-7" strokeWidth={1.6} />
      </div>
      <div className="max-w-[280px]">
        <div className="text-[15px] font-semibold text-fg">{title}</div>
        {body && <div className="mt-1 text-[13px] text-fg-2">{body}</div>}
      </div>
      {action}
    </div>
  )
}

export function ErrorState({ title, body, retryLabel, onRetry, icon }: { title: string; body: string; retryLabel: string; onRetry: () => void; icon: LucideIcon }) {
  return <EmptyState icon={icon} title={title} body={body} action={<Button size="sm" onClick={onRetry}>{retryLabel}</Button>} />
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-md', className)} />
}

/** A card of settings rows, the desktop version of an inset grouped list. */
export function Card({ title, footer, children, className }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mb-6', className)}>
      {title && <h3 className="mb-2 px-1 text-[12px] font-semibold tracking-wide text-fg-2 uppercase">{title}</h3>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card">{children}</div>
      {footer && <p className="mt-2 px-1 text-[12px] leading-relaxed text-fg-3">{footer}</p>}
    </section>
  )
}

export function Row({ label, hint, children, onClick, icon: Icon, danger }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; onClick?: () => void; icon?: LucideIcon; danger?: boolean }) {
  const content = (
    <>
      {Icon && <Icon className={cx('size-[18px] shrink-0', danger ? 'text-danger' : 'text-fg-2')} strokeWidth={1.8} />}
      <div className="min-w-0 flex-1">
        <div className={cx('text-[13.5px]', danger ? 'text-danger font-medium' : 'text-fg')}>{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-fg-3">{hint}</div>}
      </div>
      {children}
    </>
  )
  return onClick ? (
    <button onClick={onClick} className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-hover">
      {content}
    </button>
  ) : (
    <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">{content}</div>
  )
}

// ---------------------------------------------------------------------------
// Popovers and menus

function usePosition(anchor: HTMLElement | null, open: boolean, align: 'start' | 'end', side: 'bottom' | 'top') {
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const rtl = document.documentElement.dir === 'rtl'
      const alignLeft = (align === 'start') !== rtl
      setPos({ top: side === 'bottom' ? r.bottom + 6 : r.top - 6, left: alignLeft ? r.left : r.right, minWidth: r.width })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, open, align, side])
  return pos
}

export function Popover({
  anchor,
  open,
  onClose,
  align = 'start',
  side = 'bottom',
  children,
  className,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  children: ReactNode
  className?: string
}) {
  const pos = usePosition(anchor, open, align, side)
  const ref = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchor])

  // Keep the whole popover on screen.
  useLayoutEffect(() => {
    if (!open || !ref.current || !pos) return
    // Measure where the popover would sit without the current shift, so the
    // correction converges instead of flipping between two positions.
    const m = ref.current.getBoundingClientRect()
    const left = m.left - shift.x
    const right = m.right - shift.x
    const top = m.top - shift.y
    const bottom = m.bottom - shift.y
    let x = 0
    let y = 0
    if (right > window.innerWidth - 8) x = window.innerWidth - 8 - right
    if (left + x < 8) x = 8 - left
    if (bottom > window.innerHeight - 8) y = window.innerHeight - 8 - bottom
    if (top + y < 8) y = 8 - top
    x = Math.round(x)
    y = Math.round(y)
    if (x !== shift.x || y !== shift.y) setShift({ x, y })
  }, [open, pos, shift.x, shift.y])

  if (!open || !pos) return null
  const rtl = document.documentElement.dir === 'rtl'
  const alignLeft = (align === 'start') !== rtl
  return createPortal(
    <div
      ref={ref}
      // Anchored with top/bottom and left/right rather than a translate: the
      // pop-in animation owns `transform`, and would move the popover while
      // it is being measured.
      style={{
        position: 'fixed',
        ...(side === 'top' ? { bottom: window.innerHeight - pos.top - shift.y } : { top: pos.top + shift.y }),
        ...(alignLeft ? { left: pos.left + shift.x } : { right: window.innerWidth - pos.left - shift.x }),
        zIndex: 60,
      }}
      className={cx('pop-in no-drag rounded-xl border border-line bg-surface p-1 shadow-pop', className)}
    >
      {children}
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  icon?: LucideIcon
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  hint?: string
  onSelect?: () => void
  /** A heading row, or a line between groups. */
  kind?: 'item' | 'header' | 'separator'
  trailing?: ReactNode
}

export function MenuList({ items, onClose, className }: { items: MenuItem[]; onClose: () => void; className?: string }) {
  return (
    <div className={cx('min-w-[200px] max-h-[70vh] overflow-y-auto', className)} role="menu">
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="my-1 h-px bg-line" />
        if (item.kind === 'header') return <div key={i} className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{item.label}</div>
        const Icon = item.icon
        return (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect?.()
              onClose()
            }}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-start text-[13.5px] transition-colors disabled:opacity-40',
              item.danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-hover',
            )}
          >
            {Icon ? <Icon className={cx('size-4 shrink-0', item.danger ? '' : 'text-fg-2')} strokeWidth={1.8} /> : item.checked !== undefined ? <span className="size-4 shrink-0" /> : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="text-[12px] text-fg-3">{item.hint}</span>}
            {item.trailing}
            {item.checked && <Check className="size-4 shrink-0 text-brand" />}
          </button>
        )
      })}
    </div>
  )
}

/** A trigger and its menu, the common case. */
export function Menu({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
}: {
  trigger: (props: { ref: (el: HTMLElement | null) => void; onClick: () => void; open: boolean }) => ReactNode
  items: MenuItem[]
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      {trigger({ ref: setAnchor, onClick: () => setOpen((o) => !o), open })}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align={align} side={side}>
        <MenuList items={items} onClose={() => setOpen(false)} />
      </Popover>
    </>
  )
}

/** A select that looks like the rest of the app instead of a Windows 95 drop-down. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  className,
  disabled,
}: {
  value: T
  options: { value: T; label: string; icon?: LucideIcon }[]
  onChange: (v: T) => void
  className?: string
  disabled?: boolean
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Menu
      align="end"
      items={options.map((o) => ({ label: o.label, icon: o.icon, checked: o.value === value, onSelect: () => onChange(o.value) }))}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          disabled={disabled}
          onClick={onClick}
          className={cx(
            'no-drag inline-flex h-8 min-w-[120px] items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg hover:bg-hover disabled:opacity-50',
            className,
          )}
        >
          <span className="truncate">{current?.label ?? '—'}</span>
          <ChevronDown className="size-3.5 text-fg-3" />
        </button>
      )}
    />
  )
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 440,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fade-in no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className="pop-in flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <div className="text-[15px] font-semibold">{title}</div>
            <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** A yes/no question with a destructive or ordinary confirm. */
export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body?: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button onClick={onClose}>{cancelLabel}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="px-5 pt-5 pb-4">
        <div className="text-[15px] font-semibold">{title}</div>
        {body && <p className="mt-1.5 text-[13.5px] text-fg-2">{body}</p>}
      </div>
    </Dialog>
  )
}
