import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native iOS shell for the SAME React app that ships to the web.
 *
 * The web assets are bundled INSIDE the app (webDir = dist) — we intentionally
 * do NOT set `server.url`, so the app never boots from a remote website.
 * Backend/API/Supabase/AI runtime stay exactly as they are today; the shell
 * only hosts the existing frontend.
 */
const config: CapacitorConfig = {
  appId: 'com.webyar.app',
  appName: 'Webyar',
  webDir: 'dist',
  plugins: {
    // The keyboard must never resize or scroll the web view: the app's own
    // nav bar and tab bar stay pinned and only the composer lifts, driven by
    // the `--kb-inset` CSS variable (src/lib/keyboardInset.ts).
    Keyboard: { resize: 'none' as any, resizeOnFullScreen: false },
    // The installed plugin is @capacitor-firebase/messaging, whose config key
    // is `FirebaseMessaging` (NOT the core `PushNotifications` plugin).
    FirebaseMessaging: { presentationOptions: ['badge', 'sound', 'alert'] },
    // The launch image is dismissed by the app itself (src/lib/appearance.ts)
    // once React has painted a frame. Auto-hiding it on a timer produces a
    // white flash between the launch image and the first real screen.
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0b1220',
      showSpinner: false,
    },
    // The web view paints under the status bar through the safe-area insets,
    // so the bar must not reserve its own strip on top of that. The glyph
    // colour is re-applied from the active theme at runtime.
    StatusBar: { overlaysWebView: true, style: 'LIGHT' },
  },
  ios: {
    // `never`: WKWebView must NOT add its own keyboard/safe-area content
    // insets. With `always` the web view was shifted by the keyboard AND the
    // composer lifted by --kb-inset, which left a keyboard-sized gap.
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,

  },
};

export default config;
