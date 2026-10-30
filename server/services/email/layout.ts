/**
 * THE PLATFORM EMAIL LAYOUT — every platform mail's look, in code.
 *
 * A template row (`email_templates`) holds only the CONTENT of a mail, in a
 * small vocabulary a Super Admin can read and edit by hand:
 *
 *   div.preheader                  the hidden inbox preview (first, optional)
 *   h1                             the title (one)
 *   p, p.note                      a paragraph; small muted text
 *   p.action > a                   the button (exactly one link)
 *   div.code                       a one-time code, always left to right
 *   table.details > tr > th + td   a key/value summary
 *   blockquote                     a customer's own words
 *   div.warning, div.notice        callouts
 *   hr, strong, a, br              separators and inline text
 *   div.transcript > div.msg.msg-visitor|msg-agent > div.meta + div.bubble
 *
 * Anything else passes through as it is. The email core (./index.ts) fills a
 * row's placeholders and hands the result here at send time, with the brand
 * resolved then too, so a mail queued yesterday still wears today's logo.
 * The look is the "brand band" design (owner, 2026-10-30): a solid band in
 * the brand's colour carrying the logo, a white card rising out of it, the
 * logos' chat-bubble tail on the card, the button, the code box, the details
 * and the callouts, one short saffron (WebYar) or signal (RESPOK) dash above
 * the title, and a quiet footer under the card.
 *
 * Why it is built the way it is:
 *
 *   - The content is PARSED, never rewritten with markers. Every value a
 *     sender fills in arrives escaped, so it is text to the parser whatever
 *     it says: a visitor who types `<div class="code">` or a control
 *     character gets exactly those characters back. (A design that swapped
 *     blocks for numbered markers and swapped them back let a typed marker
 *     pull a copy of the button, link and token included, into the mail.)
 *   - Our inline style goes FIRST and an author's after it, so a Super Admin's
 *     own `style` always wins. Dark mode keeps an author's colours readable:
 *     an element with its own background keeps its own (dark) text and its
 *     subtree leaves dark mode alone; a colour without a background still
 *     gets the dark class, whose !important colour wins on a dark card.
 *   - Running the styler on its own output changes nothing: everything it
 *     makes carries an `x-` class, and an element that has one is passed on
 *     as it is, so a styled preview pasted back into a row cannot be styled
 *     twice.
 *   - Direction and fonts follow the LANGUAGE, not the brand: a Persian mail
 *     is right to left in IRANSans in both editions; English and Turkish are
 *     Figtree. Codes are always in a Latin face, left to right.
 *   - Email clients: everything that matters is inline; tables carry the
 *     layout (Outlook pads cells, not tables); the head's styles are split
 *     into blocks so one a client rejects cannot take the others with it;
 *     Outlook gets its own font list (it falls back to Times otherwise);
 *     nothing is hidden but the preheader; a long address, link or code
 *     breaks rather than widen a phone.
 *
 * No I/O here: the brand (name, logo, links, the legal line) is passed in.
 */

import type { Edition } from '../../../shared/edition.js';
import { EDITION_PROFILE } from '../../../shared/edition.js';
import type { EmailCategory } from './providers/types.js';

/* ───────────────────────────────────────────────────────────── palettes ── */

export interface EmailPalette {
  canvas: string; band: string; card: string;
  ink: string; muted: string; line: string; panel: string;
  accent: string; onAccent: string; link: string; highlight: string;
  codeBg: string; codeInk: string; codeLine: string;
  warningBg: string; warningInk: string; warningEdge: string;
  noticeBg: string; noticeInk: string; noticeEdge: string;
  quoteBg: string; quoteInk: string;
  bubbleVisitor: string; bubbleVisitorInk: string;
  bubbleAgent: string; bubbleAgentInk: string;
  footInk: string; onBand: string;
}

/**
 * Every text pair is at least 4.5:1 (src/test/email/emailLayout.test.ts
 * checks them). WebYar is deep teal with a saffron dash; RESPOK is ink with a
 * signal dash, and its dark scheme stays on its kit (ink and signal): an
 * ink-raised band, and the reader's own messages in signal with ink text.
 */
export const EMAIL_PALETTES: Readonly<Record<Edition, { light: EmailPalette; dark: EmailPalette }>> = {
  iran: {
    light: {
      canvas: '#EEF2F3', band: '#0B5F55', card: '#FFFFFF',
      ink: '#12141F', muted: '#565D6B', line: '#E3E6EB', panel: '#F4F6F8',
      accent: '#0B7D6C', onAccent: '#FFFFFF', link: '#0A7262', highlight: '#FFB423',
      codeBg: '#E9F8F4', codeInk: '#0B2F2A', codeLine: '#BFEADF',
      warningBg: '#FFF4DB', warningInk: '#5A3D00', warningEdge: '#FFB423',
      noticeBg: '#E6F6F2', noticeInk: '#0A4A42', noticeEdge: '#16C7A8',
      quoteBg: '#F1F4F6', quoteInk: '#12141F',
      bubbleVisitor: '#0B7D6C', bubbleVisitorInk: '#FFFFFF',
      bubbleAgent: '#F1F4F6', bubbleAgentInk: '#12141F',
      footInk: '#565D6B', onBand: '#FFFFFF',
    },
    dark: {
      canvas: '#0B0F12', band: '#0A3F39', card: '#161B21',
      ink: '#ECF0F2', muted: '#A2AAB5', line: '#2A323B', panel: '#1D232A',
      accent: '#16C7A8', onAccent: '#06211C', link: '#4FD8BF', highlight: '#FFB423',
      codeBg: '#0F2D29', codeInk: '#D9FBF3', codeLine: '#1C4A43',
      warningBg: '#33270B', warningInk: '#FFD98C', warningEdge: '#FFB423',
      noticeBg: '#0E2C28', noticeInk: '#A6EEDF', noticeEdge: '#16C7A8',
      quoteBg: '#1F262D', quoteInk: '#ECF0F2',
      bubbleVisitor: '#0B7D6C', bubbleVisitorInk: '#FFFFFF',
      bubbleAgent: '#222A32', bubbleAgentInk: '#ECF0F2',
      footInk: '#9AA2AD', onBand: '#FFFFFF',
    },
  },
  international: {
    light: {
      canvas: '#EFEFF4', band: '#16142B', card: '#FFFFFF',
      ink: '#16142B', muted: '#5E5C75', line: '#E4E3EC', panel: '#F5F5F8',
      accent: '#C83319', onAccent: '#FFFFFF', link: '#B92F17', highlight: '#FF5A3C',
      codeBg: '#FFF1ED', codeInk: '#16142B', codeLine: '#FFD3C8',
      warningBg: '#FFF0EB', warningInk: '#8A2410', warningEdge: '#FF5A3C',
      noticeBg: '#EFEEF6', noticeInk: '#2A2747', noticeEdge: '#5E5C75',
      quoteBg: '#F2F1F7', quoteInk: '#16142B',
      bubbleVisitor: '#16142B', bubbleVisitorInk: '#FFFFFF',
      bubbleAgent: '#F2F1F7', bubbleAgentInk: '#16142B',
      footInk: '#5E5C75', onBand: '#FFFFFF',
    },
    dark: {
      canvas: '#0B0A15', band: '#1B1932', card: '#14132A',
      ink: '#F1F0F7', muted: '#A9A7BE', line: '#2C2A44', panel: '#1B1A30',
      accent: '#FF5A3C', onAccent: '#16142B', link: '#FF8F75', highlight: '#FF5A3C',
      codeBg: '#2A1A22', codeInk: '#FFE3DB', codeLine: '#4A2A2C',
      warningBg: '#3A1912', warningInk: '#FFB9A7', warningEdge: '#FF5A3C',
      noticeBg: '#1D1C31', noticeInk: '#DAD8EC', noticeEdge: '#8E8BAD',
      quoteBg: '#1D1C31', quoteInk: '#F1F0F7',
      bubbleVisitor: '#FF5A3C', bubbleVisitorInk: '#16142B',
      bubbleAgent: '#1F1E33', bubbleAgentInk: '#F1F0F7',
      footInk: '#A09EB6', onBand: '#FFFFFF',
    },
  },
};

