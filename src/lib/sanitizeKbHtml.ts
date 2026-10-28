/**
 * A knowledge-base article's HTML as the SPA's help center draws it
 * (src/pages/public/kb/HelpArticlePage.tsx): DOMPurify over the allow-list
 * the server-rendered help center uses too (shared/kbArticleHtml.ts). The
 * article is its workspace's writing, untrusted to the visitor reading it.
 */
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';
import {
  KB_ARTICLE_ATTRIBUTES,
  KB_ARTICLE_TAGS,
  kbArticleAttributeAllowed,
  kbLinkRel,
} from '../../shared/kbArticleHtml';

const KB_PURIFY_CONFIG = {
  ALLOWED_TAGS: [...KB_ARTICLE_TAGS],
  // Every tag's attributes; the hook below keeps each to its own tags.
  ALLOWED_ATTR: [...new Set(Object.values(KB_ARTICLE_ATTRIBUTES).flat())],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

let kbPurifier: Purifier | null = null;

/** A DOMPurify of its own, so its hooks never reach another caller's (the email reader's). */
function purifier(): Purifier {
  if (kbPurifier) return kbPurifier;
  const p = DOMPurify(window);
  // An attribute only on its own tags; a link's href and an image's src
  // only with a URL they may use (no javascript:, no data:).
  p.addHook('uponSanitizeAttribute', (node, event) => {
    if (!kbArticleAttributeAllowed(node.nodeName.toLowerCase(), event.attrName, event.attrValue)) event.keepAttr = false;
  });
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') node.setAttribute('rel', kbLinkRel(node.getAttribute('rel')));
  });
  kbPurifier = p;
  return p;
}

/** The article's HTML with only what shared/kbArticleHtml.ts allows. */
export function sanitizeKbHtml(html: string | null | undefined): string {
  if (!html) return '';
  return purifier().sanitize(String(html), KB_PURIFY_CONFIG);
}
