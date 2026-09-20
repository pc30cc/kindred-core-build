/**
 * NATIVE APPEARANCE (status bar + splash screen).
 *
 * Two small pieces of polish that a web page cannot do for itself:
 *
 *  • The status bar has to be told which text colour to use. Getting it wrong
 *    means white glyphs on a white nav bar — the single most obvious "this is
 *    a website in a shell" tell. It is re-applied whenever the theme changes,
 *    not just at launch.
 *
 *  • The splash screen is hidden only once React has painted. Letting
 *    Capacitor auto-hide it produces a white flash between the launch image
 *    and the first frame.
 *
 * Both are no-ops on the web and when the plugin is absent.
 */
import { isNativePlatform } from './native';

/** The slices of @capacitor/status-bar and @capacitor/splash-screen used here. */
interface StatusBarPlugin {
  setStyle?: (options: { style: string }) => Promise<void>;
  setOverlaysWebView?: (options: { overlay: boolean }) => Promise<void>;
}

interface SplashScreenPlugin {
  hide?: (options?: { fadeOutDuration?: number }) => Promise<void>;
}

interface CapacitorWindow {
  Capacitor?: { Plugins?: Record<string, unknown> };
}

function pluginNamed<T>(name: string): T | null {
  try {
    if (!isNativePlatform()) return null;
    const plugins = (window as unknown as CapacitorWindow).Capacitor?.Plugins;
    return (plugins?.[name] as T) ?? null;
  } catch {
    return null;
  }
}

/** True when the document is currently rendering the dark palette. */
function isDark(): boolean {
  try {
    return document.documentElement.classList.contains('dark');
  } catch {
    return false;
  }
}

function applyStatusBarStyle(): void {
  const bar = pluginNamed<StatusBarPlugin>('StatusBar');
  if (!bar) return;
  try {
    // `Dark` means dark CONTENT (dark glyphs) — it is named for the text, not
    // the background, which is the opposite of what the name suggests.
    void bar.setStyle?.({ style: isDark() ? 'DARK' : 'LIGHT' });
    // The web view already paints under the status bar via the safe-area
    // insets, so the bar must not reserve its own space on top of that.
    void bar.setOverlaysWebView?.({ overlay: true });
  } catch {
    /* older plugin: leave the system default */
  }
}

let observer: MutationObserver | null = null;

/**
 * Applies the status bar style now and keeps it in step with the theme.
 * Safe to call more than once; the observer is installed only on the first.
 */
export function installNativeAppearance(): void {
  if (!isNativePlatform()) return;
  applyStatusBarStyle();
  if (observer) return;
  try {
    observer = new MutationObserver(applyStatusBarStyle);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  } catch {
    observer = null;
  }
}

/** Hides the launch image once the first real frame is on screen. */
export function hideSplashWhenReady(): void {
  const splash = pluginNamed<SplashScreenPlugin>('SplashScreen');
  if (!splash) return;
  // Two frames: the first schedules the paint, the second runs after it.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        void splash.hide?.({ fadeOutDuration: 200 });
      } catch {
        /* the plugin's own auto-hide still applies */
      }
    });
  });
}
