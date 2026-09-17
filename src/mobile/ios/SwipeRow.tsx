/**
 * SWIPE ACTIONS on a list row.
 *
 * The iOS gesture: drag the row toward the leading edge to reveal trailing
 * actions, release past a third of their width to keep them open, tap outside
 * (or act) to close. Direction is mirrored under RTL so the actions always
 * come from the same visual side as the system does.
 *
 * Only horizontal drags are captured: a mostly-vertical movement is left to
 * the scroll container, which is what keeps the list scrollable through the
 * rows rather than fighting them.
 */
import { useRef, useState, type ReactNode } from 'react';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

export interface SwipeAction {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Uses the destructive palette and a heavier haptic. */
  destructive?: boolean;
  onAction: () => void;
}

const ACTION_WIDTH = 78;

export function SwipeRow({
  actions,
  rtl,
  children,
}: {
  actions: SwipeAction[];
  rtl: boolean;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; offset: number } | null>(null);
  const axis = useRef<'undecided' | 'horizontal' | 'vertical'>('undecided');

  const maxOffset = actions.length * ACTION_WIDTH;
  if (!actions.length) return <>{children}</>;

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    start.current = { x: touch.clientX, y: touch.clientY, offset };
    axis.current = 'undecided';
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const origin = start.current;
    if (!origin) return;
    const touch = event.touches[0];
    const dx = (touch.clientX - origin.x) * (rtl ? -1 : 1);
    const dy = touch.clientY - origin.y;

    if (axis.current === 'undecided') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      if (axis.current === 'horizontal') setDragging(true);
    }
    if (axis.current !== 'horizontal') return;

    // Past the full action width the row rubber-bands instead of running away.
    const raw = origin.offset - dx;
    const next = raw > maxOffset ? maxOffset + (raw - maxOffset) * 0.25 : Math.max(0, raw);
    setOffset(next);
  };

  const onTouchEnd = () => {
    if (!start.current) return;
    start.current = null;
    if (axis.current !== 'horizontal') return;
    setDragging(false);
    const open = offset > maxOffset / 3;
    if (open && offset < maxOffset) haptic('light');
    setOffset(open ? maxOffset : 0);
  };

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-y-0 end-0 flex" aria-hidden={offset === 0}>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            tabIndex={offset === 0 ? -1 : 0}
            style={{ width: ACTION_WIDTH }}
            onClick={() => {
              haptic(action.destructive ? 'warning' : 'light');
              setOffset(0);
              action.onAction();
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-1 text-[11px] font-semibold text-white',
              action.destructive ? 'bg-destructive' : 'bg-primary',
            )}
          >
            <action.icon className="h-5 w-5" />
            {action.label}
          </button>
        ))}
      </div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          transform: `translate3d(${rtl ? '' : '-'}${offset}px, 0, 0)`,
          transition: dragging ? 'none' : 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        className="relative bg-card"
      >
        {children}
      </div>
    </div>
  );
}