/* ───────────────────────────────────────────────────── language and type ── */

const RTL_LANGS = new Set(['fa', 'ar', 'he', 'ur', 'ckb', 'ps']);

/** `fa-IR` → `fa`; anything empty → `en`. */
export function baseLocale(locale: unknown): string {
  return String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0] || 'en';
}

export function directionOf(locale: unknown): 'rtl' | 'ltr' {
  return RTL_LANGS.has(baseLocale(locale)) ? 'rtl' : 'ltr';
}

/** [font-size, line-height] in px: whole pixels, which Outlook and Windows round the same way. */
interface TypeScale {
  body: [number, number]; h1: [number, number]; h1Ls: string; note: [number, number];
  key: [number, number]; meta: [number, number]; foot: [number, number]; legal: [number, number];
  btn: [number, number]; bubble: [number, number]; callout: [number, number];
}

const PERSIAN_TYPE: TypeScale = {
  body: [17, 31], h1: [24, 38], h1Ls: '0', note: [15, 26], key: [15, 26], meta: [13, 20],
  foot: [13, 24], legal: [12, 22], btn: [16, 24], bubble: [16, 28], callout: [16, 29],
};
const LATIN_TYPE: TypeScale = {
  body: [16, 26], h1: [26, 33], h1Ls: '-0.3px', note: [14, 22], key: [15, 22], meta: [12, 18],
  foot: [13, 21], legal: [12, 18], btn: [16, 22], bubble: [15, 23], callout: [15, 24],
};

/** A Latin face for codes and other Latin runs, in every language (digits stay typeable). */
const LATIN_UI = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

interface FontSet {
  stack: string;
  /** Outlook (Word) falls back to Times for a web font: it gets a font it has. */
  mso: string;
  faces: Array<{ family: string; file: string; weight: string; range: string }>;
}

const IRANSANS_RANGE = 'U+0000-00FF, U+02BC-02F3, U+0300-0323, U+0600-06FF, U+2000-2044, U+2202-2265, U+FB50-FDFF, U+FE70-FEFF';
const FIGTREE_TR_RANGE = 'U+011E-011F, U+0130, U+015E-015F';
const FIGTREE_LATIN_RANGE = 'U+0020-007E, U+00A0-00AC, U+00AE-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, U+2018-201A, U+201C-201E, U+2022, U+2026, U+2039-203A, U+2044, U+20AC, U+2122';

/**
 * The faces by language: IRANSans for Persian (the owner's rule for Persian
 * text, in both brands), Figtree for the rest (its Turkish letters in their
 * own small file). The files are the widget's (public/widget/fonts), served
 * unhashed by every app host. Gmail ignores web fonts, so each stack falls
 * back to a system face that reads the same language.
 */
function fontsFor(locale: string): FontSet {
  if (baseLocale(locale) === 'fa') {
    return {
      stack: "IRANSans,Tahoma,'Segoe UI',Arial,sans-serif",
      mso: 'Tahoma,Arial,sans-serif',
      faces: [
        { family: 'IRANSans', file: 'iransans-400.woff2', weight: '400', range: IRANSANS_RANGE },
        { family: 'IRANSans', file: 'iransans-700.woff2', weight: '700', range: IRANSANS_RANGE },
      ],
    };
  }
  return {
    stack: "Figtree,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    mso: "'Segoe UI',Arial,sans-serif",
    faces: [
      { family: 'Figtree', file: 'figtree-tr.woff2', weight: '400 800', range: FIGTREE_TR_RANGE },
      { family: 'Figtree', file: 'figtree-latin.woff2', weight: '400 800', range: FIGTREE_LATIN_RANGE },
    ],
  };
}

/* ─────────────────────────────────────────────── the brand and the footer ── */

export interface EmailBrand {
  edition: Edition;
  /** The platform's name in the mail's language ({brand}). */
  name: string;
  /** The panel's address (https://app…), '' when unknown: the footer link and the font host. */
  appUrl: string;
  /** Where the logo links to, '' for no link. */
  siteUrl: string;
  supportEmail: string;
  /** The footer's last line, already in the mail's language (legalLine). */
  legal: string;
  /**
   * The logo as PNGs (email clients do not show SVG): the one for light
   * backgrounds, the one for dark ones (the same URL when the brand has no
   * dark variant), and the light one's natural size. Null: the brand name
   * stands in, in text.
   */
  logo: { light: string; dark: string; width: number; height: number } | null;
}

/**
 * Why the mail came, under the card, in the mail's language, by what kind of
 * mail it is. A notification that carries its own closing line (the
 * unsubscribe link) shows that line instead.
 */
const WHY_LINES: Readonly<Record<'fa' | 'en' | 'tr', Readonly<Record<EmailCategory, (brand: string) => string>>>> = {
  en: {
    transactional: (b) => `This is a service email from ${b}.`,
    notification: (b) => `You get this email because notifications from ${b} are on for this address.`,
    marketing: (b) => `You get this email because you have a ${b} account.`,
  },
  fa: {
    transactional: (b) => `این ایمیل خدماتی از طرف ${b} است.`,
    notification: (b) => `این ایمیل را دریافت می‌کنید، چون اعلان‌های ${b} برای این نشانی روشن است.`,
    marketing: (b) => `این ایمیل را دریافت می‌کنید، چون در ${b} حساب دارید.`,
  },
  tr: {
    transactional: (b) => `Bu, ${b} tarafından gönderilen bir hizmet e-postasıdır.`,
    notification: (b) => `Bu adres için ${b} bildirimleri açık olduğundan bu e-postayı alıyorsunuz.`,
    marketing: (b) => `${b} hesabınız olduğu için bu e-postayı alıyorsunuz.`,
  },
};

export function whyLine(category: EmailCategory, locale: string, brand: string): string {
  const lines = WHY_LINES[baseLocale(locale) as 'fa' | 'en' | 'tr'] ?? WHY_LINES.en;
  return (lines[category] ?? lines.transactional)(brand);
}

/**
 * The year as the mail's reader counts it: the Persian (Jalali) year with
 * Persian digits in a Persian mail of the Iranian edition, the Gregorian one
 * in Persian digits in the International edition's Persian mail (the
 * edition's calendar, as the invitation mail dates it), and the Gregorian
 * year elsewhere.
 */
export function localYear(locale: string, edition: Edition, now: Date = new Date()): string {
  if (baseLocale(locale) !== 'fa') return String(now.getUTCFullYear());
  const tag = EDITION_PROFILE[edition]?.calendar === 'gregorian' ? 'fa-IR-u-ca-gregory' : 'fa-IR-u-ca-persian';
  try {
    return new Intl.DateTimeFormat(tag, { year: 'numeric', timeZone: 'UTC' }).format(now).replace(/\s*(ه\.ش\.|م\.)\s*/g, '').trim();
  } catch {
    return String(now.getUTCFullYear());
  }
}

/**
 * The footer's legal line: the Super Admin's own footer text for that
 * language when there is one, else © the year and the legal company name,
 * else © the year and the brand.
 */
export function legalLine(input: {
  footerText?: string | null;
  company?: string | null;
  brand: string;
  locale: string;
  edition: Edition;
  now?: Date;
}): string {
  const own = String(input.footerText ?? '').trim();
  if (own) return own;
  const who = String(input.company ?? '').trim() || input.brand;
  return `© ${localYear(input.locale, input.edition, input.now)} ${who}`.trim();
}

/* ─────────────────────────────────────────────────────────────── parsing ── */

