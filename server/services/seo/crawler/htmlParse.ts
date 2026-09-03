/**
 * SEO metadata extractor — regex-based, matching the same lightweight style
 * as server/services/ai-agent/crawler/extractText.ts (no cheerio/linkedom in
 * production). This is the ONLY place that reads raw HTML; every other part
 * of the SEO feature (rules engine, scoring, UI) only ever sees the
 * normalized `ParsedPage` shape this module produces.
 */
const STRIP_BLOCK_RE = /<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi;

export interface ParsedLink {
  href: string;
  anchorText: string;
  rel: string | null;
}

export interface ParsedImage {
  src: string;
  hasAlt: boolean;
}

export interface StructuredDataResult {
  has: boolean;
  types: string[];
  errors: string[];
}

export interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  metaRobots: string | null;
  h1: string | null;
  h1Count: number;
  h2Count: number;
  lang: string | null;
  charset: string | null;
  wordCount: number;
  links: ParsedLink[];
  images: ParsedImage[];
  hasOpenGraph: boolean;
  hasTwitterCard: boolean;
  structuredData: StructuredDataResult;
  htmlSizeBytes: number;
}

function firstAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return (m[2] ?? m[3] ?? '').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function metaContent(html: string, matchAttr: (attr: string) => boolean): string | null {
  const metaRe = /<meta\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[1];
    const name = (firstAttr(tag, 'name') || firstAttr(tag, 'property') || '').toLowerCase();
    if (matchAttr(name)) {
      const content = firstAttr(tag, 'content');
      if (content !== null) return decodeEntities(content).trim();
    }
  }
  return null;
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const htmlSizeBytes = Buffer.byteLength(html, 'utf8');

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 500) || null : null;

  const metaDescription = metaContent(html, (n) => n === 'description');
  const metaRobots = metaContent(html, (n) => n === 'robots');

  const canonicalRe = /<link\b([^>]*\brel\s*=\s*("canonical"|'canonical')[^>]*)>/i;
  const canonicalMatch = canonicalRe.exec(html);
  let canonicalUrl: string | null = null;
  if (canonicalMatch) {
    const href = firstAttr(canonicalMatch[1], 'href');
    if (href) {
      try { canonicalUrl = new URL(href, baseUrl).toString(); } catch { canonicalUrl = href; }
    }
  }

  const htmlLangMatch = /<html\b[^>]*\blang\s*=\s*("([^"]+)"|'([^']+)')/i.exec(html);
  const lang = (htmlLangMatch?.[2] || htmlLangMatch?.[3] || '').toLowerCase().slice(0, 12) || null;

  const charsetMetaMatch = /<meta\b[^>]*\bcharset\s*=\s*("([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+))/i.exec(html);
  const httpEquivCharsetMatch = /<meta\b[^>]*http-equiv\s*=\s*("content-type"|'content-type')[^>]*content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html);
  let charset = (charsetMetaMatch?.[2] || charsetMetaMatch?.[3] || charsetMetaMatch?.[4] || '').toLowerCase() || null;
  if (!charset && httpEquivCharsetMatch) {
    const ctVal = httpEquivCharsetMatch[3] || httpEquivCharsetMatch[4] || '';
    const csMatch = /charset=([a-zA-Z0-9_-]+)/i.exec(ctVal);
    if (csMatch) charset = csMatch[1].toLowerCase();
  }

  const h1Matches = Array.from(html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi));
  const h1Count = h1Matches.length;
  const h1 = h1Count > 0
    ? decodeEntities(h1Matches[0][1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 500) || null
    : null;
  const h2Count = (html.match(/<h2\b[^>]*>/gi) || []).length;

  // Links — collected before stripping any blocks.
  const links: ParsedLink[] = [];
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const attrs = lm[1];
    const href = firstAttr(attrs, 'href');
    if (!href) continue;
    if (href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let resolved: string;
    try { resolved = new URL(href, baseUrl).toString(); } catch { continue; }
    const anchorText = decodeEntities(lm[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const rel = firstAttr(attrs, 'rel');
    links.push({ href: resolved, anchorText, rel: rel ? rel.toLowerCase() : null });
  }

  // Images.
  const images: ParsedImage[] = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html)) !== null) {
    const attrs = im[1];
    const src = firstAttr(attrs, 'src') || firstAttr(attrs, 'data-src') || '';
    const alt = firstAttr(attrs, 'alt');
    images.push({ src, hasAlt: alt !== null && alt.trim().length > 0 });
  }

  const hasOpenGraph = /<meta\b[^>]*\bproperty\s*=\s*("|')og:/i.test(html);
  const hasTwitterCard = /<meta\b[^>]*\bname\s*=\s*("|')twitter:card/i.test(html);

  const structuredData = extractStructuredData(html);

  // Word count from visible text (script/style/template stripped, tags removed).
  const stripped = html.replace(STRIP_BLOCK_RE, ' ');
  const text = decodeEntities(stripped.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const wordCount = text ? text.split(' ').filter(Boolean).length : 0;

  return {
    title,
    metaDescription,
    canonicalUrl,
    metaRobots,
    h1,
    h1Count,
    h2Count,
    lang,
    charset,
    wordCount,
    links,
    images,
    hasOpenGraph,
    hasTwitterCard,
    structuredData,
    htmlSizeBytes,
  };
}

const MAX_STRUCTURED_DATA_BLOCKS = 20;

function extractStructuredData(html: string): StructuredDataResult {
  const types = new Set<string>();
  const errors: string[] = [];
  const blockRe = /<script\b[^>]*\btype\s*=\s*("application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = blockRe.exec(html)) !== null && count < MAX_STRUCTURED_DATA_BLOCKS) {
    count++;
    const raw = m[2].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      collectTypes(parsed, types);
    } catch {
      errors.push('invalid_json_ld');
    }
  }
  return { has: count > 0, types: Array.from(types).slice(0, 20), errors: errors.slice(0, 10) };
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') out.add(v);
    if (Array.isArray(obj['@graph'])) collectTypes(obj['@graph'], out);
  }
}
