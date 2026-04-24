/**
 * Phase — Inbox Call Hardening · Pass 4
 *
 * Tiny timer that ticks every second from a fixed start. Used by both
 * AudioCallSurface and VideoCallSurface so the formatting stays identical.
 * Renders nothing until startedAt is non-null — keeps the connecting/
 * ringing UI free of "0:00" placeholders.
 */
import { useEffect, useState } from 'react';

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = (m % 60).toString().padStart(2, '0');
    return h + ':' + mm + ':' + r.toString().padStart(2, '0');
  }
  return m + ':' + r.toString().padStart(2, '0');
}

export function CallTimer({ startedAt, className }: { startedAt: number | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  return <span className={className}>{fmt((now - startedAt) / 1000)}</span>;
}