interface Attr { name: string; value: string | null }
interface ElementNode { kind: 'el'; name: string; attrs: Attr[]; children: Node[] }
type Node = { kind: 'text'; raw: string } | { kind: 'comment'; raw: string } | ElementNode;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['style', 'script', 'title', 'textarea']);
/** Opening one of these ends an open `<p>`, as a browser reads it. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
/** A tag longer than this is not a tag: its `<` stays text (bounds the scan on hostile input). */
const MAX_TAG = 8192;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source: string): Attr[] {
  const out: Attr[] = [];
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(source); m; m = ATTR_RE.exec(source)) {
    out.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
  }
  return out;
}

/**
 * A forgiving HTML reader, enough for a mail's content: elements with their
 * attributes exactly as written (entities kept), text as written, comments
 * (Outlook's conditional ones included) as written. An element left open is
 * closed where its parent ends; a closing tag that closes nothing is dropped
 * (left in, it could close the layout's own table around the content).
 */
function parseHtml(html: string): Node[] {
  const root: ElementNode = { kind: 'el', name: '#root', attrs: [], children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];
  const lower = html.toLowerCase();
  let text = '';
  const flush = () => {
    if (text) top().children.push({ kind: 'text', raw: text });
    text = '';
  };
  const popWhile = (names: string[]) => {
    while (stack.length > 1 && names.includes(top().name)) stack.pop();
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      flush();
      top().children.push({ kind: 'comment', raw: end < 0 ? html.slice(i) : html.slice(i, end + 3) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      flush();
      top().children.push({ kind: 'comment', raw: end < 0 ? html.slice(i) : html.slice(i, end + 1) });
      i = end < 0 ? n : end + 1;
      continue;
    }
    const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 80));
    if (!head) {
      text += '<';
      i += 1;
      continue;
    }
    let end = -1;
    let quote = '';
    const limit = Math.min(n, i + MAX_TAG);
    for (let j = i + head[0].length; j < limit; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        end = j;
        break;
      }
    }
    if (end < 0) {
      text += '<';
      i += 1;
      continue;
    }
    const name = head[2].toLowerCase();
    flush();
    if (head[1] === '/') {
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k -= 1;
      if (k > 0) stack.length = k;
      i = end + 1;
      continue;
    }
    let attrSource = html.slice(i + head[0].length, end);
    const selfClosing = /\/\s*$/.test(attrSource);
    if (selfClosing) attrSource = attrSource.replace(/\/\s*$/, '');
    if (CLOSES_P.has(name) && top().name === 'p') stack.pop();
    if (name === 'li') popWhile(['li']);
    if (name === 'td' || name === 'th') popWhile(['td', 'th']);
    if (name === 'tr') popWhile(['td', 'th', 'tr']);
    if (name === 'thead' || name === 'tbody' || name === 'tfoot') popWhile(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']);
    const el: ElementNode = { kind: 'el', name, attrs: parseAttrs(attrSource), children: [] };
    top().children.push(el);
    i = end + 1;
    if (VOID.has(name) || selfClosing) continue;
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const stop = close < 0 ? n : close;
      if (stop > i) el.children.push({ kind: 'text', raw: html.slice(i, stop) });
      const gt = close < 0 ? -1 : html.indexOf('>', close);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    stack.push(el);
  }
  flush();
  return root.children;
}

const attrOf = (el: ElementNode, name: string): string | null | undefined => el.attrs.find((a) => a.name === name)?.value;
const classesOf = (el: ElementNode): string[] => String(attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean);
const hasClass = (el: ElementNode, cls: string) => classesOf(el).includes(cls);
/** Made by this layout already: passed on as it is (the styler is idempotent). */
const isOurs = (el: ElementNode) => classesOf(el).some((c) => c.startsWith('x-'));
const isBlank = (node: Node) => (node.kind === 'text' && !node.raw.trim()) || node.kind === 'comment';
const elements = (nodes: Node[]) => nodes.filter((c): c is ElementNode => c.kind === 'el');

