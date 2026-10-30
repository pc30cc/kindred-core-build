// @vitest-environment node
/**
 * The platform email layout (server/services/email/layout.ts): the content
 * vocabulary, what passes through, what an attacker's text can and cannot
 * do, dark mode with an author's own colours, direction and fonts by
 * language, the logo and its fallbacks, the footer, the text part, and the
 * palettes' contrast. What it looks like is checked by eye with
 * scripts/email/render-all-templates.mts; these pin the rules.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_MAX_BYTES,
  EMAIL_PALETTES,
  contentProblems,
  contentToText,
  documentBody,
  extractPreheader,
  isWholeDocument,
  legalLine,
  localYear,
  renderEmailDocument,
  renderEmailText,
  styleContent,
  whyLine,
  type EmailBrand,
} from '../../../server/services/email/layout';
import { transcriptRow } from '../../../server/services/transcriptEmailRows';

const WEBYAR: EmailBrand = {
  edition: 'iran',
  name: 'وب‌یار',
  appUrl: 'https://app.webyar.ai',
  siteUrl: 'https://webyar.ai',
  supportEmail: 'info@webyar.ai',
  legal: '© ۱۴۰۵ وب‌یار',
  logo: {
    light: 'https://app.webyar.ai/brand/webyar/email/webyar-logo.png',
    dark: 'https://app.webyar.ai/brand/webyar/email/webyar-logo-dark.png',
    width: 360,
    height: 139,
  },
};
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

const fa = { locale: 'fa', edition: 'iran' as const };
const en = { locale: 'en', edition: 'international' as const };

const RECEIPT =
  '<div class="preheader">We received your payment of $31.90.</div><h1>Payment receipt</h1><p>Thanks — we received your payment.</p>' +
  '<table class="details"><tr><th>Receipt</th><td>R-7001</td></tr><tr><th>Amount</th><td>$31.90</td></tr></table>' +
  '<p class="action"><a href="https://app.respok.app/acme/billing">View receipt</a></p>';

const doc = (contentHtml: string, over: Partial<Parameters<typeof renderEmailDocument>[0]> = {}) =>
  renderEmailDocument({ brand: RESPOK, locale: 'en', title: 'Subject', contentHtml, category: 'transactional', ...over });

describe('the content vocabulary', () => {
  it('p.action with exactly one link is a button; anything else stays a paragraph', () => {
    const one = styleContent('<p class="action"><a href="https://x.example/pay">Pay</a></p>', en);
    expect(one).toContain('class="action x-btnt"');
    expect(one).toMatch(/<td class="x-btn" align="center" bgcolor="#C83319"/);
    expect(one).toMatch(/<a href="https:\/\/x\.example\/pay" class="x-btna" style="display:inline-block;padding:15px 30px;/);

    const two = styleContent('<p class="action"><a href="https://x.example/pay">Pay</a> or <a href="https://x.example/help">Contact</a></p>', en);
    expect(two).not.toContain('x-btnt');
    expect(two).toContain('>Pay</a> or <a');
    expect(two.match(/class="x-link"/g)).toHaveLength(2);

    const none = styleContent('<p class="action">No link here</p>', en);
    expect(none).not.toContain('x-btn');
    expect(none).toMatch(/<p class="action x-ink" style="margin:0 0 0px;/);
  });

  it('a code is left to right in a Latin face, whatever the language, and a long one breaks', () => {
    const code = styleContent('<div class="code">482917</div>', fa);
    expect(code).toMatch(/<td class="code x-code" dir="ltr" align="center"/);
    expect(code).toContain("font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif");
    expect(code).toContain('letter-spacing:10px');
    expect(code).toContain('unicode-bidi:isolate');
    const long = styleContent('<div class="code">K7Q2M9XD41</div>', fa);
    expect(long).toContain('font-size:26px');
    expect(long).toContain('letter-spacing:3px');
    expect(long).toContain('word-break:break-all');
  });

  it('a details table is data: th scope=row, no presentation role on it, labels whole, long values breakable', () => {
    const html = styleContent('<table class="details"><tr><th>Email</th><td>mohammadreza.hosseinzadeh1990@gmail.com</td></tr><tr><th>Card</th><td dir="ltr">•••• 4242</td></tr></table>', en);
    expect(html).toMatch(/<table class="details x-details" width="100%"/);
    expect(html).not.toMatch(/<table class="details x-details"[^>]*role="presentation"/);
    expect(html.match(/scope="row"/g)).toHaveLength(2);
    expect(html).toMatch(/<th[^>]*style="[^"]*word-break:normal;overflow-wrap:normal;/);
    expect(html).toMatch(/gmail\.com<\/td>/);
    expect(html).toMatch(/<td class="x-ink x-line"[^>]*overflow-wrap:anywhere;word-break:break-word;/);
    // A short left-to-right value (a phone, a card) never breaks or reorders.
    expect(html).toMatch(/<td dir="ltr" class="x-ink"[^>]*unicode-bidi:isolate;white-space:nowrap;/);
  });

  it('a span marked left to right is isolated, and a short one never breaks', () => {
    const html = styleContent('<p>تلفن: <span dir="ltr">+98 912 000 0000</span></p>', fa);
    expect(html).toContain('<span dir="ltr" class="x-ltr" style="unicode-bidi:isolate;white-space:nowrap;">+98 912 000 0000</span>');
  });

  it('a link whose text is an address is left to right and breaks anywhere', () => {
    const html = styleContent('<p><a href="https://app.webyar.ai/r?t=1">https://app.webyar.ai/r?t=1</a></p>', fa);
    expect(html).toMatch(/<a href="https:\/\/app\.webyar\.ai\/r\?t=1" class="x-link" style="[^"]*word-break:break-all;" dir="ltr">/);
  });

  it('callouts, the quote and transcript bubbles take their own ink for links and paragraphs', () => {
    const html = styleContent('<div class="warning"><p>One.</p><p>Two <a href="https://x.example">x</a>.</p></div>', en);
    expect(html).toMatch(/<td class="warning x-warn" bgcolor="#FFF0EB"/);
    expect(html).toMatch(/<p class="x-warn" style="margin:0 0 8px;/);
    expect(html).toMatch(/<p class="x-warn" style="margin:0 0 0px;/);
    expect(html).toMatch(/<a href="https:\/\/x\.example" class="x-warn" style="color:#8A2410;/);
  });

  it('the reader\'s own messages sit on the end side, the team\'s on the start side', () => {
    const t = '<div class="transcript"><div class="msg msg-visitor"><div class="meta">You · 10:24</div><div class="bubble">Hi</div></div><div class="msg msg-agent"><div class="meta">Maria</div><div class="bubble">Hello</div></div></div>';
    const ltr = styleContent(t, en);
    expect(ltr).toMatch(/<td align="right" style="padding:0 0 14px;text-align:right;"><table[^>]*align="right"[\s\S]*class="x-br"/);
    const rtl = styleContent(t, fa);
    expect(rtl).toMatch(/<td align="left" style="padding:0 0 14px;text-align:left;"><table[^>]*align="left"[\s\S]*class="x-br"/);
    // The bubble repeats no font: it inherits the card's (Gmail clips long mails).
    expect(ltr).not.toMatch(/class="x-br"[^>]*font-family/);
  });

  it('the last block owns no space under it: the card\'s padding ends the mail', () => {
    expect(styleContent('<p>One</p><p>Two</p>', en)).toMatch(/margin:0 0 16px;[\s\S]*margin:0 0 0px;/);
    expect(styleContent('<p>One</p><p class="action"><a href="https://x.example">Go</a></p>\n', en)).toContain('padding:10px 0 0px;');
  });
});

describe('a transcript\'s sides follow who reads it', () => {
  // The rows as the senders build them (transcriptEmailRows.ts): a customer's line, a team's line, a notice.
  const ROWS = transcriptRow('visitor', 'Sara · 10:24', 'Hi') + transcriptRow('agent', 'Team · 10:25', 'Hello') + transcriptRow('agent', 'Ali closed the conversation');
  const visitorCopy = `<div class="transcript">${ROWS}</div>`;
  const teamCopy = `<div class="transcript" data-reader="team">${ROWS}</div>`;
  /** Each message row's side, its bubble's class and colour, in order. */
  const sides = (html: string) =>
    [...html.matchAll(/<tr><td align="(left|right|center)" style="padding:0 0 14px;[^"]*"><table[^>]*>([\s\S]*?)<\/table><\/td><\/tr>/g)].map((m) => {
      const bubble = /<td[^>]*class="(x-b[ro])" bgcolor="(#[0-9A-F]{6})"[^>]*>/.exec(m[2]);
      return [m[1], bubble?.[1] ?? null, bubble?.[2] ?? null];
    });
  const P = EMAIL_PALETTES.international;

  it('the visitor\'s copy: the customer\'s lines are the reader\'s, the team\'s across from them, a notice in the middle', () => {
    expect(sides(styleContent(visitorCopy, en))).toEqual([
      ['right', 'x-br', P.light.bubbleReader],
      ['left', 'x-bo', P.light.bubbleOther],
      ['center', null, null],
    ]);
  });

  it('the team\'s copy (data-reader="team"): the team\'s lines are the reader\'s, the customer\'s across from them', () => {
    const html = styleContent(teamCopy, en);
    expect(sides(html)).toEqual([
      ['left', 'x-bo', P.light.bubbleOther],
      ['right', 'x-br', P.light.bubbleReader],
      ['center', null, null],
    ]);
    // The reader's bubble has its tail on the end side, the other one on the start side.
    expect(html).toMatch(/class="x-bo" bgcolor="[^"]*" style="[^"]*border-radius:18px 18px 18px 4px;[^"]*">Hi<\/td>/);
    expect(html).toMatch(/class="x-br" bgcolor="[^"]*" style="[^"]*border-radius:18px 18px 4px 18px;[^"]*color:#FFFFFF;[^"]*">Hello<\/td>/);
    // A notice is a muted line in the middle, with no bubble.
    expect(html).toMatch(/<td class="x-muted" align="center" style="padding:0 4px;[^"]*text-align:center;[^"]*">Ali closed the conversation<\/td>/);
    expect(html).toContain('<table class="transcript x-transcript" data-reader="team"');
  });

  it('right to left, the end side is the left one; a notice stays in the middle', () => {
    expect(sides(styleContent(teamCopy, fa))).toEqual([
      ['right', 'x-bo', EMAIL_PALETTES.iran.light.bubbleOther],
      ['left', 'x-br', EMAIL_PALETTES.iran.light.bubbleReader],
      ['center', null, null],
    ]);
    expect(sides(styleContent(visitorCopy, fa)).map((s) => s[0])).toEqual(['left', 'right', 'center']);
  });

  it('dark: a forced scheme carries the dark bubbles inline, a sent mail the rules for both classes', () => {
    expect(sides(styleContent(teamCopy, { ...en, scheme: 'dark' }))).toEqual([
      ['left', 'x-bo', P.dark.bubbleOther],
      ['right', 'x-br', P.dark.bubbleReader],
      ['center', null, null],
    ]);
    // RESPOK's reader bubble in the dark is signal with ink text.
    expect(styleContent(teamCopy, { ...en, scheme: 'dark' })).toMatch(/class="x-br" bgcolor="#FF5A3C" style="[^"]*color:#16142B;[^"]*">Hello<\/td>/);
    const media = /@media \(prefers-color-scheme:dark\)\{(.*)\}\n/.exec(doc(teamCopy))?.[1] ?? '';
    expect(media).toContain(`.x-br{background-color:${P.dark.bubbleReader}!important;color:${P.dark.bubbleReaderInk}!important}`);
    expect(media).toContain(`.x-bo{background-color:${P.dark.bubbleOther}!important;color:${P.dark.bubbleOtherInk}!important}`);
  });

  it('the text part reads the same lines in the same order, whoever reads it', () => {
    const text = 'Sara · 10:24\nHi\n\nTeam · 10:25\nHello\n\nAli closed the conversation';
    expect(contentToText(teamCopy)).toBe(text);
    expect(contentToText(visitorCopy)).toBe(text);
    expect(renderEmailText({ brand: RESPOK, locale: 'en', contentHtml: teamCopy, category: 'notification' })).toMatch(/^Sara · 10:24\nHi\n\nTeam · 10:25\nHello\n\nAli closed the conversation\n\n/);
  });

  it('styling its own output changes nothing, in both copies and both directions', () => {
    for (const content of [teamCopy, visitorCopy]) {
      for (const opts of [en, fa, { ...en, scheme: 'dark' as const }]) {
        const once = styleContent(content, opts);
        expect(styleContent(once, opts)).toBe(once);
      }
    }
  });
});

