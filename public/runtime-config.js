/**
 * RUNTIME deployment configuration (no rebuild required).
 *
 * `VITE_API_BASE_URL` is baked in at BUILD time, so changing the API domain
 * would normally require rebuilding the frontend image. This file is loaded by
 * index.html BEFORE the app bundle and can be edited/mounted per deployment
 * (Docker volume, Coolify file mount, nginx `/runtime-config.js` override).
 *
 * Leave `apiBaseUrl` empty to use the SAME ORIGIN as the dashboard (the
 * recommended reverse-proxy topology: nginx proxies `/api/` to Express).
 * Set it only when the API lives on a different domain, e.g.:
 *   apiBaseUrl: "https://api.example.com"
 *
 * Everything else (app / public / widget domains, branding, email links) is
 * read from the database — Super Admin → Domains.
 */
window.__APP_RUNTIME_CONFIG__ = {
  apiBaseUrl: "",
  // Configured SITE default language for the dashboard: "en" | "fa" | "tr".
  // Applied on the FIRST render (no English flash) and never overridden by the
  // browser's Accept-Language. A user's explicit choice in the language
  // selector wins and is persisted by the existing i18n mechanism.
  defaultLocale: "fa",
};
