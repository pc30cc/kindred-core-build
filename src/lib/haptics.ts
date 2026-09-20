/**
 * HAPTIC FEEDBACK (native shell only).
 *
 * A thin wrapper over @capacitor/haptics that is inert everywhere else: on the
 * web, in tests, and inside a native build where the plugin was not synced,
 * every call returns immediately instead of throwing.
 *
 * Haptics are what separate a real app from a web page rendered in a shell —
 * but only when they are rare. They belong on a state change the user caused
 * and would otherwise have to verify by looking: a tab switch, a sent message,
 * a completed pull-to-refresh, a destructive confirm. Never on scroll, never
 * on a render, never on something the system did on its own.
 */
import { isNativePlatform } from './native';

export type HapticStyle =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'selection'
  | 'success'
  | 'warning'
  | 'error';

/** The slice of @capacitor/haptics this module uses. */
interface HapticsPlugin {
  impact?: (options: { style: string }) => Promise<void>;
  notification?: (options: { type: string }) => Promise<void>;
  selectionChanged?: () => Promise<void>;
}

interface CapacitorWindow {
  Capacitor?: { Plugins?: Record<string, unknown> };
}

/** Resolved once; the plugin object is stable for the life of the process. */
let plugin: HapticsPlugin | null | undefined;

function haptics(): HapticsPlugin | null {
  if (plugin !== undefined) return plugin;
  try {
    const plugins = (window as unknown as CapacitorWindow).Capacitor?.Plugins;
    plugin = isNativePlatform() ? ((plugins?.Haptics as HapticsPlugin) ?? null) : null;
  } catch {
    plugin = null;
  }
  return plugin;
}

export function haptic(style: HapticStyle = 'light'): void {
  const api = haptics();
  if (!api) return;
  try {
    if (style === 'selection') {
      // `selectionChanged` alone is the correct one-shot: start/end bracket a
      // continuous gesture such as a picker drag, which we do not have.
      void api.selectionChanged?.();
      return;
    }
    if (style === 'success' || style === 'warning' || style === 'error') {
      void api.notification?.({ type: style.toUpperCase() });
      return;
    }
    void api.impact?.({ style: style.toUpperCase() });
  } catch {
    // A missing or older plugin must never break the interaction it decorates.
  }
}
