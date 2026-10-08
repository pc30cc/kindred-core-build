/**
 * The Art chart kit for the chart that calls it — or `null` when the panel
 * does not wear Art. Classic charts therefore cannot reach the kit: a page
 * draws its Art chart only where it has one (`if (art) ...`), and its Classic
 * chart stays exactly as it was.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { usePanelTheme } from '@/themes/usePanelTheme';
import { createArtChartKit, type ArtChartKit } from './kit';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
}

/** Follows the reader's "reduce motion" setting. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION);
    const update = () => setReduced(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

export function useArtCharts(): ArtChartKit | null {
  const { theme } = usePanelTheme();
  const { locale, dir } = useTranslation();
  const uid = useId();
  const reduced = useReducedMotion();
  const isArt = theme === 'art';
  return useMemo(
    () => (isArt ? createArtChartKit({ locale, dir, uid, animate: !reduced }) : null),
    [isArt, locale, dir, uid, reduced],
  );
}
