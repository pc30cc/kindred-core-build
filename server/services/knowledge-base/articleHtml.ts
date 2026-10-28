/**
 * A knowledge-base article's HTML as the server-rendered help center draws it
 * (routes/kb.ts, GET /help/:locale/a/:slug): sanitize-html over the
 * allow-list the SPA's help center uses too (shared/kbArticleHtml.ts). The
 * article is its workspace's writing, untrusted to the visitors of its help
 * center.
 *
 * sanitize-html 2.18 (its htmlparser2 12 is ESM-only, so it needs Node 22.12;
 * the images run Node 24). It fixes the four moderate advisories npm audit
 * flagged against 2.17.5 (a solidus-closed textarea, an early end of a
 * no-text region, SVG SMIL schemes, meta refresh), none of which was
 * reachable here while svg, math, meta, textarea, xmp, noscript and template
 * stay out of KB_ARTICLE_TAGS; src/test/kb/kbArticleHtmlFixtures.ts carries
 * a payload shaped like each.
 */
import sanitizeHtml from 'sanitize-html';
import {
  KB_ARTICLE_ATTRIBUTES,
  KB_ARTICLE_TAGS,
  KB_IMAGE_SCHEMES,
  KB_LINK_SCHEMES,
  kbArticleAttributeAllowed,
  kbLinkRel,
} from '../../../shared/kbArticleHtml.js';

/**
 * Left out with everything inside them (an unclosed one, with the rest of the
 * article): sanitize-html's own list, and what never reads as the article's
 * text (an embed's fallback, a drawing's labels).
 */
const DROPPED_WITH_CONTENT = [
  'script', 'style', 'textarea', 'option', 'xmp',
  'noscript', 'template', 'iframe', 'noembed', 'noframes', 'object', 'title', 'select', 'svg', 'math',
];

/** The attributes a `tag` keeps (shared/kbArticleHtml.ts), and a link's rel. */
function keptAttributes(tag: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Attributes {
  const kept: sanitizeHtml.Attributes = {};
  for (const [name, value] of Object.entries(attribs)) {
    if (kbArticleAttributeAllowed(tag, name, value)) kept[name] = value;
  }
  if (tag === 'a') kept.rel = kbLinkRel(attribs.rel);
  return kept;
}

const KB_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...KB_ARTICLE_TAGS],
  allowedAttributes: Object.fromEntries(
    Object.entries(KB_ARTICLE_ATTRIBUTES).map(([tag, names]) => [tag, [...names]]),
  ),
  // sanitize-html's own scheme check, behind the shared one.
  allowedSchemes: [],
  allowedSchemesByTag: { a: [...KB_LINK_SCHEMES], img: [...KB_IMAGE_SCHEMES] },
  allowProtocolRelative: true,
  disallowedTagsMode: 'discard',
  nonTextTags: DROPPED_WITH_CONTENT,
  // A table's <col> is void too (no </col> after it).
  selfClosing: [...sanitizeHtml.defaults.selfClosing, 'col'],
  transformTags: {
    '*': (tagName, attribs) => ({ tagName, attribs: keptAttributes(tagName, attribs) }),
  },
};

/** The article's HTML with only what shared/kbArticleHtml.ts allows. */
export function sanitizeKbArticleHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(String(html), KB_SANITIZE_OPTIONS);
}
