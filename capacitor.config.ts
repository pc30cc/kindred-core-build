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
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