function serializeAttrs(attrs: Attr[]): string {
  return attrs.map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`)).join('');
}

function serialize(nodes: Node[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind !== 'el') {
      out += node.raw;
      continue;
    }
    out += `<${node.name}${serializeAttrs(node.attrs)}>`;
    if (VOID.has(node.name)) continue;
    out += `${serialize(node.children)}</${node.name}>`;
  }
  return out;
}

/** The visible text of a subtree, as written (entities kept). */
function rawText(nodes: Node[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.raw : n.kind === 'el' ? rawText(n.children) : '')).join('');
}

/**
 * A start tag from the author's attributes plus ours. Theirs are kept: class
 * names are joined; our style goes first so theirs wins (and is not prepended
 * again when it already starts with ours); any other attribute of theirs is
 * never overwritten unless `force` names it.
 */
function startTag(name: string, attrs: Attr[], add: Record<string, string | undefined>, force: string[] = [], drop: string[] = []): string {
  const list = attrs.filter((a) => !drop.includes(a.name)).map((a) => ({ ...a }));
  for (const [key, value] of Object.entries(add)) {
    if (value === undefined || value === '') continue;
    const at = list.findIndex((a) => a.name === key);
    if (key === 'class') {
      if (at < 0) list.push({ name: 'class', value });
      else {
        const have = String(list[at].value ?? '').split(/\s+/).filter(Boolean);
        list[at].value = [...have, ...value.split(/\s+/).filter((c) => c && !have.includes(c))].join(' ');
      }
    } else if (key === 'style') {
      const ours = value.replace(/;+\s*$/, '');
      if (at < 0) list.push({ name: 'style', value });
      else {
        const theirs = String(list[at].value ?? '').trim();
        list[at].value = theirs.startsWith(ours) ? theirs : theirs ? `${ours};${theirs}` : value;
      }
    } else if (at < 0) {
      list.push({ name: key, value });
    } else if (force.includes(key)) {
      list[at].value = value;
    }
  }
  return `<${name}${serializeAttrs(list)}>`;
}

/** An author's own background (inline or `bgcolor`): their text colour is kept, dark mode or not. */
function ownBackground(el: ElementNode): boolean {
  if (attrOf(el, 'bgcolor')) return true;
  return /(^|;)\s*background(-color|-image)?\s*:/i.test(String(attrOf(el, 'style') ?? ''));
}

/* ──────────────────────────────────────────────────────────── the styler ── */

interface StyleContext {
  p: EmailPalette;
  /** The palette of a subtree with an author's background: always the light one. */
  pin: EmailPalette;
  t: TypeScale;
  font: string;
  codeFont: string;
  rtl: boolean;
  start: 'left' | 'right';
  end: 'left' | 'right';
  /** Inside an author's background: no dark classes, light colours. */
  pinned: boolean;
  /** Inside a callout, a quote or a bubble: its ink, its class, its size. */
  box: { ink: string; cls: string; size: [number, number] } | null;
}

const MSO = 'mso-line-height-rule:exactly;';
const PRESENTATION = 'role="presentation" border="0" cellpadding="0" cellspacing="0"';

/** A dark-mode class, or the plain marker inside an author's background. */
const dk = (ctx: StyleContext, cls: string) => (ctx.pinned ? 'x-pin' : cls);
const pal = (ctx: StyleContext) => (ctx.pinned ? ctx.pin : ctx.p);

/** The logos' bubble: round corners, one sharp one at the bottom, on the reading end (or start) side. */
function bubbleRadius(r: number, sharp: number, ctx: StyleContext, side: 'end' | 'start'): string {
  const sharpRight = (side === 'end') !== ctx.rtl;
  return sharpRight ? `${r}px ${r}px ${sharp}px ${r}px` : `${r}px ${r}px ${r}px ${sharp}px`;
}

/** Vertical rhythm: each block owns the space under it, and the last one none (the card's padding ends it). */
function block(inner: string, top: number, bottom: number, last: boolean): string {
  return `<table ${PRESENTATION} width="100%" class="x-b" style="width:100%;border-collapse:collapse;"><tr><td style="padding:${top}px 0 ${last ? 0 : bottom}px;">${inner}</td></tr></table>`;
}

const URLISH = /^\s*(https?:\/\/|www\.)\S+\s*$/i;
/** Short left-to-right runs (a phone, a card's last digits) never break; long ones (an address) break anywhere. */
const SHORT_LTR = 24;

function ltrRun(el: ElementNode): string {
  const length = decodeEntities(rawText(el.children)).trim().length;
  return length <= SHORT_LTR ? 'unicode-bidi:isolate;white-space:nowrap;' : 'unicode-bidi:isolate;overflow-wrap:anywhere;word-break:break-all;';
}

function renderNodes(nodes: Node[], ctx: StyleContext, topLevel = false): string {
  let lastIndex = -1;
  if (topLevel) {
    for (let k = nodes.length - 1; k >= 0; k -= 1) {
      if (!isBlank(nodes[k])) {
        lastIndex = k;
        break;
      }
    }
  }
  let out = '';
  nodes.forEach((node, k) => {
    if (node.kind !== 'el') {
      out += node.raw;
      return;
    }
    out += renderElement(node, ctx, topLevel && k === lastIndex);
  });
  return out;
}

/** A box's children: its paragraphs tight, the last one with no space under it. */
function renderBoxChildren(nodes: Node[], ctx: StyleContext): string {
  const ps = elements(nodes).filter((e) => e.name === 'p');
  const lastP = ps[ps.length - 1];
  let out = '';
  for (const node of nodes) {
    if (node.kind !== 'el') {
      out += node.raw;
      continue;
    }
    if (node.name === 'p' && !isOurs(node)) {
      out += paragraph(node, ctx, node === lastP, 'box');
      continue;
    }
    out += renderElement(node, ctx, false);
  }
  return out;
}

function renderElement(el: ElementNode, parent: StyleContext, last: boolean): string {
  if (isOurs(el)) return serialize([el]);
  const ctx: StyleContext = ownBackground(el) && !parent.pinned ? { ...parent, pinned: true } : parent;
  const pinnedHere = ctx.pinned && !parent.pinned;
  const cls = classesOf(el);

  switch (el.name) {
    case 'h1': {
      const p = pal(ctx);
      const [size, lh] = ctx.t.h1;
      const style = `margin:0 0 ${last ? 0 : 14}px;font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;font-weight:700;letter-spacing:${ctx.t.h1Ls};color:${p.ink};text-align:${ctx.start};${MSO}`;
      return `${startTag('h1', el.attrs, { class: `${dk(ctx, 'x-ink')} x-h1`, style })}${renderNodes(el.children, ctx)}</h1>`;
    }
    case 'p': {
      if (cls.includes('action') && !ctx.box) {
        const kids = el.children.filter((c) => !isBlank(c));
        if (kids.length === 1 && kids[0].kind === 'el' && kids[0].name === 'a') return button(el, kids[0], ctx, last);
      }
      return paragraph(el, ctx, last, ctx.box ? 'box' : cls.includes('note') ? 'note' : 'body');
    }
    case 'a':
      return link(el, ctx);
    case 'strong':
    case 'b':
      return `${startTag(el.name, el.attrs, { style: 'font-weight:700' })}${renderNodes(el.children, ctx)}</${el.name}>`;
    case 'hr': {
      const p = pal(ctx);
      return block(
        `<table ${PRESENTATION} width="100%" style="width:100%;"><tr><td class="${dk(ctx, 'x-line')}" height="1" style="height:1px;font-size:1px;line-height:1px;border-top:1px solid ${p.line};">&nbsp;</td></tr></table>`,
        8, 24, last,
      );
    }
    case 'blockquote':
      return quote(el, ctx, last);
    case 'table':
      if (cls.includes('details')) return details(el, ctx, last);
      break;
    case 'div':
      if (cls.includes('code')) return codeBox(el, ctx, last);
      if (cls.includes('warning')) return callout(el, ctx, last, 'warning');
      if (cls.includes('notice')) return callout(el, ctx, last, 'notice');
      if (cls.includes('transcript')) return transcript(el, ctx, last);
      break;
    case 'span':
    case 'bdi':
      if (attrOf(el, 'dir') === 'ltr') {
        return `${startTag(el.name, el.attrs, { class: 'x-ltr', style: ltrRun(el) })}${renderNodes(el.children, ctx)}</${el.name}>`;
      }
      break;
    case 'img':
      return startTag('img', el.attrs, { style: 'max-width:100%;height:auto;border:0;outline:none;text-decoration:none' });
    case 'pre':
      return `${startTag('pre', el.attrs, { style: 'white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word' })}${renderNodes(el.children, ctx)}</pre>`;
    default:
      break;
  }
  // Anything else passes through as it is, its children styled. An author's
  // background keeps its own (light-scheme) text colour, unless they set one;
  // an author's colour alone gets the dark class, which a dark card needs.
  const ownColor = /(^|;)\s*color\s*:/i.test(String(attrOf(el, 'style') ?? ''));
  const add = pinnedHere
    ? { style: `color:${ctx.pin.ink}` }
    : ownColor && !ctx.pinned ? { class: ctx.box ? ctx.box.cls : 'x-ink' } : {};
  if (VOID.has(el.name)) return startTag(el.name, el.attrs, add);
  return `${startTag(el.name, el.attrs, add)}${renderNodes(el.children, ctx)}</${el.name}>`;
}

function paragraph(el: ElementNode, ctx: StyleContext, last: boolean, kind: 'body' | 'note' | 'box'): string {
  const p = pal(ctx);
  if (kind === 'box' && ctx.box) {
    const [size, lh] = ctx.box.size;
    const style = `margin:0 0 ${last ? 0 : 8}px;font-size:${size}px;line-height:${lh}px;color:${ctx.box.ink};${MSO}`;
    return `${startTag('p', el.attrs, { class: dk(ctx, ctx.box.cls), style })}${renderNodes(el.children, ctx)}</p>`;
  }
  const [size, lh] = kind === 'note' ? ctx.t.note : ctx.t.body;
  const color = kind === 'note' ? p.muted : p.ink;
  const margin = last ? 0 : kind === 'note' ? 12 : 16;
  const style = `margin:0 0 ${margin}px;font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;color:${color};text-align:${ctx.start};${MSO}`;
  return `${startTag('p', el.attrs, { class: dk(ctx, kind === 'note' ? 'x-muted' : 'x-ink'), style })}${renderNodes(el.children, ctx)}</p>`;
}

function link(el: ElementNode, ctx: StyleContext): string {
  const p = pal(ctx);
  const urlText = URLISH.test(decodeEntities(rawText(el.children)));
  const color = ctx.box ? ctx.box.ink : p.link;
  const cls = ctx.box ? ctx.box.cls : 'x-link';
  const style = `color:${color};text-decoration:underline;text-underline-offset:2px;${urlText ? 'word-break:break-all;' : ''}`;
  return `${startTag('a', el.attrs, { class: dk(ctx, cls), style, ...(urlText ? { dir: 'ltr' } : {}) })}${renderNodes(el.children, ctx)}</a>`;
}

function button(pEl: ElementNode, aEl: ElementNode, ctx: StyleContext, last: boolean): string {
  const p = pal(ctx);
  const r = bubbleRadius(12, 3, ctx, 'end');
  const [size, lh] = ctx.t.btn;
  const aStyle = `display:inline-block;padding:15px 30px;font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;font-weight:700;color:${p.onAccent};text-decoration:none;border-radius:${r};${MSO}`;
  const label = renderNodes(aEl.children, ctx);
  return block(
    `${startTag('table', pEl.attrs, { role: 'presentation', border: '0', cellpadding: '0', cellspacing: '0', align: ctx.start, class: 'x-btnt', style: 'border-collapse:separate;' })}` +
      `<tr><td class="${dk(ctx, 'x-btn')}" align="center" bgcolor="${p.accent}" style="background-color:${p.accent};border-radius:${r};mso-padding-alt:15px 30px;">` +
      `${startTag('a', aEl.attrs, { class: dk(ctx, 'x-btna'), style: aStyle })}${label}</a>` +
      '</td></tr></table>',
    10, 26, last,
  );
}

function codeBox(el: ElementNode, ctx: StyleContext, last: boolean): string {
  const p = pal(ctx);
  const r = bubbleRadius(16, 4, ctx, 'end');
  const length = decodeEntities(rawText(el.children)).replace(/\s+/g, '').length;
  // Wide tracking reads well for six digits; a longer code gets less, and
  // breaks rather than widen a phone even with every style stripped.
  const [size, track] = length <= 6 ? [34, 10] : length <= 8 ? [30, 6] : [26, 3];
  const style =
    `background-color:${p.codeBg};border:1px solid ${p.codeLine};border-radius:${r};padding:20px 16px 20px ${16 + track}px;` +
    `font-family:${ctx.codeFont};font-size:${size}px;line-height:44px;font-weight:700;letter-spacing:${track}px;color:${p.codeInk};` +
    `text-align:center;direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;word-break:break-all;${MSO}`;
  return block(
    `<table ${PRESENTATION} width="100%" style="width:100%;border-collapse:separate;"><tr>` +
      `${startTag('td', el.attrs, { class: dk(ctx, 'x-code'), dir: 'ltr', align: 'center', bgcolor: p.codeBg, style }, ['dir'])}${renderNodes(el.children, ctx).trim()}</td>` +
      '</tr></table>',
    8, 24, last,
  );
}

function details(el: ElementNode, ctx: StyleContext, last: boolean): string {
  const p = pal(ctx);
  const rows: ElementNode[] = [];
  for (const child of elements(el.children)) {
    if (child.name === 'tr') rows.push(child);
    else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') rows.push(...elements(child.children).filter((r) => r.name === 'tr'));
  }
  const [size, lh] = ctx.t.key;
  const body = rows.map((row, k) => {
    const lastRow = k === rows.length - 1;
    const border = lastRow ? '' : `border-bottom:1px solid ${p.line};`;
    const lineCls = lastRow ? '' : ` ${dk(ctx, 'x-line')}`;
    const cells = elements(row.children).filter((c) => c.name === 'th' || c.name === 'td');
    const out = cells.map((cell, ci) => {
      const label = cell.name === 'th';
      const ltr = attrOf(cell, 'dir') === 'ltr';
      const gap = ci > 0 ? `padding-${ctx.start}:14px;` : '';
      // A label keeps its words whole (the card lets a long word break
      // anywhere, which would let a label be squeezed to a letter a line);
      // a long value breaks anywhere, a short one only between words.
      if (label) {
        const style = `padding:13px 0;${gap}${border}font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;font-weight:400;color:${p.muted};text-align:${ctx.start};vertical-align:top;word-break:normal;overflow-wrap:normal;${MSO}`;
        return `${startTag('th', cell.attrs, { class: `${dk(ctx, 'x-muted')}${lineCls}`, scope: 'row', align: ctx.start, valign: 'top', style })}${renderNodes(cell.children, ctx)}</th>`;
      }
      const long = decodeEntities(rawText(cell.children)).trim().length > SHORT_LTR;
      const wrap = long ? 'overflow-wrap:anywhere;word-break:break-word;' : 'word-break:normal;overflow-wrap:normal;';
      const style =
        `padding:13px 0;${gap}${border}font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;font-weight:700;color:${p.ink};` +
        `text-align:${ctx.end};vertical-align:top;${wrap}${ltr ? ltrRun(cell) : ''}${MSO}`;
      return `${startTag('td', cell.attrs, { class: `${dk(ctx, 'x-ink')}${lineCls}`, align: ctx.end, valign: 'top', style })}${renderNodes(cell.children, ctx)}</td>`;
    }).join('');
    return `${startTag('tr', row.attrs, {})}${out}</tr>`;
  }).join('');
  const r = bubbleRadius(14, 4, ctx, 'end');
  // The inner table is real data (th scope="row"), so it is not presentation.
  return block(
    `<table ${PRESENTATION} width="100%" class="${dk(ctx, 'x-panel')}" bgcolor="${p.panel}" style="width:100%;background-color:${p.panel};border-radius:${r};border-collapse:separate;"><tr><td style="padding:4px 18px;">` +
      `${startTag('table', el.attrs, { class: 'x-details', width: '100%', border: '0', cellpadding: '0', cellspacing: '0', style: 'width:100%;border-collapse:collapse;' })}${body}</table>` +
      '</td></tr></table>',
    8, 24, last,
  );
}

function callout(el: ElementNode, ctx: StyleContext, last: boolean, kind: 'warning' | 'notice'): string {
  const p = pal(ctx);
  const bg = kind === 'warning' ? p.warningBg : p.noticeBg;
  const ink = kind === 'warning' ? p.warningInk : p.noticeInk;
  const edge = kind === 'warning' ? p.warningEdge : p.noticeEdge;
  const cls = kind === 'warning' ? 'x-warn' : 'x-notice';
  const r = bubbleRadius(12, 3, ctx, 'end');
  const [size, lh] = ctx.t.callout;
  const inner: StyleContext = { ...ctx, box: { ink, cls, size: ctx.t.callout } };
  const style =
    `background-color:${bg};border-${ctx.start}:4px solid ${edge};border-radius:${r};padding:15px 18px;` +
    `font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;color:${ink};text-align:${ctx.start};overflow-wrap:anywhere;word-break:break-word;${MSO}`;
  return block(
    `<table ${PRESENTATION} width="100%" style="width:100%;border-collapse:separate;"><tr>` +
      `${startTag('td', el.attrs, { class: dk(ctx, cls), bgcolor: bg, style })}${renderBoxChildren(el.children, inner)}</td>` +
      '</tr></table>',
    6, 22, last,
  );
}

function quote(el: ElementNode, ctx: StyleContext, last: boolean): string {
  const p = pal(ctx);
  const r = bubbleRadius(18, 4, ctx, 'start');
  const [size, lh] = ctx.t.body;
  const inner: StyleContext = { ...ctx, box: { ink: p.quoteInk, cls: 'x-quote', size: ctx.t.body } };
  const style =
    `background-color:${p.quoteBg};border-radius:${r};padding:16px 20px;font-family:${ctx.font};font-size:${size}px;line-height:${lh}px;` +
    `color:${p.quoteInk};text-align:${ctx.start};overflow-wrap:anywhere;word-break:break-word;${MSO}`;
  return block(
    `<table ${PRESENTATION} width="100%" style="width:100%;border-collapse:separate;"><tr>` +
      `${startTag('td', el.attrs, { class: dk(ctx, 'x-quote'), bgcolor: p.quoteBg, style }, [], ['cite'])}${renderBoxChildren(el.children, inner)}</td>` +
      '</tr></table>',
    6, 24, last,
  );
}

/**
 * One row per message: the reader's own (the visitor's) at the end side in
 * the brand's colour, the team's at the start side in grey, as in the
 * widget. The font is the card's, inherited: a long transcript repeats as
 * little as it can (Gmail clips a mail over about 102 KB).
 */
function transcript(el: ElementNode, ctx: StyleContext, last: boolean): string {
  const p = pal(ctx);
  const [metaSize, metaLh] = ctx.t.meta;
  const [size, lh] = ctx.t.bubble;
  const rows: string[] = [];
  for (const msg of elements(el.children)) {
    if (!hasClass(msg, 'msg')) continue;
    const visitor = hasClass(msg, 'msg-visitor');
    const side = visitor ? ctx.end : ctx.start;
    const parts = elements(msg.children);
    const meta = parts.find((c) => hasClass(c, 'meta'));
    const bubble = parts.find((c) => hasClass(c, 'bubble'));
    const bg = visitor ? p.bubbleVisitor : p.bubbleAgent;
    const ink = visitor ? p.bubbleVisitorInk : p.bubbleAgentInk;
    const cls = visitor ? 'x-bv' : 'x-ba';
    const inner: StyleContext = { ...ctx, box: { ink, cls, size: ctx.t.bubble } };
    const r = bubbleRadius(18, 4, ctx, visitor ? 'end' : 'start');
    const metaStyle = `padding:0 4px 5px;font-size:${metaSize}px;line-height:${metaLh}px;color:${p.muted};text-align:${side};${MSO}`;
    const metaHtml = meta
      ? `<tr>${startTag('td', meta.attrs, { class: dk(ctx, 'x-muted'), align: side, style: metaStyle }, [], ['class'])}${renderNodes(meta.children, ctx).trim()}</td></tr>`
      : '';
    const content = bubble ? bubble.children : meta ? [] : msg.children;
    const bubbleStyle = `background-color:${bg};border-radius:${r};padding:11px 16px;font-size:${size}px;line-height:${lh}px;color:${ink};text-align:${ctx.start};overflow-wrap:anywhere;word-break:break-word;${MSO}`;
    const bubbleHtml = content.length
      ? `<tr>${startTag('td', bubble?.attrs ?? [], { class: dk(ctx, cls), bgcolor: bg, style: bubbleStyle }, [], ['class'])}${renderBoxChildren(content, inner).trim()}</td></tr>`
      : '';
    rows.push(
      `<tr><td align="${side}" style="padding:0 0 14px;text-align:${side};">` +
        `<table ${PRESENTATION} align="${side}" style="border-collapse:separate;max-width:86%;">${metaHtml}${bubbleHtml}</table>` +
        '</td></tr>',
    );
  }
  return block(
    `${startTag('table', el.attrs, { role: 'presentation', width: '100%', border: '0', cellpadding: '0', cellspacing: '0', class: 'x-transcript', style: 'width:100%;border-collapse:collapse;' })}${rows.join('')}</table>`,
    8, 10, last,
  );
}

export interface StyleContentOptions {
  locale: string;
  edition: Edition;
  scheme?: 'auto' | 'light' | 'dark';
}

function contextFor(opts: StyleContentOptions): StyleContext {
  const palettes = EMAIL_PALETTES[opts.edition] ?? EMAIL_PALETTES.international;
  const rtl = directionOf(opts.locale) === 'rtl';
  const fa = baseLocale(opts.locale) === 'fa';
  const fonts = fontsFor(opts.locale);
  return {
    p: opts.scheme === 'dark' ? palettes.dark : palettes.light,
    pin: palettes.light,
    t: fa ? PERSIAN_TYPE : LATIN_TYPE,
    font: fonts.stack,
    codeFont: fa ? LATIN_UI : fonts.stack,
    rtl,
    start: rtl ? 'right' : 'left',
    end: rtl ? 'left' : 'right',
    pinned: false,
    box: null,
  };
}

/**
 * The content vocabulary as inline-styled, table-based markup (the card's
 * inside). A preheader is left where it is: renderEmailDocument takes it out
 * first (extractPreheader).
 */
export function styleContent(contentHtml: string, opts: StyleContentOptions): string {
  return renderNodes(parseHtml(String(contentHtml ?? '')), contextFor(opts), true);
}

/* ───────────────────────────────────────────────────────────── preheader ── */

const isPreheader = (el: ElementNode) => el.name === 'div' && (hasClass(el, 'preheader') || attrOf(el, 'data-preheader') !== undefined);

/**
 * The first top-level `div` whose class list holds `preheader` (or that
 * carries `data-preheader`), taken out of the content: its text goes to the
 * hidden slot at the top of the body, where inboxes read the preview.
 */
export function extractPreheader(contentHtml: string): { preheader: string; rest: string } {
  const nodes = parseHtml(String(contentHtml ?? ''));
  const at = nodes.findIndex((n) => n.kind === 'el' && isPreheader(n));
  if (at < 0) return { preheader: '', rest: String(contentHtml ?? '') };
  const el = nodes[at] as ElementNode;
  const preheader = rawText(el.children).replace(/\s+/g, ' ').trim();
  return { preheader, rest: serialize([...nodes.slice(0, at), ...nodes.slice(at + 1)]) };
}

/** Zero-width filler after the preview text, so an inbox does not run on into the mail's body. */
const PREHEADER_FILLER = '&#847;&zwnj;&nbsp;'.repeat(24);

function preheaderSlot(text: string): string {
  if (!text) return '';
  return `<div data-preheader style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:transparent;">${text}${PREHEADER_FILLER}</div>`;
}

