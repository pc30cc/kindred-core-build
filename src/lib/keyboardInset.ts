/**
 * KEYBOARD HANDLING for the native shell.
 *
 * The web view is configured with `KeyboardResize.None` (see
 * capacitor.config.ts), so the OS keyboard NEVER resizes or scrolls the web
 * view — the app chrome (nav bar, tab bar) stays exactly where it is, like a
 * real native app. Instead we publish the keyboard height as the CSS variable
 * `--kb-inset`, and only the surfaces that must move (the chat composer)
 * consume it.
 *
 * Inert on the web: without the Capacitor Keyboard plugin the variable stays
 * at `0px` and every layout renders exactly as before.
 */
import { isNativePlatform } from './native';

let installed = false;

function setInset(px: number): void {
  document.documentElement.style.setProperty('--kb-inset', `${Math.max(0, Math.round(px))}px`);
}

export async function installKeyboardInset(): Promise<void> {
  setInset(0);
  if (!isNativePlatform() || installed) return;
  installed = true;
  try {
    const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
    await Keyboard.setResizeMode({ mode: KeyboardResize.None }).catch(() => {});
    await Keyboard.setScroll({ isDisabled: true }).catch(() => {});
    // `willShow` starts the lift in sync with the system animation; `didShow`
    // corrects it with the final height (accessory bars, predictive strip).
    Keyboard.addListener('keyboardWillShow', (info: any) => setInset(info?.keyboardHeight ?? 0));
    Keyboard.addListener('keyboardDidShow', (info: any) => setInset(info?.keyboardHeight ?? 0));
    Keyboard.addListener('keyboardWillHide', () => setInset(0));
    Keyboard.addListener('keyboardDidHide', () => setInset(0));
  } catch {
    // Plugin unavailable — the app simply keeps the default (0) inset.
  }
}

