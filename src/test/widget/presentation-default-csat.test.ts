/**
 * The rating card of the default template (presentation-default.js
 * `csatHtml`, its `csat` at the top level): under the closed line Core passes
 * a card for (`view.csat.closedId`), a quiet card with no face, five stars
 * (1 very bad … 5 great), then the comment and the send; rated, the stars it
 * got and a thanks; gone and not-sent said in its own words (fa, en, tr;
 * English otherwise). default never declares `features`, so it never waits
 * for or downloads runtime-ext.js (coreFeaturesDefaultInert.test.ts, the
 * behaviour in afterChat.test.ts).
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type Vm = Record<string, unknown>;
type Renderer = { csat?: boolean; closedNotice?: boolean; features?: unknown; messagesHtml: (s: Vm, extra: unknown, view: Vm) => string };
const SRC = readFileSync('public/widget/presentation-default.js', 'utf8');
const CSS = readFileSync('public/widget/presentation-default.css', 'utf8');
const INTL_CSS = readFileSync('public/widget/presentation-intl.css', 'utf8');
const T: Record<string, string> = { wyEnded: 'گفتگو به پایان رسید', wyEndedBy: '{name} گفتگو را به پایان رساند' };

function make(locale = 'fa'): Renderer {
  new Function(SRC).call(window);
  const mod = (window as unknown as Record<string, { create: (env: unknown) => Renderer }>).__gs_presentation_default;
  return mod.create({ t: (k: string) => (locale === 'fa' ? T[k] ?? k : k), config: {}, locale, primaryColor: '#3B82F6' });
}
const closedLine = (md: Vm = {}): Vm => ({
  __id: 'cl1', sender: 'operator', senderType: 'system', body: 'The conversation was closed', time: new Date().toISOString(),
  metadata: { kind: 'conversation_closed', agent_name: null, status: 'closed', ...md },
});
const vm = (over: Vm = {}): Vm => ({ closedId: 'cl1', name: 'سارا', avatar: null, rating: 0, comment: '', state: 'ask', subject: 'operator', transcript: null, ...over });
const parse = (html: string) => new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html').getElementById('r')!;
function draw(over: Vm = {}, opts: { locale?: string; line?: Vm } = {}) {
  const root = parse(make(opts.locale).messagesHtml({ messages: [closedLine(opts.line)] }, undefined, { csat: vm(over) }));
  return { root, card: root.querySelector<HTMLElement>('.wy-rate[data-csat]') };
}

describe('default: the rating under the closed line (`view.csat`)', () => {
  it('declares it at the top level, next to the closed line, never under `features`', () => {
    const r = make();
    expect(r.csat).toBe(true);
    expect(r.closedNotice).toBe(true);
    expect(r.features).toBeUndefined();
  });

  it('a card only under the line Core passes one for; none without `view.csat`', () => {
    const { root, card } = draw();
    expect(card).not.toBeNull();
    // Right under the line (the nameless one of a close by the system).
    const line = card!.previousElementSibling!;
    expect(line.matches('.msg-day')).toBe(true);
    expect(line.textContent).toBe('گفتگو به پایان رسید');
    expect(root.querySelectorAll('[data-csat]')).toHaveLength(1);
    expect(draw({ closedId: 'cl0' }).card).toBeNull();
    expect(parse(make().messagesHtml({ messages: [closedLine()] }, undefined, { csat: null })).querySelector('[data-csat]')).toBeNull();
    // A named close keeps its own line.
    expect(draw({}, { line: { agent_name: 'مهدی' } }).card!.previousElementSibling!.textContent).toBe('مهدی گفتگو را به پایان رساند');
  });

  it('asks: the question, five stars with aria-pressed and their words, the comment and the send; no face, no sub-line', () => {
    const card = draw({ rating: 2, comment: 'خوب نبود' }).card!;
    expect(card.getAttribute('role')).toBe('group');
    expect(card.getAttribute('tabindex')).toBe('-1');
    expect(card.getAttribute('aria-label')).toBe('گفتگو با سارا چطور بود؟');
    expect(card.querySelector('.wy-rate-q')!.textContent).toBe('گفتگو با سارا چطور بود؟');
    const stars = Array.from(card.querySelectorAll<HTMLButtonElement>('.wy-stars > button.wy-star[data-csat-rate]'));
    expect(stars.map((b) => b.getAttribute('data-csat-rate'))).toEqual(['1', '2', '3', '4', '5']);
    expect(stars.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false', 'false']);
    expect(stars.map((b) => b.getAttribute('aria-label'))).toEqual(['خیلی بد', 'بد', 'معمولی', 'خوب', 'عالی']);
    expect(stars.every((b) => b.type === 'button' && !!b.querySelector('svg[aria-hidden="true"]'))).toBe(true);
    const ta = card.querySelector<HTMLTextAreaElement>('textarea.wy-rate-ta[data-csat-comment]')!;
    expect(ta.value).toBe('خوب نبود');
    expect(ta.getAttribute('maxlength')).toBe('1000');
    expect(ta.getAttribute('aria-label')).toBe('چیز دیگری هم بگویید (اختیاری)');
    const send = card.querySelector<HTMLButtonElement>('button.wy-rate-send[data-csat-submit]')!;
    expect(send.textContent).toBe('ارسال نظر');
    expect(send.disabled).toBe(false);
    expect(card.querySelector('img, svg:not([aria-hidden])')).toBeNull();
    expect(card.querySelectorAll('p')).toHaveLength(1);
    expect(draw().card!.querySelector<HTMLButtonElement>('[data-csat-submit]')!.disabled).toBe(true);
  });

  it('the AI\'s conversation (no name): the nameless question', () => {
    expect(draw({ name: '', subject: 'ai' }).card!.querySelector('.wy-rate-q')!.textContent).toBe('گفتگوی شما چطور بود؟');
  });

  it('sending, rated, gone and not sent', () => {
    const busy = draw({ rating: 4, state: 'sending' }).card!;
    expect(Array.from(busy.querySelectorAll<HTMLButtonElement>('[data-csat-rate]')).every((b) => b.disabled)).toBe(true);
    expect(busy.querySelector('[data-csat-submit]')!.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector<HTMLTextAreaElement>('[data-csat-comment]')!.readOnly).toBe(true);
    const done = draw({ rating: 4, state: 'done' }).card!;
    expect(done.classList.contains('is-done')).toBe(true);
    expect(done.querySelectorAll('.wy-stars[aria-hidden="true"] i')).toHaveLength(5);
    expect(done.querySelectorAll('.wy-stars i.on')).toHaveLength(4);
    expect(done.querySelector('.wy-rate-note[role="status"]')!.textContent).toBe('از نظرتان سپاسگزاریم! امتیاز شما: خوب');
    expect(done.querySelector('[data-csat-rate], [data-csat-submit], [data-csat-comment]')).toBeNull();
    const gone = draw({ state: 'gone' }).card!;
    expect(gone.querySelector('.wy-rate-note.is-error[role="status"]')!.textContent).toBe('دیگر نمی‌شود به این گفتگو امتیاز داد.');
    expect(gone.querySelector('[data-csat-rate], [data-csat-submit]')).toBeNull();
    const err = draw({ rating: 1, state: 'error' }).card!;
    expect(err.querySelector('.wy-rate-note.is-error[role="alert"]')!.textContent).toBe('ارسال نشد');
    expect(err.querySelector('[data-csat-rate="1"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(err.querySelector<HTMLButtonElement>('[data-csat-submit]')!.disabled).toBe(false);
    // A rating out of range is no pick.
    expect(draw({ rating: 9 }).card!.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  });

  it('its own words in English and Turkish (English for any other language), the name as plain text', () => {
    const en = draw({ rating: 5, state: 'done' }, { locale: 'en' }).card!;
    expect(en.querySelector('.wy-rate-q')!.textContent).toBe('How was your chat with سارا?');
    expect(en.querySelector('[role="status"]')!.textContent).toBe('Thanks for your feedback! Your rating: Great');
    expect(draw({ name: '' }, { locale: 'tr' }).card!.querySelector('.wy-rate-q')!.textContent).toBe('Sohbetiniz nasıldı?');
    expect(draw({ state: 'error', rating: 2 }, { locale: 'tr' }).card!.querySelector('[role="alert"]')!.textContent).toBe('Gönderilemedi');
    expect(draw({}, { locale: 'de' }).card!.querySelector('[data-csat-submit]')!.textContent).toBe('Send feedback');
    expect(draw({}, { locale: 'constructor' }).card!.querySelector('[data-csat-submit]')!.textContent).toBe('Send feedback');
    const x = draw({ name: '$& <b>x</b>' }).root;
    expect(x.querySelector('b')).toBeNull();
    expect(x.querySelector('.wy-rate-q')!.textContent).toBe('گفتگو با $& <b>x</b> چطور بود؟');
  });

  it('its stylesheet: a quiet card, the stars in their colour (Signal in RESPOK\'s skin), the comment and send once a star is picked where :has() is read', () => {
    expect(CSS).toContain('max-width: 300px;');
    expect(CSS).toContain('var(--wy-star, #f5a524)');
    expect(CSS).toMatch(/@supports selector\(:has\(a\)\) \{\n {2}\.wy-rate:not\(:has\(\[aria-pressed='true'\]\)\) :is\(\.wy-rate-ta, \.wy-rate-send\) \{ display: none; \}\n\}/);
    // :has() only in rules of their own: a browser without it drops them alone.
    for (const rule of CSS.split('}').filter((r) => r.includes(':has(~'))) expect(rule.split('{')[0].split(',')).toHaveLength(1);
    expect(INTL_CSS).toContain('.wy-rate { --wy-star: #FF5A3C; }');
  });
});
