/**
 * AI Agent — file parsers (TXT, MD, CSV, PDF).
 *
 * Strict, self-contained, no OCR, no remote fetch, no macros, no embedded
 * file extraction, no execution. Cap output at MAX_TEXT_CHARS.
 */

const MAX_TEXT_CHARS = 2_000_000;

export type ParserName = 'txt' | 'markdown' | 'csv' | 'pdf';

export interface ParseResult {
  text: string;
  pageCount?: number;
  parser: ParserName;
  warnings: string[];
  textLength: number;
}

export class ParseError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

const TEXT_MIMES = new Set(['text/plain']);
const MD_MIMES = new Set(['text/markdown', 'text/x-markdown', 'application/x-markdown']);
const CSV_MIMES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']);
const PDF_MIMES = new Set(['application/pdf']);

export const SUPPORTED_MIMES: string[] = [
  ...TEXT_MIMES, ...MD_MIMES, ...CSV_MIMES, ...PDF_MIMES,
];

export function isSupportedMime(mime: string): boolean {
  return SUPPORTED_MIMES.includes((mime || '').toLowerCase());
}

export function parserFor(mime: string): ParserName | null {
  const m = (mime || '').toLowerCase();
  if (TEXT_MIMES.has(m)) return 'txt';
  if (MD_MIMES.has(m)) return 'markdown';
  if (CSV_MIMES.has(m)) return 'csv';
  if (PDF_MIMES.has(m)) return 'pdf';
  return null;
}

function normalizeText(s: string): string {
  if (!s) return '';
  // Strip control chars except \n \t
  const cleaned = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function capText(text: string, warnings: string[]): string {
  if (text.length > MAX_TEXT_CHARS) {
    warnings.push('text_truncated');
    return text.slice(0, MAX_TEXT_CHARS);
  }
  return text;
}

function decodeBuffer(buf: Buffer): string {
  // Try UTF-8 first; fall back to latin1 if replacement chars appear excessively.
  const utf8 = buf.toString('utf8');
  const replCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replCount > 5 && replCount / Math.max(utf8.length, 1) > 0.001) {
    return buf.toString('latin1');
  }
  return utf8;
}

async function parseTxt(buffer: Buffer): Promise<ParseResult> {
  const warnings: string[] = [];
  const text = capText(normalizeText(decodeBuffer(buffer)), warnings);
  if (!text) throw new ParseError('empty_text');
  return { text, parser: 'txt', warnings, textLength: text.length };
}

async function parseMarkdown(buffer: Buffer): Promise<ParseResult> {
  const warnings: string[] = [];
  const text = capText(normalizeText(decodeBuffer(buffer)), warnings);
  if (!text) throw new ParseError('empty_text');
  return { text, parser: 'markdown', warnings, textLength: text.length };
}

async function parseCsv(buffer: Buffer): Promise<ParseResult> {
  const warnings: string[] = [];
  // Treat CSV as plain text (no remote fetch, no formulas executed).
  const text = capText(normalizeText(decodeBuffer(buffer)), warnings);
  if (!text) throw new ParseError('empty_text');
  return { text, parser: 'csv', warnings, textLength: text.length };
}

async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const warnings: string[] = [];
  let mod: any;
  try {
    mod = await import('pdf-parse');
  } catch (e: any) {
    throw new ParseError('pdf_parser_unavailable', e?.message);
  }
  const PDFParse = mod?.PDFParse || mod?.default?.PDFParse;
  if (!PDFParse) throw new ParseError('pdf_parser_unavailable', 'PDFParse export missing');

  let result: any;
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    result = await parser.getText();
  } catch (e: any) {
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('password') || msg.includes('encrypt')) {
      throw new ParseError('pdf_encrypted_or_unreadable', e?.message);
    }
    throw new ParseError('pdf_parse_failed', e?.message);
  }

  const rawText: string = typeof result?.text === 'string' ? result.text : '';
  const pageCount: number | undefined =
    typeof result?.total === 'number' ? result.total :
    typeof result?.numpages === 'number' ? result.numpages :
    Array.isArray(result?.pages) ? result.pages.length :
    undefined;

  const text = capText(normalizeText(rawText), warnings);
  if (!text) {
    // Image-only / scanned PDF: no OCR in this pass.
    throw new ParseError('no_text_extracted',
      'PDF appears to contain no extractable text. OCR is not enabled.');
  }
  return { text, pageCount, parser: 'pdf', warnings, textLength: text.length };
}

export async function parseAiFile(
  mime: string,
  buffer: Buffer,
): Promise<ParseResult> {
  const p = parserFor(mime);
  if (!p) throw new ParseError('unsupported_file_type');
  switch (p) {
    case 'txt': return parseTxt(buffer);
    case 'markdown': return parseMarkdown(buffer);
    case 'csv': return parseCsv(buffer);
    case 'pdf': return parsePdf(buffer);
  }
}

export const PARSER_LIMITS = { MAX_TEXT_CHARS };