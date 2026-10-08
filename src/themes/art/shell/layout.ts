/**
 * Where a route sits in the Art frame. Classic decides its own full-bleed
 * routes in AppLayout; Art decides here, from the path after the workspace
 * slug, so a sub-page that merely ends in `/settings` (the call center's or
 * the AI agent's) is not mistaken for the workspace settings.
 */

/**
 * The part of `pathname` after the workspace's own prefix (`base`, e.g.
 * `/studio`): '' on the dashboard, `/inbox`, `/settings/general`, ...
 * Without a trailing slash, so an exact comparison works.
 */
export function artSubPath(pathname: string, base: string) {
  const root = base.replace(/\/+$/, '');
  const rest = pathname === root || pathname.startsWith(`${root}/`) ? pathname.slice(root.length) : pathname;
  return rest.replace(/\/+$/, '');
}

/**
 * Routes that fill everything under the bars, edge to edge, and scroll inside
 * themselves: the two inboxes and the pages built around a side list. Every
 * other page is a normal page in the centred column (theme.css).
 */
const FULL_BLEED = /^\/(inbox|email|settings|visitors|ai-agent|seo|analytics)(\/|$)/;

export function isArtFullBleed(subPath: string) {
  return FULL_BLEED.test(subPath);
}
