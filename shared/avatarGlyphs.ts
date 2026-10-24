/**
 * The platform's two avatar glyphs (owner, 2026-10-24): an operator or a
 * team member without a photo is a person silhouette, and a workspace
 * without a logo is a storefront, never a letter, on every surface (the
 * chat and call widgets, the web panel, the native apps).
 *
 * Both are one filled path in a 24-unit box (bounding box y 3 to 21, left
 * to right symmetric, so no mirroring in RTL; no overlapping subpaths, so
 * nonzero and evenodd fill the same pixels), drawn in the colour the
 * initial's text had, on the tile the initial had, aria-hidden. The glyph
 * box is 62% of the avatar for the person (68% at 20-24 px) and 58% for
 * the workspace (62% at 20-24 px).
 *
 * The widgets' static files cannot import this module, so each stylesheet
 * that draws a glyph holds a copy as a CSS data URI (public/widget/runtime.css,
 * public/widget/runtime-fab.css, public/call-widget/runtime.css and
 * public/call-widget/presentation-default-panel.css):
 * src/test/widget/avatarGlyphs.test.ts checks every copy against these paths.
 */

/** A head (r 4.5 at 12, 7.5) over rounded shoulders (x 4 to 20, y 13.75 to 21). */
export const PERSON_SILHOUETTE =
  'M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 10.75c-4.6 0-8 2.3-8 5.25 0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2 0-2.95-3.4-5.25-8-5.25z';

/** A shop front: a scalloped awning over two walls and an arched door, one contour with one counter. */
export const WORKSPACE_MARK =
  'M6.6 3h10.8q.9 0 1.38.83L21.5 8.5A2.375 2.375 0 0 1 20.25 10.59v8.16A2.25 2.25 0 0 1 18 21H6a2.25 2.25 0 0 1-2.25-2.25v-8.16A2.375 2.375 0 0 1 2.5 8.5l2.72-4.67Q5.7 3 6.6 3zm-.85 7.71v8.04q0 .25.25.25h4v-2.75a2 2 0 0 1 4 0V19h4q.25 0 .25-.25v-8.04A2.375 2.375 0 0 1 16.75 8.5a2.375 2.375 0 0 1-4.75 0 2.375 2.375 0 0 1-4.75 0 2.375 2.375 0 0 1-1.5 2.21z';

/**
 * The glyph as a CSS `url()` value's data URI, encoded as the widgets'
 * stylesheets encode their SVGs (no literal "http://", which their rules
 * forbid; `%3C`/`%3E`, single-quoted attributes). Without `fill` it is a
 * mask (the opaque default black; the colour comes from
 * `background: currentColor`); with one, a background whose ink is baked in.
 */
export function glyphDataUri(path: string, fill?: string): string {
  const fillAttr = fill ? ` fill='${fill.replace(/#/g, '%23')}'` : '';
  return `data:image/svg+xml,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 24 24'${fillAttr}%3E%3Cpath d='${path}'/%3E%3C/svg%3E`;
}
