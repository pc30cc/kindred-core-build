// @vitest-environment jsdom
/**
 * Raw-text elements cannot carry live markup past the layout
 * (server/services/email/layout.ts, FORBIDDEN). A browser reads what is
 * inside <xmp>, <noembed> and <noframes> as text up to their first closing
 * tag, wherever it stands, while the layout's reader reads it as markup: a
 * closing tag written inside an attribute or a comment would end them early
 * in the reader's mail client, and what follows would be live there. So the
 * save check refuses them and the send path drops them with all they hold.
 * Each case is parsed back as a browser parses it (jsdom), not by the
 * layout's own reader.
 */
import { describe, expect, it } from 'vitest';
import {
  contentProblems,
  renderEmailDocument,
  sendableDocument,
  type EmailBrand,
} from '../../../server/services/email/layout';

const RESPOK: EmailBrand = {
  edition: 'international',
  name: 'RESPOK',
  appUrl: 'https://app.respok.app',
  siteUrl: 'https://respok.app',
  supportEmail: 'support@respok.app',
  legal: '© 2026 RESPOK',
  logo: {
    light: 'https://app.respok.app/brand/intl/email/respok-logo.png',
    dark: 'https://app.respok.app/brand/intl/email/respok-logo-dark.png',
    width: 400,
    height: 92,
  },
};
const rules = { hosts: ['https://app.respok.app', 'https://respok.app'], supportEmail: 'support@respok.app' };

const LIVE = '<img src="x" onerror="alert(1)"><script>alert(2)</script><iframe src="https://evil.example"></iframe>'
  + '<form action="https://evil.example"><input type="password" name="p"></form>'
  + '<meta http-equiv="refresh" content="0;url=https://evil.example">';

/** What a browser finds live in `html`. */
function live(html: string) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  return {
    handlers: [...d.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
    scripts: d.querySelectorAll('script').length,
    frames: d.querySelectorAll('iframe').length,
    inputs: d.querySelectorAll('form, input').length,
    refresh: d.querySelectorAll('meta[http-equiv="refresh" i]').length,
  };
}
const NONE = { handlers: 0, scripts: 0, frames: 0, inputs: 0, refresh: 0 };

describe.each(['xmp', 'noembed', 'noframes'])('<%s>', (tag) => {
  const inAttribute = `<${tag}><p title="</${tag}>${LIVE.replace(/"/g, '&quot;')}">x</p></${tag}>`;
  const inComment = `<${tag}><!-- </${tag}>${LIVE} --></${tag}>`;

  it.each([['an attribute', inAttribute], ['a comment', inComment]])('a closing tag in %s smuggles nothing out of a whole document', (_where, smuggle) => {
    const row = `<!doctype html><html><body>${smuggle}<p>Kept</p></body></html>`;
    expect(contentProblems(row, rules)).toContain(`forbidden_element:${tag}`);
    const sent = sendableDocument(row);
    expect(live(sent)).toEqual(NONE);
    expect(sent).not.toContain(`<${tag}`);
    expect(sent).toContain('Kept');
  });

  it.each([['an attribute', inAttribute], ['a comment', inComment]])('a closing tag in %s smuggles nothing out of a content row', (_where, smuggle) => {
    const content = `<p>Hello</p>${smuggle}<p>Kept</p>`;
    expect(contentProblems(content, rules)).toContain(`forbidden_element:${tag}`);
    const mail = renderEmailDocument({ brand: RESPOK, locale: 'en', title: 'Subject', contentHtml: content, category: 'transactional' });
    expect(live(mail)).toEqual(NONE);
    expect(mail).not.toContain(`<${tag}`);
    expect(mail).toContain('Kept');
  });
});
