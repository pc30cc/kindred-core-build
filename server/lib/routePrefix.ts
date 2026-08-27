/** Match an Express route prefix on a complete URL segment boundary. */
export function matchesRoutePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

const PUBLIC_WIDGET_REALTIME_PATHS = new Set([
  '/api/realtime/connect',
  '/api/realtime/subscribe',
]);

/** Routes that use dynamic widget CORS instead of the authenticated app CORS policy. */
export function isPublicWidgetApiPath(path: string): boolean {
  return (
    matchesRoutePrefix(path, '/api/widget') ||
    matchesRoutePrefix(path, '/api/call-widget') ||
    matchesRoutePrefix(path, '/api/visitors') ||
    PUBLIC_WIDGET_REALTIME_PATHS.has(path)
  );
}