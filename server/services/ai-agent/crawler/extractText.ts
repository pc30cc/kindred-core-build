/**
 * Minimal HTML → (title, text, links) extractor for the Data Hub crawler.
 * No JS execution. We strip script/style/nav/footer/header before extracting
 * text so we keep mostly meaningful body content.
 */

const STRIP_BLOCK_RE = /<(script|style|noscript|template|nav|footer|header|aside|form|svg)\b[\s\S]*?<\/\1>/gi;

import { createHash } from 'node:crypto';

export interface ExtractResult {
  title: string;
  text: string;
  textLength: number;
  locale: string | null;
  links: string[];
}

export function extractFromHtml(html: string, baseUrl: string): ExtractResult {
  // Title.
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = (titleMatch?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 240);

  // Lang.
  const langMatch = /<html\b[^>]*\blang\s*=\s*("([^"]+)"|'([^']+)')/i.exec(html);
  const locale = (langMatch?.[2] || langMatch?.[3] || '').toLowerCase().slice(0, 8) || null;

  // Links — collect before stripping nav so we still discover navigation.
  const links = new Set<string>();
  const linkRe = /<a\b[^>]*\bhref\s*=\s*("([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = (m[2] || m[3] || '').trim();
    if (!href) continue;
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try { links.add(new URL(href, baseUrl).toString()); } catch { /* ignore */ }
  }

  // Strip non-content blocks then tags.
  const stripped = html.replace(STRIP_BLOCK_RE, ' ');
  const text = stripped
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return { title, text, textLength: text.length, locale, links: Array.from(links) };
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}