/* ──────────────────────────────────────────────────────────── text parts ── */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const TEXT_BLOCKS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'ul', 'ol',
  'section', 'article', 'header', 'footer', 'pre', 'hr',
]);
const TEXT_SKIP = new Set(['head', 'style', 'script', 'title', 'template']);

/** A link as its words and its target: "Reset password (https://…)", or the target alone when they are the same. */
function linkText(el: ElementNode, label: string): string {
  const href = decodeEntities(String(attrOf(el, 'href') ?? '')).trim();
  if (!href || href.startsWith('#') || /^(javascript|data):/i.test(href)) return label;
  const shown = href.replace(/^mailto:/i, '');
  const words = label.replace(/\s+/g, ' ').trim();
  return !words || words === href || words === shown ? shown : `${words} (${shown})`;
}

function textOf(nodes: Node[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'comment') continue;
    if (node.kind === 'text') {
      out += decodeEntities(node.raw.replace(/\s+/g, ' '));
      continue;
    }
    const name = node.name;
    if (TEXT_SKIP.has(name) || isPreheader(node)) continue;
    if (name === 'br') out += '\n';
    else if (name === 'img') out += decodeEntities(String(attrOf(node, 'alt') ?? ''));
    else if (name === 'a') out += linkText(node, textOf(node.children));
    else if (name === 'th') out += `${textOf(node.children).trim()}: `;
    else if (name === 'td') out += `${textOf(node.children).trim()} `;
    else if (name === 'tr') out += `\n${textOf(node.children).trim()}`;
    else if (name === 'li') out += `\n- ${textOf(node.children).trim()}`;
    else if (name === 'div' && (hasClass(node, 'meta') || hasClass(node, 'bubble'))) out += `\n${textOf(node.children).trim()}`;
    else if (TEXT_BLOCKS.has(name)) out += `\n\n${textOf(node.children)}\n\n`;
    else out += textOf(node.children);
  }
  return out;
}

