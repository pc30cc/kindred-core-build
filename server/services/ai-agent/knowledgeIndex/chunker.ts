/**
 * Knowledge chunker. Strips HTML, normalises whitespace, splits long content
 * on paragraph boundaries, then on sentences as a fallback. Conservative —
 * favours a few well-sized chunks over many tiny ones.
 */

const TARGET_CHARS = 4000;        // ~ 1k tokens
const SOFT_OVERLAP = 200;          // a little overlap to preserve context across chunks
const MIN_CHARS = 200;             // anything shorter stays as one chunk

export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function normalizeWhitespace(s: string): string {
  return (s || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export interface Chunk {
  index: number;
  content: string;
}

export function chunkText(raw: string, opts: { targetChars?: number } = {}): Chunk[] {
  const target = opts.targetChars ?? TARGET_CHARS;
  const text = normalizeWhitespace(stripHtml(raw));
  if (!text) return [];
  if (text.length <= Math.max(MIN_CHARS, target)) {
    return [{ index: 0, content: text }];
  }

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
      continue;
    }
    if ((buf.length + p.length + 2) <= target) {
      buf += '\n\n' + p;
    } else {
      chunks.push(buf);
      // soft overlap from tail of previous chunk
      const tail = buf.slice(Math.max(0, buf.length - SOFT_OVERLAP));
      buf = (tail ? tail + '\n\n' : '') + p;
    }
  }
  if (buf) chunks.push(buf);

  // If a single paragraph is still huge, slice it.
  const final: string[] = [];
  for (const c of chunks) {
    if (c.length <= target * 1.5) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += target) {
        final.push(c.slice(i, i + target));
      }
    }
  }
  return final.map((content, index) => ({ index, content }));
}

/** Q&A → one chunk of "Q: …\nA: …". */
export function chunkQna(question: string, answer: string): Chunk[] {
  const content = normalizeWhitespace(`Q: ${question}\nA: ${answer}`);
  return [{ index: 0, content }];
}

/** Business profile / instructions → one short chunk. */
export function chunkBusinessProfile(text: string): Chunk[] {
  const cleaned = normalizeWhitespace(stripHtml(text));
  if (!cleaned) return [];
  return [{ index: 0, content: cleaned.slice(0, target_safe()) }];
}

function target_safe() { return TARGET_CHARS; }