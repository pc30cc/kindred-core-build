/**
 * What an avatar tile of the chat or call widget shows, for tests (owner,
 * 2026-10-24: a person without a photo is the person silhouette and a
 * workspace without a logo its storefront, both drawn by the stylesheets on
 * an empty tile; never a letter):
 *   - the tile's text when it holds any: a letter, which the rule forbids
 *     (only the visitor's own call contact card keeps one);
 *   - 'photo' for an image, 'icon' for an inline glyph (the call widget's
 *     headset before an operator's name is known);
 *   - 'workspace' for the storefront: the reserved tile (.c4), the home
 *     logo tile, the call panel's header (.lg.ws), `default`'s .wy-avatar;
 *   - 'person' for the silhouette: any other empty person tile (.av, the
 *     call widget's .sil);
 *   - null when there is no tile.
 */
export function avatarFace(el: Element | null | undefined): string | null {
  if (!el) return null;
  const text = (el.textContent || '').trim();
  if (text) return text;
  if (el.querySelector('img')) return 'photo';
  if (el.querySelector('svg')) return 'icon';
  if (el.matches('.c4, .logo, .lg.ws, .wy-avatar')) return 'workspace';
  if (el.matches('.av, .sil')) return 'person';
  return 'empty';
}

/** Each tile's face, in document order. */
export const avatarFaces = (els: ArrayLike<Element>) => Array.from(els).map((el) => avatarFace(el));
