/**
 * NATIVE NAVIGATION STACK.
 *
 * The difference between "a web app in a shell" and an app is what happens
 * between two screens. iOS pushes a detail screen in from the trailing edge
 * while the parent slides out a third of the way behind a dim, and pops it
 * back with the reverse — and a drag from the leading edge pops it
 * interactively, tracking the finger.
 *
 * Deliberate behaviours, all of them matching UIKit:
 *  • Only a DEPTH change animates. Switching tabs in iOS is instantaneous, so
 *    a same-depth navigation swaps without any transition.
 *  • The outgoing screen stays mounted for the duration of the transition, so
 *    a pop shows the real screen sliding away rather than a blank frame. That
 *    element re-renders under the NEW router context for those 320ms — a
 *    detail screen can therefore find its `:id` param gone — so it is wrapped
 *    in a boundary that degrades to an empty surface instead of taking the
 *    whole app down mid-animation.
 *  • The interactive pop only arms within the leading 28px and only when
 *    there is something to pop; the gesture is abandoned (and the screen
 *    springs back) below half the width, exactly like the system gesture.
 *  • Everything is inert when `enabled` is false, which is how the same
 *    component stays harmless in the web build.
 */
import { Component, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation, useNavigate, useOutlet } from 'react-router-dom';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

const DURATION_MS = 320;
const EDGE_ZONE_PX = 28;

interface Frame {
  key: string;
  element: ReactElement | null;
}

export function NavStack({
  depth,
  enabled,
  rtl,
}: {
  /** 0 for a tab root, 1+ for a screen pushed on top of it. */
  depth: number;
  enabled: boolean;
  rtl: boolean;
}) {
  const outlet = useOutlet();
  const location = useLocation();
  const navigate = useNavigate();

  const current: Frame = { key: location.pathname, element: outlet };
  const previous = useRef<Frame | null>(null);
  const previousDepth = useRef(depth);

  const [transition, setTransition] = useState<'push' | 'pop' | null>(null);
  const [leaving, setLeaving] = useState<Frame | null>(null);
  // 0 → 1 while the finger drags the top screen off; null when not dragging.
  const [drag, setDrag] = useState<number | null>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const wasDeeper = depth < previousDepth.current;
    const isDeeper = depth > previousDepth.current;
    const from = previous.current;
    previous.current = current;
    previousDepth.current = depth;

    if (!enabled || (!wasDeeper && !isDeeper) || !from) return;

    setLeaving(from);
    setTransition(isDeeper ? 'push' : 'pop');
    const timer = window.setTimeout(() => {
      setTransition(null);
      setLeaving(null);
    }, DURATION_MS);
    return () => window.clearTimeout(timer);
    // The frame is derived from the location; re-running on `current` would
    // restart the animation on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, depth, enabled]);

  // ── Interactive pop ───────────────────────────────────────────────────
  const canPop = enabled && depth > 0;
  /** Distance from the leading edge, mirrored for RTL. */
  const edgeDistance = (clientX: number, width: number) =>
    rtl ? width - clientX : clientX;

  const onTouchStart = (event: React.TouchEvent) => {
    if (!canPop || transition) return;
    const touch = event.touches[0];
    const width = event.currentTarget.clientWidth || window.innerWidth;
    if (edgeDistance(touch.clientX, width) > EDGE_ZONE_PX) return;
    dragStart.current = { x: touch.clientX, width };
    setDrag(0);
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const start = dragStart.current;
    if (!start) return;
    const delta = (event.touches[0].clientX - start.x) * (rtl ? -1 : 1);
    setDrag(Math.max(0, Math.min(1, delta / start.width)));
  };

  const onTouchEnd = () => {
    const start = dragStart.current;
    if (!start) return;
    dragStart.current = null;
    const progress = drag ?? 0;
    setDrag(null);
    if (progress > 0.4) {
      haptic('light');
      navigate(-1);
    }
  };

  const dragging = drag !== null;
  const offset = dragging ? `${(drag ?? 0) * 100}%` : undefined;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* The screen being left behind: parked under the top screen during a
          push, sliding back into place during a pop. */}
      {leaving && (
        <div
          key={leaving.key}
          className={cn(
            'absolute inset-0',
            transition === 'push' ? 'nav-leave-push' : 'nav-leave-pop',
          )}
          aria-hidden
        >
          <TransitionBoundary>{leaving.element}</TransitionBoundary>
        </div>
      )}

      <div
        key={current.key}
        className={cn(
          'absolute inset-0 bg-muted/40',
          !dragging && transition === 'push' && 'nav-enter-push',
          !dragging && transition === 'pop' && 'nav-enter-pop',
          dragging && 'shadow-[-8px_0_24px_-6px_rgba(0,0,0,0.25)]',
        )}
        style={
          dragging
            ? {
                transform: `translate3d(${rtl ? '-' : ''}${offset}, 0, 0)`,
                transition: 'none',
              }
            : undefined
        }
      >
        {current.element}
      </div>
    </div>
  );
}

/**
 * Keeps a screen that is on its way out from crashing the app.
 *
 * The outgoing element is re-rendered under the location it is being replaced
 * BY, so a detail screen can briefly see its route param disappear. That is a
 * cosmetic frame in a 320ms animation, never something worth an error screen —
 * so it renders nothing and the transition completes.
 */
class TransitionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <div className="h-full w-full bg-muted/40" />;
    return this.props.children;
  }
}
