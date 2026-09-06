/** Match an Express route prefix on a complete URL segment boundary. */
export function matchesRoutePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Visitor-facing realtime endpoints. These are called by the widget running
 * on a CUSTOMER domain, so they must use the workspace-aware widget CORS
 * policy — never the first-party app CORS allow-list. This array is the ONE
 * source of truth: `server/index.ts` mounts `widgetCorsMiddleware()` on
 * exactly these paths and the app-CORS bypass below reads the same list, so
 * a new public realtime route can never get the two out of sync.
 *
 * Operator-side realtime routes (`/operator-*`, `/admin/*`) stay on app CORS.
 */
export const PUBLIC_WIDGET_REALTIME_ROUTES = [
  '/api/realtime/connect',
  '/api/realtime/subscribe',
  '/api/realtime/visitor-presence',
  '/api/realtime/reconnect-signal',
] as const;

const PUBLIC_WIDGET_REALTIME_PATHS = new Set<string>(PUBLIC_WIDGET_REALTIME_ROUTES);

/** Routes that use dynamic widget CORS instead of the authenticated app CORS policy. */
export function isPublicWidgetApiPath(path: string): boolean {
  return (
    matchesRoutePrefix(path, '/api/widget') ||
    matchesRoutePrefix(path, '/api/call-widget') ||
    matchesRoutePrefix(path, '/api/visitors') ||
    PUBLIC_WIDGET_REALTIME_PATHS.has(path)
  );
}
