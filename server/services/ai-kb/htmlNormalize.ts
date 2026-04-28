/**
 * Convert AI-generated article content (HTML or markdown leftovers) into
 * clean widget-safe HTML. Used by both the publish endpoint (legacy data)
 * and the worker (new generations) so the widget never renders raw `###`,
 * `**bold**`, or other markdown artifacts.
 */

const ALLOWED_TAGS = new Set([
  'p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'code', 'pre', 'blockquote', 'br',
]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s: string): string {
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMd(escapeHtml(para.join(' ')))}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flushPara(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      const level = Math.min(Math.max(h[1].length, 2), 3);
      out.push(`<h${level}>${inlineMd(escapeHtml(h[2].trim()))}</h${level}>`);
      i++; continue;
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(inlineMd(escapeHtml(lines[i].trim().replace(/^[-*+]\s+/, ''))));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${it}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(inlineMd(escapeHtml(lines[i].trim().replace(/^\d+[.)]\s+/, ''))));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${it}</li>`).join('')}</ol>`);
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${inlineMd(escapeHtml(buf.join(' ')))}</p></blockquote>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(trimmed)) { flushPara(); i++; continue; }
    para.push(trimmed);
    i++;
  }
  flushPara();
  return out.join('\n');
}

function sanitizeWidgetHtml(html: string): string {
  let s = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(\/?)h1\b[^>]*>/gi, '<$1h2>');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, tag, attrs) => {
    const t = String(tag).toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (t === 'a' && !full.startsWith('</')) {
      const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = (hrefMatch?.[2] || hrefMatch?.[3] || hrefMatch?.[4] || '').trim();
      if (!/^https?:\/\//i.test(href)) return '';
      return `<a href="${href.replace(/"/g, '&quot;')}" rel="nofollow noopener" target="_blank">`;
    }
    return full.startsWith('</') ? `</${t}>` : `<${t}>`;
  });
  s = s.replace(/>\s+</g, '><').trim();
  return s;
}

export function normalizeArticleHtml(input: string | null | undefined): string {
  let s = (input || '').trim();
  if (!s) return '';
  s = s.replace(/^```(?:html|md|markdown)?\s*/i, '').replace(/```$/i, '').trim();
  const looksHtml = /<\/?(p|h[1-6]|ul|ol|li|strong|em|a|code|pre|blockquote|br)\b/i.test(s);
  if (!looksHtml) s = markdownToHtml(s);
  return sanitizeWidgetHtml(s);
}