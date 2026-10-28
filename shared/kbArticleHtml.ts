/**
 * The HTML a knowledge-base article keeps when a visitor reads it.
 *
 * An article's `content` is written by its workspace: the editor
 * (src/components/app/knowledge/RichTextEditor.tsx), the AI builder
 * (server/services/ai-kb/htmlNormalize.ts) or the API
 * (server/routes/knowledgeBase.ts, which stores any string). To the visitors
 * of its help center it is untrusted, so both help centers sanitize it with
 * this one allow-list, through a vetted sanitizer:
 *   - the server-rendered one (server/routes/kb.ts) with sanitize-html,
 *     server/services/knowledge-base/articleHtml.ts;
 *   - the SPA's (src/pages/public/kb/HelpArticlePage.tsx) with DOMPurify,
 *     src/lib/sanitizeKbHtml.ts.
 * The chat widget's article view cannot import this module: Core sanitizes
 * with its own allow-list over a parsed DOM (public/widget/runtime.js
 * `sanitizeHtml`), a subset of this one.
 *
 * The editor (Tiptap's StarterKit, headings 2 and 3, with Link and Underline)
 * writes p, h2, h3, strong, em, u, s, code, pre, blockquote, ul, ol, li, hr,
 * br and a (href, target, rel). Articles from elsewhere also keep the other
 * headings, images, tables and the usual inline marks. Nothing else: no
 * script, style, iframe, svg, math, form, base, meta, object or embed; no
 * on* handler, no style, class or id (a class or an id reaches the page's
 * own styles and scripts), no data URL.
 */

export const KB_ARTICLE_TAGS: readonly string[] = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
  'blockquote', 'pre', 'code', 'kbd', 'q', 'cite', 'abbr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
  'img', 'figure', 'figcaption',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
];

/** The attributes each tag keeps (`*`: every tag). Names in lower case. */
export const KB_ARTICLE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  '*': ['dir', 'lang', 'title'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  colgroup: ['span'],
  col: ['span'],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
};

/** The schemes a link may use; a relative link needs none. */
export const KB_LINK_SCHEMES: readonly string[] = ['http', 'https', 'mailto', 'tel'];

/** The schemes an image may load from (no data: URL); a relative one needs none. */
export const KB_IMAGE_SCHEMES: readonly string[] = ['http', 'https'];

/**
 * Whether `value`, an attribute's value as the HTML parser decoded it
 * (`jav&#x61;script:` is `javascript:` by then), is a URL with one of
 * `schemes`, or a relative one. A browser drops tabs, newlines and the
 * control characters around a URL before it reads the scheme, so the check
 * reads it without any control character or space (`java\tscript:` is
 * `javascript:`).
 */
export function isKbArticleUrl(value: string, schemes: readonly string[]): boolean {
  // Control characters and any whitespace (Unicode's too, which DOMPurify
  // strips and sanitize-html does not), so both sides read the same scheme.
  const url = String(value).split('').filter((c) => c > ' ' && c !== '\u007f' && !/\s/.test(c)).join('');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return !scheme || schemes.includes(scheme[1].toLowerCase());
}

/**
 * Whether a `tag` element (lower case) keeps its attribute `name` (lower
 * case) with `value`: one the tag may carry, a link's href and an image's
 * src only with a URL it may use, a link's target only `_blank`.
 */
export function kbArticleAttributeAllowed(tag: string, name: string, value: string): boolean {
  if (!KB_ARTICLE_ATTRIBUTES['*'].includes(name) && !(KB_ARTICLE_ATTRIBUTES[tag] ?? []).includes(name)) return false;
  if (tag === 'a' && name === 'href') return isKbArticleUrl(value, KB_LINK_SCHEMES);
  if (tag === 'img' && name === 'src') return isKbArticleUrl(value, KB_IMAGE_SCHEMES);
  if (name === 'target') return value === '_blank';
  return true;
}

/** The rel words an author's link keeps; noopener and noreferrer it always has. */
const KB_LINK_REL_KEPT = ['nofollow', 'ugc', 'sponsored'];

/**
 * A link's rel: "noopener noreferrer", then whichever of nofollow, ugc and
 * sponsored the author's `rel` had (the editor writes "noopener noreferrer
 * nofollow", which stays as it is).
 */
export function kbLinkRel(authored: string | null | undefined): string {
  const kept = String(authored ?? '').toLowerCase().split(/\s+/).filter((word) => KB_LINK_REL_KEPT.includes(word));
  return ['noopener', 'noreferrer', ...new Set(kept)].join(' ');
}
