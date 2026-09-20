/**
 * Catalog-export URL construction — deliberately a leaf module.
 *
 * It lives apart from sync.ts (which pulls in Supabase, the connector and
 * the product index) so the unit tests that pin the signing convention can
 * import it without dragging a database client into the test environment.
 */

/** Products requested per catalog-export page. */
export const PAGE_SIZE = 50;

const CATALOG_EXPORT_ROUTE = '/wp-json/webyar/v1/catalog/export';

/**
 * Splits the export URL into the path that gets SIGNED and the path that
 * gets REQUESTED.
 *
 * These differ on purpose. The plugin's canonical path is
 * `'/wp-json' . WP_REST_Request::get_route()` (Auth/ReplayGuard.php), which
 * never carries the query string, and every call in
 * connectors/woocommerce.ts already signs a query-less path. Signing the
 * full URL instead made catalog export the one caller that disagreed, so
 * every sync page came back 401 bad_signature. Keeping the two apart here —
 * and asserting it in signing.test.ts — stops that returning.
 */
export function catalogExportPaths(
  page: number,
  modifiedAfter: string | null,
): { signedPath: string; requestPath: string } {
  const query = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE) });
  if (modifiedAfter) query.set('modified_after', modifiedAfter);
  return { signedPath: CATALOG_EXPORT_ROUTE, requestPath: `${CATALOG_EXPORT_ROUTE}?${query.toString()}` };
}