function tidyText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text part of a mail whose row has none: the CONTENT as text (never the
 * layout around it, never the preheader), images by their alt text, links
 * with their targets, a details row as "Label: value".
 */
export function contentToText(contentHtml: string): string {
  return tidyText(textOf(parseHtml(String(contentHtml ?? ''))));
}

/* ─────────────────────────────────────────────────────────────── document ── */

/** A whole HTML document (a Super Admin's own full design, or an old row): sent as it is. */
export function isWholeDocument(html: string): boolean {
  return /<html[\s>]/i.test(String(html ?? ''));
}

/** The inside of a whole document's `<body>` (a caller's fallback written as one), for the layout to wear. */
export function documentBody(html: string): string {
  const s = String(html ?? '');
  const open = /<body\b[^>]*>/i.exec(s);
  if (!open) {
    return serialize(parseHtml(s).flatMap((n) => (n.kind === 'el' && n.name === 'html' ? n.children : [n])).filter((n) => !(n.kind === 'el' && n.name === 'head') && n.kind !== 'comment'));
  }
  const from = open.index + open[0].length;
  const close = s.toLowerCase().lastIndexOf('</body');
  return s.slice(from, close > from ? close : s.length);
}

/** Same optical weight for any logo shape: a constant area (about 5,800 px²), at most 172 × 52. */
function logoBox(width: number, height: number): { w: number; h: number } {
  const ratio = width > 0 && height > 0 ? width / height : 3;
  let w = Math.min(Math.round(Math.sqrt(5800 * ratio)), 172);
  let h = Math.round(w / ratio);
  if (h > 52) {
    h = 52;
    w = Math.round(52 * ratio);
  }
  return { w, h };
}

