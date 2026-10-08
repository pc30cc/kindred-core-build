import { useSyncExternalStore } from 'react';

/** The mock page's backdrop and its placeholder bars, blocks and cards. */
export interface PreviewStage {
  background: string;
  bar: string;
}

/**
 * The mock web page a widget preview sits on, in the Art panel's colours:
 * warm stone on the ivory paper, deep ink in dark mode (a bright slate block
 * was the loudest thing beside a dark editor).
 */
const ART_STAGE: Record<'light' | 'dark', PreviewStage> = {
  light: { background: '#EFEBE4', bar: '#E3DDD3' },
  dark: { background: '#171A21', bar: '#252932' },
};

// Read from <html> (AppLayout sets `data-panel-theme`, the colour mode sets
// `.dark`), so the preview follows a switch of either without any provider.
function snapshot(): 'none' | 'light' | 'dark' {
  if (typeof document === 'undefined') return 'none';
  const root = document.documentElement;
  if (root.getAttribute('data-panel-theme') !== 'art') return 'none';
  return root.classList.contains('dark') ? 'dark' : 'light';
}

function subscribe(onChange: () => void) {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-panel-theme'] });
  return () => observer.disconnect();
}

/** The Art stage while the panel wears Art; `undefined` elsewhere (the preview keeps its own). */
export function useArtPreviewStage(): PreviewStage | undefined {
  const mode = useSyncExternalStore(subscribe, snapshot, () => 'none' as const);
  return mode === 'none' ? undefined : ART_STAGE[mode];
}