describe('what passes through', () => {
  it('unknown markup is kept, with its attributes, and its vocabulary children are still styled', () => {
    const html = styleContent('<section data-x="1" class="mine"><p>Inside</p></section><ul><li>One</li></ul>', en);
    expect(html).toMatch(/^<section data-x="1" class="mine"><p class="x-ink" style="margin:0 0 16px;/);
    expect(html).toContain('<ul><li>One</li></ul>');
  });

  it('our style goes first, so an author\'s own inline style wins', () => {
    const html = styleContent('<p style="color:#7a00aa;margin:0">Mine</p>', en);
    expect(html).toMatch(/<p style="margin:0 0 0px;[^"]*mso-line-height-rule:exactly;color:#7a00aa;margin:0" class="x-ink">/);
  });

  it('a stray closing tag is dropped, so content cannot close the layout around it', () => {
    const html = styleContent('<p>a</p></td></tr></table><p>b</p>', en);
    expect(html).not.toMatch(/<\/td><\/tr><\/table><p/);
  });

  it('running the styler on its own output changes nothing', () => {
    const content = `${RECEIPT}<div class="code">482917</div><blockquote>Hi</blockquote><div class="notice"><p>N</p></div><hr><div class="transcript"><div class="msg msg-agent"><div class="meta">M</div><div class="bubble">B</div></div></div><p><span style="background:#FFF3C4">hl</span> <span dir="ltr">+1 415 555 0100</span></p>`;
    for (const opts of [en, fa]) {
      const { rest } = extractPreheader(content);
      const once = styleContent(rest, opts);
      expect(styleContent(once, opts)).toBe(once);
    }
  });
});

/** The document as a browser shows it: every comment out, ended where a browser ends it (an unended one hides the rest). */
function withoutComments(html: string): string {
  let out = '';
  let from = 0;
  for (let at = html.indexOf('<!--', from); at >= 0; at = html.indexOf('<!--', from)) {
    out += html.slice(from, at);
    const body = at + 4;
    if (html.startsWith('>', body)) from = body + 1;
    else if (html.startsWith('->', body)) from = body + 2;
    else {
      const ends = [html.indexOf('-->', body), html.indexOf('--!>', body)].filter((k) => k >= 0);
      if (!ends.length) return out;
      const end = Math.min(...ends);
      from = end + (html.startsWith('-->', end) ? 3 : 4);
    }
  }
  return out + html.slice(from);
}

describe('content cannot run on into the layout after it', () => {
  const footer = { html: '<p>Notifications are on. <a href="https://app.respok.app/u/abc">Unsubscribe</a></p>', text: 'x' };

  it('an unended comment or <!…> is dropped: the footer, its unsubscribe link and the legal line still show', () => {
    for (const tail of ['<!-- internal note', '<!-- note -', '<!x', '<?x', '<!DOCTYPE']) {
      const shown = withoutComments(doc(`<h1>Hi</h1><p>Body</p>${tail}`, { footer, category: 'notification' }));
      expect(shown).toContain('>Body</p>');
      expect(shown).toContain('>Unsubscribe</a>');
      expect(shown).toContain('>© 2026 RESPOK</td>');
      expect(shown).toMatch(/<\/body>\n<\/html>$/);
    }
  });

  it('a < that starts no finished tag is text, so it cannot take the layout\'s next tag into itself', () => {
    for (const tail of ['<a href="https://app.respok.app/x', '<p class="action"><a href="', '<img src=x', '< 3', '</ b']) {
      const html = doc(`<p>Body</p>${tail}`, { footer, category: 'notification' });
      expect(html).not.toContain(tail);
      expect(html).toContain(`&lt;${tail.slice(tail.lastIndexOf('<') + 1)}`);
      expect(withoutComments(html)).toContain('>Unsubscribe</a>');
    }
    expect(contentToText('<p>a < b</p>')).toBe('a < b');
  });

  it('a comment ends where a browser ends it, so what is kept as one is what a browser hides', () => {
    const html = styleContent('<!-- a --!><p>After</p><!--><p>Next</p><!---><p>Third</p><!-- b -->', en);
    expect(html).toMatch(/^<!-- a --!><p class="x-ink"[^>]*>After<\/p><!--><p class="x-ink"[^>]*>Next<\/p><!---><p class="x-ink"[^>]*>Third<\/p><!-- b -->$/);
    // Nothing hides behind an early end: what follows it is content, and checked as content.
    expect(styleContent('<!-- x --!><script>alert(1)</script>-->', en)).not.toContain('<script');
  });
});

describe('what a content may not send', () => {
  const rules = { hosts: ['https://app.respok.app', 'https://respok.app'], supportEmail: 'support@respok.app' };

  it('a row in the vocabulary, its placeholders included, has nothing to fix', () => {
    expect(contentProblems(RECEIPT, rules)).toEqual([]);
    const links =
      '<div class="preheader" style="display:none">P</div><p class="action"><a href="{action_url}">Go</a></p>' +
      '<p><a href="{{action_url}}">x</a> <a href="mailto:{support_email}">s</a> <a href="mailto:Support@respok.app?subject=Hi">s</a> ' +
      '<a href="https://help.respok.app/a">h</a> <a href="#top">t</a> <a href="tel:+14155550100">c</a></p>' +
      '<img src="https://app.respok.app/brand/x.png" width="120" height="40" alt="Chart"><div class="transcript"><div class="msg msg-visitor"><div class="meta">You</div><div class="bubble">Hi</div></div></div>';
    expect(contentProblems(links, rules)).toEqual([]);
  });

  it('names each problem once, by its code, never by what the content says', () => {
    const bad =
      '<div class="preheader">ok</div><script>steal()</script><iframe src="https://evil.example"></iframe>' +
      '<form action="https://evil.example"><input name="pw"><button>Send</button></form>' +
      '<p style="display:none">a</p><div style="visibility: hidden">b</div><div style="max-height:0;overflow:hidden">c</div><div hidden>d</div>' +
      '<p style="background-image:url(https://evil.example/x.png)">e</p><table background="https://evil.example/y.png"><tr><td>f</td></tr></table>' +
      '<img src="https://app.respok.app/a.png" width="1" height="1" alt="a"><img src="https://evil.example/b.png" width="1" height="1" alt="b"><img src="https://app.respok.app/c.png">' +
      '<p onclick="x()"><a href="https://evil.example/login">Sign in</a> <a href="javascript:alert(1)">j</a> <a href="/settings">r</a> <a href="mailto:someone@else.example">m</a></p>';
    const problems = contentProblems(bad, rules);
    expect([...problems].sort()).toEqual([
      'background_url', 'bad_link', 'event_handler', 'forbidden_element:button', 'forbidden_element:form', 'forbidden_element:iframe',
      'forbidden_element:input', 'forbidden_element:script', 'foreign_image', 'foreign_link', 'hidden_element',
      'image_without_size_or_alt', 'script_link', 'too_many_images',
    ]);
    expect(problems.join(' ')).not.toMatch(/evil|steal|pw|someone|settings/);
    // Hidden is hidden, whichever way: one at a time.
    for (const one of ['<p style="display:none">a</p>', '<div style="visibility:hidden">b</div>', '<div style="max-height:0px">c</div>', '<div hidden>d</div>']) {
      expect(contentProblems(one, rules)).toEqual(['hidden_element']);
    }
    expect(contentProblems('<div style="max-height:0.5em">c</div>', rules)).toEqual([]);
    // A second preheader is not the preview: hidden, it is hidden text.
    expect(contentProblems('<div class="preheader">one</div><p>x</p><div class="preheader" style="display:none">two</div>', rules)).toEqual(['hidden_element']);
  });

  it('a content past its budget is too large', () => {
    expect(contentProblems(`<p>${'x'.repeat(CONTENT_MAX_BYTES)}</p>`, rules)).toEqual(['too_large']);
  });

  it('the styler never sends what runs code, loads a page or takes input; a form or a button keeps its words', () => {
    const content =
      '<div class="preheader">Hi<script>p()</script><style>p{}</style></div><p onclick="x()" onmouseover="y()">Hi</p><script>steal()</script>' +
      '<iframe src="https://evil.example"></iframe><form action="https://evil.example"><p>Inside</p><input name="pw"><button type="submit">Send</button></form>' +
      '<svg><style><img src=x onerror=alert(1)></style></svg><object data="https://evil.example"></object>' +
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><select><option>Pick</option></select><textarea>Typed</textarea>';
    const html = doc(content);
    const body = html.slice(html.indexOf('<body'));
    expect(body).not.toMatch(/<(script|iframe|form|input|button|svg|object|meta|base|select|textarea)\b/i);
    expect(body).not.toMatch(/\bon(click|mouseover|error)=/i);
    expect(html).not.toMatch(/steal|evil|alert|Pick|Typed|p\(\)/);
    expect(html).toMatch(/<p class="x-ink"[^>]*>Inside<\/p>/);
    expect(html).toContain('Send');
    expect(html).toMatch(/<div data-preheader[^>]*>Hi&#847;/);
    const text = contentToText(content);
    expect(text).not.toMatch(/steal|alert|Pick|Typed|p\(\)/);
    expect(text).toContain('Inside');
  });
});

describe('the author\'s own children inside a container of the vocabulary are kept', () => {
  it('a transcript keeps what is not a message (an older mail\'s lines), each in its own row', () => {
    const legacy = styleContent('<div class="transcript"><p>legacy line</p></div>', en);
    expect(legacy).toMatch(/<table class="transcript x-transcript"[\s\S]*<td align="left" style="padding:0 0 14px;text-align:left;"><p class="x-ink"[^>]*>legacy line<\/p><\/td>/);
    const mixed = '<div class="transcript">loose words<div class="msg msg-agent"><div class="meta">M</div><div class="bubble">One</div><div class="bubble">Two</div><p class="note">Seen</p></div></div>';
    const html = styleContent(mixed, en);
    expect(html).toContain('>loose words</td>');
    expect(html).toMatch(/class="x-bo"[^>]*>One<\/td><\/tr><tr><td[^>]*class="x-bo"[^>]*>Two<\/td><\/tr><tr><td align="left" style="padding:6px 4px 0;text-align:left;"><p class="note x-muted"[^>]*>Seen<\/p>/);
    expect(contentToText(mixed)).toBe('loose words\n\nM\nOne\nTwo\n\nSeen');
    // Still idempotent.
    expect(styleContent(html, en)).toBe(html);
  });

  it('a details table keeps its caption and any other child, above its rows', () => {
    const content = '<table class="details"><caption>Your plan</caption><tr><th>Plan</th><td>Pro</td></tr></table>';
    const html = styleContent(content, en);
    expect(html).toMatch(/<td style="padding:4px 18px;"><div class="x-ink" style="padding:13px 0 0;[^"]*font-weight:700;[^"]*">Your plan<\/div><table class="details x-details"/);
    expect(html).not.toContain('<caption');
    expect(contentToText(content)).toContain('Your plan');
  });
});

describe('a value is text, whatever it says', () => {
  it('escaped markup and control characters stay text: no block is copied or made', () => {
    // As the core fills it: the visitor's message escaped by fillEmailTemplate.
    const typed = '&lt;div class=&quot;code&quot;&gt;999&lt;/div&gt; \u00010\u0001 \u000199\u0001';
    const html = styleContent(`<blockquote>${typed}</blockquote><p class="action"><a href="https://x.example/reply?token=secret">Reply</a></p>`, en);
    expect(html).toContain(typed);
    expect(html.match(/token=secret/g)).toHaveLength(1);
    expect(html).not.toContain('undefined');
    expect(html.match(/x-code/g)).toBeNull();
  });
});

describe('dark mode keeps an author\'s colours readable', () => {
  it('an element with its own background keeps dark text and its subtree leaves dark mode alone', () => {
    const html = styleContent('<p><span style="background:#FFF3C4">highlight <a href="https://x.example">link</a></span></p>', en);
    expect(html).toContain('<span style="color:#16142B;background:#FFF3C4">');
    expect(html).toMatch(/<a href="https:\/\/x\.example" class="x-pin" style="color:#B92F17;/);
  });

  it('a details row or value with its own background keeps light-scheme text, in a dark mail too', () => {
    const table = '<table class="details"><tr><th>Plan</th><td style="background:#FFF3C4">$29.00</td></tr><tr style="background-color:#FFF3C4"><th>Total</th><td>$31.90</td></tr></table>';
    for (const scheme of ['auto', 'dark'] as const) {
      const html = styleContent(table, { ...en, scheme });
      // The highlighted value: RESPOK's light ink and line, no dark class (which would turn it near-white on yellow).
      expect(html).toMatch(/<td style="padding:13px 0;padding-left:14px;border-bottom:1px solid #E4E3EC;[^"]*color:#16142B;[^"]*;background:#FFF3C4" class="x-pin" align="right"/);
      // The highlighted row: both its cells.
      expect(html).toMatch(/<tr style="background-color:#FFF3C4"><th class="x-pin"[^>]*color:#5E5C75;[^>]*>Total<\/th><td class="x-pin"[^>]*color:#16142B;[^>]*>\$31\.90<\/td><\/tr>/);
      // The plain label beside the highlighted value is the scheme's own.
      expect(html).toMatch(/<th class="x-muted x-line"[^>]*>Plan<\/th>/);
    }
  });

  it('a transcript\'s meta line or bubble with its own background keeps light-scheme text', () => {
    const html = styleContent('<div class="transcript"><div class="msg msg-agent"><div class="meta" style="background:#FFF3C4">Maria</div><div class="bubble" style="background:#FFF3C4">Hi</div></div></div>', { ...en, scheme: 'dark' });
    expect(html).toMatch(/<td style="padding:0 4px 5px;[^"]*color:#5E5C75;[^"]*;background:#FFF3C4" class="x-pin" align="left">Maria<\/td>/);
    expect(html).toMatch(/<td style="background-color:#F2F1F7;[^"]*color:#16142B;[^"]*;background:#FFF3C4" class="x-pin" bgcolor="#F2F1F7">Hi<\/td>/);
  });

  it('a colour without a background still gets the dark class, which wins on a dark card', () => {
    expect(styleContent('<p class="note" style="color:#7a00aa">n</p>', en)).toMatch(/<p class="note x-muted" style="[^"]*;color:#7a00aa">/);
    expect(styleContent('<p><span style="color:#7a00aa">c</span></p>', en)).toContain('<span style="color:#7a00aa" class="x-ink">');
  });

  it('only the dark rules a mail uses are written, for Apple Mail and Outlook.com alike', () => {
    const html = doc('<p>Plain</p>');
    expect(html).toContain('.x-ink{color:#F1F0F7!important}');
    expect(html).toContain('[data-ogsc] .x-ink{color:#F1F0F7!important}');
    expect(html).toContain('[data-ogsb] .x-band{background-color:#1B1932!important;background-image:linear-gradient(#1B1932,#1B1932)!important}');
    const dark = /@media \(prefers-color-scheme:dark\)\{(.*)\}\n/.exec(html)?.[1] ?? '';
    expect(dark).toContain('.x-card{');
    expect(dark).not.toContain('.x-br{');
    expect(dark).not.toContain('.x-code{');
  });

  it('a forced scheme (a preview) carries that palette inline and no dark rules', () => {
    const dark = doc('<p>x</p>', { scheme: 'dark' });
    expect(dark).toContain('<meta name="color-scheme" content="dark">');
    expect(dark).toContain('bgcolor="#0B0A15"');
    expect(dark).not.toContain('prefers-color-scheme');
    expect(doc('<p>x</p>')).toContain('<meta name="color-scheme" content="light dark">');
  });
});

describe('direction and fonts follow the language, not the brand', () => {
  it('a RESPOK mail in Persian is right to left in IRANSans', () => {
    const html = renderEmailDocument({ brand: RESPOK, locale: 'fa', title: 't', contentHtml: '<p>سلام</p>', category: 'transactional' });
    expect(html).toContain('<html lang="fa" dir="rtl"');
    expect(html).toContain('src:url(https://app.respok.app/widget/fonts/iransans-400.woff2)');
    expect(html).not.toContain('figtree');
    expect(html).toMatch(/<p class="x-ink" style="[^"]*font-family:IRANSans,Tahoma,/);
  });

  it('a WebYar mail in English is left to right in Figtree with its Turkish letters', () => {
    const html = renderEmailDocument({ brand: WEBYAR, locale: 'en', title: 't', contentHtml: '<p>Hi</p>', category: 'transactional' });
    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).toContain('figtree-latin.woff2');
    expect(html).toContain('figtree-tr.woff2');
  });

  it('Outlook gets a font it has, the web fonts are for screens only, and the styles are three blocks', () => {
    const faHtml = renderEmailDocument({ brand: WEBYAR, locale: 'fa', title: 't', contentHtml: '<p>x</p>', category: 'transactional' });
    expect(faHtml).toContain('<!--[if mso]><style>body,table,td,th,p,a,h1,span,strong,b,em,div,blockquote,li{font-family:Tahoma,Arial,sans-serif!important;}</style><![endif]-->');
    expect(doc('<p>x</p>')).toContain("{font-family:'Segoe UI',Arial,sans-serif!important;}");
    expect(faHtml).toMatch(/<style>@media screen\{@font-face\{/);
    expect(faHtml.match(/<style>/g)).toHaveLength(4); // the Outlook block, resets, fonts, dark
  });
});

describe('the logo', () => {
  it('the band shows the logo for dark backgrounds, sized by its shape, linked to the site', () => {
    const html = doc('<p>x</p>');
    expect(html).toContain('<a href="https://respok.app" style="display:inline-block;text-decoration:none;"><img class="x-logo" src="https://app.respok.app/brand/intl/email/respok-logo-dark.png" width="159" height="37" alt="RESPOK"');
    expect(renderEmailDocument({ brand: WEBYAR, locale: 'fa', title: 't', contentHtml: '', category: 'transactional' })).toContain('width="123" height="47"');
  });

  it('without a dark variant, the light logo sits on a paper plate; never ink on the band', () => {
    const html = doc('<p>x</p>', { brand: { ...RESPOK, logo: { ...RESPOK.logo!, dark: RESPOK.logo!.light } } });
    expect(html).toMatch(/<td class="x-plate" bgcolor="#FFFFFF" style="background-color:#FFFFFF;background-image:linear-gradient\(#FFFFFF,#FFFFFF\);/);
    expect(html).toContain('src="https://app.respok.app/brand/intl/email/respok-logo.png"');
  });

  it('without a logo the name stands in, in white on the band', () => {
    const html = doc('<p>x</p>', { brand: { ...RESPOK, logo: null } });
    expect(html).not.toContain('<img');
    expect(html).toMatch(/color:#FFFFFF;">RESPOK<\/span>/);
  });

  it('one image at most, and nothing hidden but the preheader', () => {
    const html = doc(RECEIPT);
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html.match(/display:none/g)).toHaveLength(1);
    expect(html).not.toContain('@media print');
  });
});

describe('the preheader', () => {
  it('only a div whose class list holds exactly "preheader" (or data-preheader)', () => {
    expect(extractPreheader('<div class="preheader-x">a</div><p>b</p>').preheader).toBe('');
    expect(extractPreheader('<div class="no-preheader">a</div>').preheader).toBe('');
    expect(extractPreheader('<div class="x preheader">Hello <b>you</b></div><p>b</p>')).toEqual({ preheader: 'Hello you', rest: '<p>b</p>' });
    expect(extractPreheader('<div data-preheader>Hi</div>').preheader).toBe('Hi');
  });

  it('goes first in the body, hidden, transparent, with a short filler; nowhere else', () => {
    const html = doc(RECEIPT);
    const body = html.slice(html.indexOf('<body'));
    expect(body).toMatch(/^<body[^>]*>\n<div data-preheader style="display:none;[^"]*mso-hide:all;color:transparent;">We received your payment of \$31\.90\.(&#847;&zwnj;&nbsp;){24}<\/div>/);
    expect(html.match(/We received your payment of/g)).toHaveLength(1);
  });
});

describe('the footer', () => {
  it('why the mail came, by kind, in the mail\'s language', () => {
    expect(whyLine('transactional', 'en', 'RESPOK')).toBe('This is a service email from RESPOK.');
    expect(whyLine('notification', 'fa', 'وب‌یار')).toContain('اعلان‌های وب‌یار');
    expect(whyLine('marketing', 'tr', 'RESPOK')).toBe('RESPOK hesabınız olduğu için bu e-postayı alıyorsunuz.');
    expect(doc('<p>x</p>')).toContain('>This is a service email from RESPOK.</td>');
  });

  it('a caller\'s closing line takes its place inside the footer: its words and link kept, its own look dropped', () => {
    const footer = { html: '<p dir="ltr" style="margin-top:24px;border-top:1px solid #e5e7eb;color:#6b7280">You get this because X is on. <a href="https://app.respok.app/u/abc" style="color:#6b7280">Unsubscribe</a></p>', text: 'x' };
    const html = doc('<p>x</p>', { footer, category: 'notification' });
    expect(html).not.toContain('This is a service email');
    expect(html).not.toContain('border-top:1px solid #e5e7eb');
    expect(html).toContain('You get this because X is on. <a href="https://app.respok.app/u/abc" class="x-foot" style="color:#5E5C75;text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a>');
    // In the designed footer, before the brand line, not loose before </body>.
    expect(html.indexOf('Unsubscribe')).toBeLessThan(html.indexOf('>RESPOK</strong>'));
  });

  it('the brand line wraps on a narrow screen: plain spaces around the dots', () => {
    const html = doc('<p>x</p>');
    expect(html).toContain('>RESPOK</strong> <span class="x-foot" style="color:#5E5C75;">·</span> <a href="https://app.respok.app"');
    expect(renderEmailDocument({ brand: WEBYAR, locale: 'fa', title: 't', contentHtml: '', category: 'transactional' })).toContain('&rlm;·&rlm;');
  });
});

describe('the year and the legal line', () => {
  const now = new Date('2026-10-30T10:00:00Z');
  it('the Persian year in Persian digits for WebYar, the Gregorian one for the International edition', () => {
    expect(localYear('fa', 'iran', now)).toBe('۱۴۰۵');
    expect(localYear('fa', 'international', now)).toBe('۲۰۲۶');
    expect(localYear('en', 'iran', now)).toBe('2026');
  });

  it('the Super Admin\'s footer text, else © the year and the company, else © the year and the brand', () => {
    expect(legalLine({ footerText: '© RESPOK Inc.', company: 'X', brand: 'RESPOK', locale: 'en', edition: 'international', now })).toBe('© RESPOK Inc.');
    expect(legalLine({ company: 'RESPOK Ltd', brand: 'RESPOK', locale: 'en', edition: 'international', now })).toBe('© 2026 RESPOK Ltd');
    expect(legalLine({ brand: 'وب‌یار', locale: 'fa', edition: 'iran', now })).toBe('© ۱۴۰۵ وب‌یار');
  });
});

describe('the text part', () => {
  it('is the content as text: no preheader, images by alt, links with their targets, details as "Label: value"', () => {
    const text = contentToText(`${RECEIPT}<p><img src="https://x.example/a.png" alt="Chart"> and <a href="mailto:a@b.example">write</a></p>`);
    expect(text).not.toContain('We received your payment of');
    expect(text).toContain('Payment receipt');
    expect(text).toContain('Receipt: R-7001\nAmount: $31.90');
    expect(text).toContain('View receipt (https://app.respok.app/acme/billing)');
    expect(text).toContain('Chart and write (a@b.example)');
    const chat = contentToText('<div class="transcript"><div class="msg msg-visitor"><div class="meta">You · 10:24</div><div class="bubble">Hi</div></div><div class="msg msg-agent"><div class="meta">Maria</div><div class="bubble">Hello</div></div></div>');
    expect(chat).toBe('You · 10:24\nHi\n\nMaria\nHello');
  });

  it('then the footer\'s lines', () => {
    const text = renderEmailText({ brand: RESPOK, locale: 'en', contentHtml: '<p>Hi</p>', category: 'transactional' });
    expect(text).toBe('Hi\n\nThis is a service email from RESPOK.\nRESPOK · app.respok.app · support@respok.app\n© 2026 RESPOK');
    const withFooter = renderEmailText({ brand: RESPOK, locale: 'en', contentHtml: '<p>Hi</p>', category: 'notification', footer: { html: '', text: 'Why.\nUnsubscribe: https://u' } });
    expect(withFooter).toContain('Hi\n\nWhy.\nUnsubscribe: https://u\nRESPOK');
  });
});

describe('whole documents', () => {
  it('are told apart from content, and a caller\'s document gives its body', () => {
    expect(isWholeDocument('<!doctype html><html lang="fa"><body><p>x</p></body></html>')).toBe(true);
    expect(isWholeDocument('<p>about <htmlish></p>')).toBe(false);
    expect(documentBody('<!doctype html><html><head><title>t</title></head><body style="font-family:sans-serif"><p>a</p><p>b</p></body></html>')).toBe('<p>a</p><p>b</p>');
    expect(documentBody('<html><head><style>p{}</style></head><p>a</p></html>')).toBe('<p>a</p>');
  });
});

describe('the palettes', () => {
  const lum = (hex: string) => {
    const [r, g, b] = (hex.replace('#', '').match(/../g) as string[]).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const PAIRS: Array<[string, string]> = [
    ['ink', 'card'], ['muted', 'card'], ['link', 'card'], ['muted', 'panel'], ['ink', 'panel'], ['footInk', 'canvas'], ['ink', 'canvas'],
    ['onAccent', 'accent'], ['codeInk', 'codeBg'], ['warningInk', 'warningBg'], ['noticeInk', 'noticeBg'], ['quoteInk', 'quoteBg'],
    ['bubbleReaderInk', 'bubbleReader'], ['bubbleOtherInk', 'bubbleOther'], ['onBand', 'band'],
  ];

  it.each(Object.keys(EMAIL_PALETTES))('%s: every text pair is at least 4.5:1, in both schemes', (edition) => {
    const schemes = EMAIL_PALETTES[edition as 'iran' | 'international'];
    for (const [scheme, p] of Object.entries(schemes)) {
      for (const [fg, bg] of PAIRS) {
        const value = ratio((p as unknown as Record<string, string>)[fg], (p as unknown as Record<string, string>)[bg]);
        expect(value, `${edition}/${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('RESPOK\'s dark scheme stays on its kit: the reader\'s bubble in signal with ink text', () => {
    expect(EMAIL_PALETTES.international.dark.bubbleReader).toBe('#FF5A3C');
    expect(EMAIL_PALETTES.international.dark.bubbleReaderInk).toBe('#16142B');
  });
});

describe('size', () => {
  it('a receipt is a small mail (Gmail clips at about 102 KB)', () => {
    expect(Buffer.byteLength(renderEmailDocument({ brand: WEBYAR, locale: 'fa', title: 't', contentHtml: RECEIPT, category: 'transactional' }))).toBeLessThan(20_000);
  });

  it('a transcript message costs well under half a kilobyte of markup', () => {
    const msg = '<div class="msg msg-agent"><div class="meta">M · 10:00</div><div class="bubble">Hello there</div></div>';
    const one = styleContent(`<div class="transcript">${msg}</div>`, en).length;
    const eleven = styleContent(`<div class="transcript">${msg.repeat(11)}</div>`, en).length;
    expect((eleven - one) / 10).toBeLessThan(800);
  });
});
