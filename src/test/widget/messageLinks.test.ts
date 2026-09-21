/**
 * Links inside a chat message.
 *
 * Message bodies were rendered with `escapeHtml` and nothing else, so a link
 * the assistant sent was dead text. On the live store, asking for a price got
 * back:
 *
 *   قیمت اسپیکر بلوتوثی رزونانس 2,490,000 IR … لینک محصول:
 *   https://p.webyar.ai/product/%d8%a7%d8%b3%d9%be%db%8c%da%a9%d8%b1-%d8%a8…/
 *
 * Three separate problems in one line: it was not clickable, it was
 * unreadable (a Persian slug has to travel percent-encoded, and that is what
 * got printed), and it was a single token with no space in it — a hundred
 * characters that its bubble had to try to fit.
 *
 * The functions under test are the ones the shipped runtime really uses; they
 * are reached through the same namespace the presentation contract hands to
 * every template.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Verbatim from the live conversation. */
const PRODUCT_URL =
  'https://p.webyar.ai/product/%d8%a7%d8%b3%d9%be%db%8c%da%a9%d8%b1-%d8%a8%d9%84%d9%88%d8%aa%d9%88%d8%ab%db%8c-%d8%b1%d8%b2%d9%88%d9%86%d8%a7%d9%86%d8%b3/';
/** What the button says. The address itself is never printed. */
const LABEL = 'باز کردن لینک';
/** What `title` shows — the exact destination, decoded so it can be read. */
const PRODUCT_TITLE = 'p.webyar.ai/product/اسپیکر-بلوتوثی-رزونانس';

let linkify: (t: string) => string;
let readable: (href: string) => string;
let safeUrl: (raw: string) => string | null;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(read('public/widget/runtime.js')).call(window);
  const rt = (window as any).__gs_runtime;
  linkify = (text: string) => rt.linkifyHtml(text, LABEL);
  readable = rt.readableUrl;
  safeUrl = rt.safeHttpUrl;
});

/** Parse the produced HTML rather than string-matching it. */
function anchors(html: string): HTMLAnchorElement[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  return Array.from(host.querySelectorAll('a'));
}
const textOf = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.textContent ?? '';
};

