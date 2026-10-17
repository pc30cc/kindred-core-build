/**
 * The widget's font files (public/widget/fonts/*.woff2) as a stylesheet names
 * them: `url(fonts/<name>.woff2)`, relative to the stylesheet, so the same
 * source works unhashed in dev and in the live preview. The build
 * (scripts/widget-hash.js) content-hashes each named file and rewrites the
 * url() to `fonts/<name>.<hash>.woff2` before it hashes the stylesheet, so a
 * font change is a new stylesheet URL too.
 */
export const FONT_URL_RE = /url\((['"]?)fonts\/([a-z0-9-]+\.woff2)\1\)/g;

/** Every font file a stylesheet names, in order of first use. */
export function widgetFontNames(css) {
  return [...new Set([...String(css).matchAll(FONT_URL_RE)].map((m) => m[2]))];
}

/**
 * `css` with each `url(fonts/<name>.woff2)` replaced by
 * `url(<hashedPath(name)>)`; hashedPath throws for a file that does not exist.
 * @param {string} css
 * @param {(name: string) => string} hashedPath
 */
export function rewriteWidgetFontUrls(css, hashedPath) {
  return String(css).replace(FONT_URL_RE, (_m, _q, name) => `url(${hashedPath(name)})`);
}
