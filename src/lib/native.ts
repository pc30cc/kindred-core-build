/**
 * Native (Capacitor/iOS) shell helpers.
 *
 * The SAME bundle runs on the web and inside the iOS shell. Nothing here
 * changes behaviour on the web: when Capacitor is absent, `isNativePlatform()`
 * is false and no class is added.
 */
export function isNativePlatform(): boolean {
  try {
    const cap = (window as any).Capacitor;
    return Boolean(cap?.isNativePlatform?.() ?? cap?.isNative);
  } catch {
    return false;
  }
}

export function getNativePlatform(): 'ios' | 'android' | 'web' {
  try {
    const p = (window as any).Capacitor?.getPlatform?.();
    return p === 'ios' || p === 'android' ? p : 'web';
  } catch {
    return 'web';
  }
}

/**
 * Marks <html> so the safe-area CSS (notch / Dynamic Island / home indicator)
 * only applies inside the native shell.
 */
export function applyNativeShellClasses(): void {
  if (!isNativePlatform()) return;
  const el = document.documentElement;
  el.classList.add('native-app');
  el.classList.add(`native-${getNativePlatform()}`);
}
