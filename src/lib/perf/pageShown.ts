/**
 * Whether any code-split page has been on screen in this document yet
 * (src/lib/perf/lazyPage.tsx). Until then the app is still starting, and a
 * frameless page that is still loading keeps the launch loader up instead
 * of an empty screen (BlankPageFallback in PageLoadStates.tsx).
 */
let shown = false;

export function hasShownPage(): boolean {
  return shown;
}

export function markPageShown(): void {
  shown = true;
}

/** For tests: back to "the app is starting". */
export function resetPageShown(): void {
  shown = false;
}