const escapeText = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const hostOf = (url: string) => String(url || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

/** The dark-mode colours, by class. Only the classes a mail uses are written out. */
function darkRules(d: EmailPalette): Record<string, { bg?: string; grad?: string; color?: string; border?: string }> {
  return {
    'x-canvas': { bg: d.canvas },
    'x-band': { bg: d.band, grad: d.band },
    'x-card': { bg: d.card },
    'x-panel': { bg: d.panel },
    'x-ink': { color: d.ink },
    'x-muted': { color: d.muted },
    'x-foot': { color: d.footInk },
    'x-link': { color: d.link },
    'x-line': { border: d.line },
    'x-btn': { bg: d.accent },
    'x-btna': { color: d.onAccent },
    'x-code': { bg: d.codeBg, color: d.codeInk, border: d.codeLine },
    'x-warn': { bg: d.warningBg, color: d.warningInk, border: d.warningEdge },
    'x-notice': { bg: d.noticeBg, color: d.noticeInk, border: d.noticeEdge },
    'x-quote': { bg: d.quoteBg, color: d.quoteInk },
    'x-bv': { bg: d.bubbleVisitor, color: d.bubbleVisitorInk },
    'x-ba': { bg: d.bubbleAgent, color: d.bubbleAgentInk },
    'x-bar': { bg: d.highlight, grad: d.highlight },
  };
}

/**
 * Apple Mail, iOS Mail and the Outlook apps follow `prefers-color-scheme`;
 * Outlook.com marks what it recolours with `data-ogsc` (text) and
 * `data-ogsb` (backgrounds), so the same colours go under those too. Gmail
 * reads neither and inverts on its own: the band and the dash also carry a
 * same-colour gradient, which it leaves alone.
 */
function darkCss(d: EmailPalette, used: Set<string>): string {
  const media: string[] = [];
  const ogsc: string[] = [];
  const ogsb: string[] = [];
  for (const [cls, rule] of Object.entries(darkRules(d))) {
    if (!used.has(cls)) continue;
    const color: string[] = [];
    const bg: string[] = [];
    if (rule.color) color.push(`color:${rule.color}!important`);
    if (rule.border) color.push(`border-color:${rule.border}!important`);
    if (rule.bg) bg.push(`background-color:${rule.bg}!important`);
    if (rule.grad) bg.push(`background-image:linear-gradient(${rule.grad},${rule.grad})!important`);
    media.push(`.${cls}{${[...bg, ...color].join(';')}}`);
    if (color.length) ogsc.push(`[data-ogsc] .${cls}{${color.join(';')}}`);
    if (bg.length) ogsb.push(`[data-ogsb] .${cls}{${bg.join(';')}}`);
  }
  return `@media (prefers-color-scheme:dark){${media.join('')}}\n${ogsc.join('')}\n${ogsb.join('')}`;
}

/**
 * The caller's closing line (the notification mails' unsubscribe line) inside
 * the designed footer: its words and its links are kept, the footer gives it
 * its look (its own inline style was written for a mail without one).
 */
function footerLine(html: string, ctx: StyleContext, color: string): string {
  const walk = (nodes: Node[]): string => nodes.map((node) => {
    if (node.kind === 'text') return node.raw;
    if (node.kind === 'comment') return '';
    if (node.name === 'br') return '<br>';
    if (node.name === 'a') {
      const href = attrOf(node, 'href');
      const target = href ? ` href="${href.replace(/"/g, '&quot;')}"` : '';
      return `<a${target} class="${dk(ctx, 'x-foot')}" style="color:${color};text-decoration:underline;text-underline-offset:2px;">${walk(node.children)}</a>`;
    }
    if (node.name === 'strong' || node.name === 'b') return `<strong style="font-weight:700;">${walk(node.children)}</strong>`;
    if (TEXT_SKIP.has(node.name)) return '';
    return walk(node.children);
  }).join('');
  return walk(parseHtml(html)).trim();
}

export interface EmailDocumentInput {
  brand: EmailBrand;
  /** The mail's language (the template row's): direction, type and the layout's own words. */
  locale: string;
  /** The subject (the document's title). */
  title: string;
  /** The filled content, in the vocabulary above. */
  contentHtml: string;
  category: EmailCategory;
  /** The caller's closing line (EmailRequest.footer): in the footer, in place of the why line. */
  footer?: { html: string; text: string } | null;
  /** `auto` (sending: light, dark by the client's own setting), or one scheme forced (a preview). */
  scheme?: 'auto' | 'light' | 'dark';
}

/** The whole HTML document of a platform mail. */
export function renderEmailDocument(input: EmailDocumentInput): string {
  const { brand } = input;
  const scheme = input.scheme === 'dark' || input.scheme === 'light' ? input.scheme : 'auto';
  const locale = baseLocale(input.locale);
  const dir = directionOf(locale);
  const ctx = contextFor({ locale, edition: brand.edition, scheme });
  const { p, t, font, start, rtl } = ctx;
  const palettes = EMAIL_PALETTES[brand.edition] ?? EMAIL_PALETTES.international;
  const fonts = fontsFor(locale);
  const lang = escapeText(locale);
  const title = escapeText(input.title.replace(/[\r\n]+/g, ' '));

  const { preheader, rest } = extractPreheader(input.contentHtml);
  const body = styleContent(rest, { locale, edition: brand.edition, scheme });

  // The band: the logo for dark backgrounds, or the light one on a paper plate
  // when the brand has no dark variant (an ink logo straight on the band
  // would vanish), or the name in text when there is no logo at all.
  const logo = brand.logo;
  const name = escapeText(brand.name);
  let mark: string;
  if (logo && logo.light) {
    const { w, h } = logoBox(logo.width, logo.height);
    const plate = !logo.dark || logo.dark === logo.light;
    const img =
      `<img class="x-logo" src="${escapeText(plate ? logo.light : logo.dark)}" width="${w}" height="${h}" alt="${name}" ` +
      `style="display:block;width:${w}px;height:${h}px;max-width:100%;border:0;outline:none;text-decoration:none;font-family:${font};font-size:20px;line-height:${h}px;font-weight:700;color:${plate ? palettes.light.ink : p.onBand};">`;
    mark = plate
      ? `<table ${PRESENTATION} align="${start}" style="border-collapse:separate;"><tr><td class="x-plate" bgcolor="${palettes.light.card}" style="background-color:${palettes.light.card};background-image:linear-gradient(${palettes.light.card},${palettes.light.card});border-radius:10px;padding:6px 10px;">${img}</td></tr></table>`
      : img;
  } else {
    mark = `<span style="font-family:${font};font-size:22px;line-height:30px;font-weight:700;color:${p.onBand};">${name}</span>`;
  }
  if (brand.siteUrl) mark = `<a href="${escapeText(brand.siteUrl)}" style="display:inline-block;text-decoration:none;">${mark}</a>`;

  // The footer: why the mail came (or the caller's own closing line), the
  // brand with its panel and support addresses, then the legal line. Plain
  // spaces around the dots: the line wraps on a narrow screen.
  const footInk = p.footInk;
  const note = input.footer?.html ? footerLine(input.footer.html, ctx, footInk) : escapeText(whyLine(input.category, locale, brand.name));
  const footLink = (href: string, text: string) =>
    `<a href="${escapeText(href)}" class="x-foot" dir="ltr" style="color:${footInk};text-decoration:underline;text-underline-offset:2px;unicode-bidi:isolate;white-space:nowrap;">${escapeText(text)}</a>`;
  const dot = `<span class="x-foot" style="color:${footInk};">${rtl ? '&rlm;·&rlm;' : '·'}</span>`;
  const links = [
    `<strong class="x-ink" style="font-weight:700;color:${p.ink};">${name}</strong>`,
    brand.appUrl ? footLink(brand.appUrl, hostOf(brand.appUrl)) : '',
    brand.supportEmail ? footLink(`mailto:${brand.supportEmail}`, brand.supportEmail) : '',
  ].filter(Boolean).join(` ${dot} `);
  const footRow = (inner: string, pad: string, [size, lh]: [number, number]) =>
    `<tr><td align="center" class="x-foot" style="padding:${pad};font-family:${font};font-size:${size}px;line-height:${lh}px;color:${footInk};text-align:center;${MSO}">${inner}</td></tr>`;

  const cardR = 22;
  // The card is a speech bubble too: its corner on the reading end is the tail.
  const cardBottom = rtl ? `0 0 ${cardR}px 8px` : `0 0 8px ${cardR}px`;
  const bandStyle = `background-color:${p.band};background-image:linear-gradient(${p.band},${p.band});`;
  const ghostOpen = '<!--[if mso]><table role="presentation" align="center" width="600" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->';
  const ghostClose = '<!--[if mso]></td></tr></table><![endif]-->';
  // Separate borders: a collapsed table draws a cell's border square around its round corners.
  const column = `<table ${PRESENTATION} align="center" width="100%" dir="${dir}" style="width:100%;max-width:600px;margin:0 auto;border-collapse:separate;border-spacing:0;">`;
  const bar = `<table ${PRESENTATION} align="${start}" style="border-collapse:separate;"><tr><td class="x-bar" width="36" height="4" bgcolor="${p.highlight}" style="width:36px;height:4px;font-size:1px;line-height:4px;background-color:${p.highlight};background-image:linear-gradient(${p.highlight},${p.highlight});border-radius:2px;${MSO}">&nbsp;</td></tr></table>`;

  const bodyHtml = [
    `<body class="x-canvas" dir="${dir}" bgcolor="${p.canvas}" style="margin:0;padding:0;width:100%;background-color:${p.canvas};">`,
    preheaderSlot(preheader),
    `<div role="article" aria-roledescription="email" aria-label="${title}" lang="${lang}" dir="${dir}" class="x-canvas" style="direction:${dir};text-align:${start};background-color:${p.canvas};">`,
    `<table ${PRESENTATION} width="100%" dir="${dir}" class="x-canvas" bgcolor="${p.canvas}" style="width:100%;background-color:${p.canvas};border-collapse:collapse;">`,
    `<tr><td class="x-band x-gut" align="center" bgcolor="${p.band}" style="${bandStyle}padding:0 16px;">`,
    ghostOpen, column,
    `<tr><td class="x-pad" align="${start}" style="padding:34px 32px 30px;text-align:${start};">${mark}</td></tr>`,
    `<tr><td class="x-card" height="40" bgcolor="${p.card}" style="height:40px;font-size:1px;line-height:40px;background-color:${p.card};border-radius:${cardR}px ${cardR}px 0 0;${MSO}">&nbsp;</td></tr>`,
    '</table>', ghostClose,
    '</td></tr>',
    '<tr><td class="x-gut" align="center" style="padding:0 16px;">',
    ghostOpen, column,
    `<tr><td class="x-card x-ink x-line x-pad" bgcolor="${p.card}" dir="${dir}" align="${start}" style="background-color:${p.card};border:1px solid ${p.line};border-top:0;border-radius:${cardBottom};padding:0 32px 34px;direction:${dir};text-align:${start};font-family:${font};font-size:${t.body[0]}px;line-height:${t.body[1]}px;color:${p.ink};overflow-wrap:anywhere;word-break:break-word;${MSO}">`,
    block(bar, 0, 20, false),
    body,
    '</td></tr>',
    `<tr><td style="padding:30px 20px 44px;" dir="${dir}">`,
    `<table ${PRESENTATION} width="100%" style="width:100%;border-collapse:collapse;">`,
    note ? footRow(note, '0 0 10px', t.foot) : '',
    footRow(links, '0 0 10px', t.foot),
    brand.legal ? footRow(escapeText(brand.legal), '0', t.legal) : '',
    '</table>',
    '</td></tr>',
    '</table>', ghostClose,
    '</td></tr>',
    '</table>',
    '</div>',
    '</body>',
  ].filter(Boolean).join('\n');

  const used = new Set<string>();
  for (const m of bodyHtml.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c.startsWith('x-')) used.add(c);
  const schemeMeta = scheme === 'auto' ? 'light dark' : scheme;
  const appBase = brand.appUrl.replace(/\/+$/, '');
  const faces = appBase
    ? fonts.faces.map((f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(${appBase}/widget/fonts/${f.file}) format('woff2');unicode-range:${f.range};}`).join('')
    : '';
  const narrow = `@media only screen and (max-width:620px){.x-gut{padding-left:12px!important;padding-right:12px!important;}.x-pad{padding-left:22px!important;padding-right:22px!important;}.x-h1{font-size:${t.h1[0] - 2}px!important;line-height:${t.h1[1] - 3}px!important;}.x-btnt{width:100%!important;}.x-btnt a{display:block!important;text-align:center!important;}.x-code{font-size:28px!important;}}`;

  const head = [
    '<!DOCTYPE html>',
    `<html lang="${lang}" dir="${dir}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">',
    `<meta name="color-scheme" content="${schemeMeta}">`,
    `<meta name="supported-color-schemes" content="${schemeMeta}">`,
    `<title>${title}</title>`,
    '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->',
    `<!--[if mso]><style>body,table,td,th,p,a,h1,span,strong,b,em,div,blockquote,li{font-family:${fonts.mso}!important;}</style><![endif]-->`,
    // 1: resets and the narrow-screen rules (Gmail keeps these).
    '<style>',
    'body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}',
    'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}',
    'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important;}',
    '#MessageViewBody a{color:inherit;text-decoration:none;font-size:inherit;font-family:inherit;font-weight:inherit;line-height:inherit;}',
    narrow,
    '</style>',
    // 2: the web fonts, for screens only (Outlook for Windows never sees them).
    faces ? `<style>@media screen{${faces}}</style>` : '',
    // 3: dark mode. `:root` sits here: a selector a client rejects must not take the narrow-screen rules with it.
    `<style>\n:root{color-scheme:${schemeMeta};supported-color-schemes:${schemeMeta};}\n${scheme === 'auto' ? darkCss(palettes.dark, used) : ''}\n</style>`,
    '</head>',
  ].filter(Boolean).join('\n');

  return `${head}\n${bodyHtml}\n</html>`;
}

/**
 * The text part of a laid-out mail whose row has no text of its own: the
 * content as text, then the footer's lines (why the mail came, or the
 * caller's closing line; the brand and its addresses; the legal line).
 */
export function renderEmailText(input: Omit<EmailDocumentInput, 'title' | 'scheme'>): string {
  const { brand } = input;
  const content = contentToText(input.contentHtml);
  const note = input.footer?.text?.trim() || whyLine(input.category, input.locale, brand.name);
  const links = [brand.name, brand.appUrl ? hostOf(brand.appUrl) : '', brand.supportEmail].filter(Boolean).join(' · ');
  return [content, [note, links, brand.legal].filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
}