describe('a link the assistant sends', () => {
  it('becomes a real anchor, with the address it was given left alone', async () => {
    const [a] = anchors(linkify(`لینک محصول: ${PRODUCT_URL}`));

    expect(a).toBeTruthy();
    // The href must stay encoded — that is the only form the server accepts.
    expect(a.getAttribute('href')).toBe(PRODUCT_URL);
  });

  it('shows a label, and never the address', async () => {
    // Printing the address was useless twice over: percent-escapes are
    // unreadable, and a model asked to repeat one retypes it and gets it
    // wrong, so what was printed was not even a working address.
    const [a] = anchors(linkify(`لینک خرید: ${PRODUCT_URL}`));

    expect(a.textContent).toBe(LABEL);
    expect(a.textContent).not.toContain('%d8');
    expect(a.textContent).not.toContain('p.webyar.ai');
  });

  it('but the exact destination is one hover away, decoded', async () => {
    // A visitor is being asked to leave the page, so checking where a button
    // goes has to be possible — in Persian, not in escapes.
    const [a] = anchors(linkify(PRODUCT_URL));

    expect(a.getAttribute('title')).toBe(PRODUCT_TITLE);
    expect(readable(PRODUCT_URL)).toBe(PRODUCT_TITLE);
  });

  it('opens away from the shop without handing over the opener', async () => {
    const [a] = anchors(linkify(PRODUCT_URL));

    expect(a.getAttribute('target')).toBe('_blank');
    const rel = (a.getAttribute('rel') ?? '').split(/\s+/);
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('reads the same however long the address is', async () => {
    // The label no longer grows with the URL, so a hundred-character link
    // cannot stretch its bubble — which is what it used to do.
    const long = 'https://shop.example.com/category/electronics/audio/wireless/2026/review/a-very-long-product-slug-indeed';
    const [a] = anchors(linkify(long));

    expect(a.getAttribute('href')).toBe(long);
    expect(a.textContent).toBe(LABEL);
    expect(a.getAttribute('title')).toBe(readable(long));
  });
});

describe('what must never become a link', () => {
  it('a script URL — it stays inert text', async () => {
    // eslint-disable-next-line no-script-url
    const html = linkify('tap here: javascript:alert(document.cookie)');

    // The characters still appear — as text. What matters is that they are
    // text and not an attribute: no anchor, and nothing with an href at all.
    expect(anchors(html)).toHaveLength(0);
    expect(html).not.toContain('href');
    expect(textOf(html)).toBe('tap here: javascript:alert(document.cookie)');
  });

  it('a data: URL', async () => {
    expect(anchors(linkify('data:text/html;base64,PHNjcmlwdD4='))).toHaveLength(0);
  });

  it('and markup in the message is still escaped', async () => {
    // A message body can carry an operator's or a model's text; producing
    // markup here would make every message an injection point.
    const html = linkify('<img src=x onerror=alert(1)> and <b>bold</b>');

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(textOf(html)).toBe('<img src=x onerror=alert(1)> and <b>bold</b>');
  });

  it('nor does a message without a link change at all', async () => {
    expect(linkify('سلام، قیمت اسپیکر چنده؟')).toBe('سلام، قیمت اسپیکر چنده؟');
  });
});

describe('where a link stops', () => {
  it('a full stop after it is punctuation, not part of the address', async () => {
    const [a] = anchors(linkify('ببینید https://example.com/سلام.'));

    expect(a.getAttribute('href')).toBe('https://example.com/%D8%B3%D9%84%D8%A7%D9%85');
    expect(textOf(linkify('ببینید https://example.com/سلام.')).endsWith('.')).toBe(true);
  });

  it('a bracket the address itself opened is kept', async () => {
    const [a] = anchors(linkify('https://en.example.org/wiki/Foo_(bar)'));
    expect(a.getAttribute('href')).toBe('https://en.example.org/wiki/Foo_(bar)');
  });

  it('two links in one sentence are two links', async () => {
    const found = anchors(linkify(`اول ${PRODUCT_URL} و دوم https://example.com/x`));
    expect(found.map((a) => a.getAttribute('href'))).toEqual([PRODUCT_URL, 'https://example.com/x']);
  });

  it('a bare www. address still resolves to https', async () => {
    expect(safeUrl('www.example.com/a')).toBe('https://www.example.com/a');
    expect(safeUrl('ftp://example.com/a')).toBeNull();
  });
});

describe('the message bubble itself', () => {
  // The real template, given the real linkifier, exactly as Core mounts it.
  function renderBubble(body: string, typewriter: unknown = null) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(read('public/widget/presentation-default.js')).call(window);
    const template = (window as any).__gs_presentation_default.create({
      t: (k: string) => k,
      escapeHtml: (v: unknown) => {
        const d = document.createElement('div');
        d.textContent = v == null ? '' : String(v);
        return d.innerHTML;
      },
      linkifyHtml: (text: string, label?: string) => (window as any).__gs_runtime.linkifyHtml(text, label),
      linkLabel: LABEL,
      config: {},
      locale: 'fa',
      primaryColor: '#1f93ff',
    });
    return template.messagesHtml(
      { messages: [{ __id: 'm1', body, sender: 'operator', senderType: 'ai', time: '2026-09-21T09:00:00Z' }] },
      '',
      { typewriter },
    );
  }

  const AI_REPLY = `قیمت اسپیکر بلوتوثی رزونانس 2,490,000 IR (در حال حاضر در انبار موجود است). لینک محصول: ${PRODUCT_URL}`;

  it('renders the assistant’s product link as a chip', async () => {
    const html = renderBubble(AI_REPLY);
    const [a] = anchors(html);

    expect(a).toBeTruthy();
    expect(a.className).toBe('msg-link');
    expect(a.getAttribute('href')).toBe(PRODUCT_URL);
    expect(a.textContent).toBe(LABEL);
  });

  it('leaves the text plain while it is still being typed out', async () => {
    // Half a URL is not a link, and the reveal writes textContent frame by
    // frame — markup written here would be wiped by the next tick anyway.
    const tokens = AI_REPLY.match(/\S+\s*/g)!;
    const html = renderBubble(AI_REPLY, { id: 'm1', tokens, revealedCount: 3 });

    expect(anchors(html)).toHaveLength(0);
    expect(html).toContain('data-typing-id="m1"');
  });

  it('and the finished bubble no longer claims to be revealing', async () => {
    const tokens = AI_REPLY.match(/\S+\s*/g)!;
    const html = renderBubble(AI_REPLY, { id: 'm1', tokens, revealedCount: tokens.length });

    expect(html).not.toContain('data-typing-id');
    expect(anchors(html)).toHaveLength(1);
  });
});
