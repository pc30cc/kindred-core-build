/**
 * Widget escaping must be safe inside quoted attributes.
 *
 * `Util.escapeHtml` used to be textContent→innerHTML, which leaves `"` and
 * `'` untouched — yet its output is placed inside `"…"` attributes all over
 * the default presentation (alt/title/src/data-*). A file name, sender name
 * or message body containing a quote could break out of the attribute.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const PAYLOAD = `x" onerror="alert(1)" data-y='z`;

type WidgetRuntime = {
  escapeHtml: (v: unknown) => string;
  linkifyHtml: (text: string, label?: string) => string;
};
type WidgetPresentation = {
  messagesHtml: (state: { messages: Array<Record<string, unknown>> }, extra: string, opts: Record<string, unknown>) => string;
};
/** Globals the widget scripts install on `window`. */
type WidgetWindow = Window & {
  __gs_runtime: WidgetRuntime;
  __gs_presentation_default: { create: (env: Record<string, unknown>) => WidgetPresentation };
};

let rt: WidgetRuntime;

beforeAll(() => {
  new Function(read('public/widget/runtime.js')).call(window);
  rt = (window as unknown as WidgetWindow).__gs_runtime;
});

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('runtime escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(rt.escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(rt.escapeHtml(null)).toBe('');
    expect(rt.escapeHtml(undefined)).toBe('');
    expect(rt.escapeHtml(42)).toBe('42');
  });

  it('cannot break out of a double- or single-quoted attribute', () => {
    const dq = parse(`<img title="${rt.escapeHtml(PAYLOAD)}">`).querySelector('img')!;
    expect(dq.getAttribute('onerror')).toBeNull();
    expect(dq.getAttribute('title')).toBe(PAYLOAD);

    const sq = parse(`<img title='${rt.escapeHtml(PAYLOAD)}'>`).querySelector('img')!;
    expect(sq.getAttribute('data-y')).toBeNull();
    expect(sq.getAttribute('title')).toBe(PAYLOAD);
  });

  it('keeps the link title escaped after percent-decoding', () => {
    const html = rt.linkifyHtml(
      'see https://example.com/%22%20onmouseover=%22alert(1) now',
      'Open',
    );
    const a = parse(html).querySelector('a')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('onmouseover')).toBeNull();
    expect(a.getAttribute('title')).toContain('" onmouseover="alert(1)');
  });
});

describe('default presentation with the real escaper', () => {
  function template() {
      new Function(read('public/widget/presentation-default.js')).call(window);
    return (window as unknown as WidgetWindow).__gs_presentation_default.create({
      t: (k: string) => k,
      escapeHtml: rt.escapeHtml,
      linkifyHtml: rt.linkifyHtml,
      config: {},
      locale: 'en',
      primaryColor: '#1f93ff',
    });
  }

  it('round-trips quotes in copy/reply data attributes and attachment names', () => {
    const body = `He said "hi" & it's <b>fine</b>`;
    const html = template().messagesHtml(
      {
        messages: [
          {
            __id: 'm1',
            body,
            sender: 'operator',
            senderName: PAYLOAD,
            time: '2026-09-21T09:00:00Z',
            attachment: { id: 'a1', file_name: PAYLOAD, kind: 'file', size_bytes: 10 },
          },
        ],
      },
      '',
      {},
    );
    const root = parse(html);
    expect(root.querySelector('[onerror]')).toBeNull();
    expect(root.querySelector('[data-y]')).toBeNull();
    expect(root.querySelector('b')).toBeNull();

    const copy = root.querySelector('[data-msg-copy]');
    expect(copy?.getAttribute('data-msg-copy')).toBe(body);
    const reply = root.querySelector('[data-msg-reply-text]');
    expect(reply?.getAttribute('data-msg-reply-text')).toBe(body);
    expect(reply?.getAttribute('data-msg-reply-author')).toBe(PAYLOAD);

    const dl = root.querySelector('[data-att-download-name]');
    expect(dl?.getAttribute('data-att-download-name')).toBe(PAYLOAD);
  });

  it('the fallback escaper (no env.escapeHtml) also escapes quotes', () => {
      new Function(read('public/widget/presentation-default.js')).call(window);
    const tpl = (window as unknown as WidgetWindow).__gs_presentation_default.create({
      t: (k: string) => k,
      config: {},
      locale: 'en',
    });
    const html = tpl.messagesHtml(
      { messages: [{ __id: 'm1', body: PAYLOAD, sender: 'visitor', time: '2026-09-21T09:00:00Z' }] },
      '',
      {},
    );
    const root = parse(html);
    expect(root.querySelector('[onerror]')).toBeNull();
    expect(root.querySelector('[data-msg-copy]')?.getAttribute('data-msg-copy')).toBe(PAYLOAD);
  });
});
