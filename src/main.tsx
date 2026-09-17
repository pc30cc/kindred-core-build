import { installKeyboardInset } from '@/lib/keyboardInset';
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { loadFontsForLocale } from "./lib/fonts";
import { getStoredLocale, loadLocaleMessages } from "./i18n";
import { installLocalizedDateDefaults, setAppDateLocale } from "./lib/date";
import { CALL_VIDEO_ORIENTATION_CORRECTION_MODE } from "./features/calls/videoOrientation";
import { applyNativeShellClasses } from "./lib/native";
import { installNativeAppearance, hideSplashWhenReady } from "./lib/appearance";
import { hydrateMobileSession } from "./lib/mobileSession";
import { installAuthTransport } from "./lib/authFetch";
import { applyUiPreferences, loadPlatformUiDefaults, loadUiPreferences, resolveUiPreferences } from "./lib/ui-preferences";
import { registerServiceWorker } from "./lib/pwa";

// Native shell (iOS) gets safe-area padding; no-op on the web.
applyNativeShellClasses();

// Apply personal UI preferences before first paint (no flash of default theme).
applyUiPreferences(resolveUiPreferences(loadPlatformUiDefaults(), loadUiPreferences()));

function logCallUiBuildVersion() {
  try {
    const appBundle = Array.from(document.scripts)
      .map((s) => s.src)
      .find((src) => /\/assets\/index-[^/]+\.js(?:$|\?)/.test(src))
      ?.split('/')
      .pop() || 'unknown';
    const appCss = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .map((l) => l.href)
      .find((href) => /\/assets\/index-[^/]+\.css(?:$|\?)/.test(href))
      ?.split('/')
      .pop() || 'unknown';
    console.info('[call-ui] orientation correction', {
      appBundle,
      appCss,
      widgetCss: 'pending',
      correction: CALL_VIDEO_ORIENTATION_CORRECTION_MODE,
      verifiedVisually: false,
    });
    fetch('/widget/widget-manifest.json', {credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((manifest) => {
        if (!manifest) return;
        console.info('[call-ui] orientation correction', {
          appBundle,
          appCss,
          widgetCss: manifest['runtime.css'] || 'unknown',
          widgetRuntime: manifest['runtime.js'] || 'unknown',
          widgetRuntimeCall: manifest['runtime-call.js'] || 'unknown',
          correction: CALL_VIDEO_ORIENTATION_CORRECTION_MODE,
          verifiedVisually: false,
        });
      })
      .catch(() => {});
  } catch {
    /* diagnostic only */
  }
}

// Set dir/lang immediately to prevent layout flash
const storedLocale = getStoredLocale();
installLocalizedDateDefaults();
setAppDateLocale(storedLocale);
loadFontsForLocale(storedLocale);
document.documentElement.lang = storedLocale;
document.documentElement.dir = ['fa', 'ar'].includes(storedLocale) ? 'rtl' : 'ltr';

async function bootstrap() {
  // Native only: load the Keychain session token and install the shared
  // Bearer transport BEFORE the first authenticated request. No-op on web.
  await hydrateMobileSession();
  installAuthTransport();

  const initialTranslations = await loadLocaleMessages(storedLocale);

  const root = document.getElementById("root")!;
  createRoot(root).render(
    <App initialLocale={storedLocale} initialTranslations={initialTranslations} />
  );
  logCallUiBuildVersion();
  // Reveal UI only after React has mounted with correct translations
  requestAnimationFrame(() => { root.style.opacity = '1'; });

  // Native shell only. Both of these belong HERE, not in the authenticated
  // layout: the launch image is configured not to auto-hide, so hiding it
  // from a screen that only mounts after sign-in would leave an unauthenticated
  // user staring at the splash forever. Same for the status-bar tint — the
  // login screen needs the right glyph colour too.
  installNativeAppearance();
  hideSplashWhenReady();
}

void bootstrap();

void installKeyboardInset();
registerServiceWorker();
