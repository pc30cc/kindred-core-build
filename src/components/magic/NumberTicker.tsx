import { useEffect, useRef, useState } from 'react';

/** Magic UI–style number ticker: eases from 0 to `value` when it scrolls into view. */
export function NumberTicker({
  value,
  format = (n) => n.toLocaleString(),
  duration = 1200,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || !Number.isFinite(value)) { setShown(value || 0); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    let raf = 0;
    const run = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 4);
        setShown(Math.round(value * eased));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { run(); io.disconnect(); } });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, duration]);

  return <span ref={ref} className={className}>{format(shown)}</span>;
}
