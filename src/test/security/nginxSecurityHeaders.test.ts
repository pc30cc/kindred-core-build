/**
 * The panel's security headers (nginx.conf.template, the frontend image of
 * both brands: app.webyar.ai and app.respok.app).
 *
 * nginx drops the server-level `add_header`s in a location that sets one of
 * its own, and a nested location that sets one drops its parent's. So a
 * header written once at the server level silently misses the document, the
 * build files and every widget file. The template is read as nginx reads it
 * and each location's headers are resolved by that rule.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATE = readFileSync(resolve(process.cwd(), 'nginx.conf.template'), 'utf8');

const HSTS = 'Strict-Transport-Security';
const HSTS_VALUE = '"max-age=31536000; includeSubDomains" always';
const OTHER_SECURITY_HEADERS = ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy'];

interface Block {
  head: string;
  directives: string[];
  children: Block[];
  parent: Block | null;
}

/** Blocks and their own directives; comments dropped, quoted strings kept whole (a regex match may hold braces). */
function parse(source: string): Block {
  const root: Block = { head: '', directives: [], children: [], parent: null };
  let current = root;
  let text = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      text += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      text += c;
    } else if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '{') {
      const block: Block = { head: text.trim().replace(/\s+/g, ' '), directives: [], children: [], parent: current };
      current.children.push(block);
      current = block;
      text = '';
    } else if (c === '}') {
      expect(current.parent, 'unbalanced "}" in nginx.conf.template').not.toBeNull();
      current = current.parent as Block;
      text = '';
    } else if (c === ';') {
      current.directives.push(text.trim().replace(/\s+/g, ' '));
      text = '';
    } else {
      text += c;
    }
  }
  expect(current, 'unterminated block in nginx.conf.template').toBe(root);
  return root;
}

const SERVER = (() => {
  const servers = parse(TEMPLATE).children.filter((block) => block.head === 'server');
  expect(servers).toHaveLength(1);
  return servers[0];
})();

function locations(block: Block): Block[] {
  return block.children
    .filter((child) => child.head.startsWith('location '))
    .flatMap((child) => [child, ...locations(child)]);
}
const LOCATIONS = locations(SERVER);

/** The block's own `add_header`s, as [name, rest]. */
function ownHeaders(block: Block): Array<[string, string]> {
  return block.directives
    .map((directive) => directive.match(/^add_header (\S+) (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2]]);
}

/** What a response from this block carries: its own `add_header`s, else the nearest enclosing block's. */
function effectiveHeaders(block: Block): Array<[string, string]> {
  for (let b: Block | null = block; b; b = b.parent) {
    const own = ownHeaders(b);
    if (own.length > 0) return own;
  }
  return [];
}

const values = (headers: Array<[string, string]>, name: string) =>
  headers.filter(([header]) => header === name).map(([, value]) => value);

describe('nginx: HSTS on the panel host', () => {
  it('reads every location of the template', () => {
    const heads = LOCATIONS.map((block) => block.head);
    for (const head of [
      'location /api/',
      'location = /runtime-config.js',
      'location = /sw.js',
      'location = /widget/loader.js',
      'location ^~ /widget/',
      'location ~* "^/widget/.*\\.[a-f0-9]{8}\\.(?:js|css|woff2)$"',
      'location @missing_widget_asset',
      'location ^~ /downloads/',
      'location ^~ /assets/',
      'location @missing_asset',
      'location = /index.html',
      'location ^~ /call-widget/',
      'location ~* "^/call-widget/vendor/"',
      'location /',
    ]) {
      expect(heads).toContain(head);
    }
  });

  it('sends it at the server level, with the other security headers', () => {
    const own = ownHeaders(SERVER);
    expect(values(own, HSTS)).toEqual([HSTS_VALUE]);
    for (const name of OTHER_SECURITY_HEADERS) expect(values(own, name), name).toHaveLength(1);
  });

  it('repeats it in every location that sets the other security headers', () => {
    const carriers = LOCATIONS.filter((block) => ownHeaders(block).some(([name]) => OTHER_SECURITY_HEADERS.includes(name)));
    // The SPA document and the two "missing file" 404s.
    expect(carriers.map((block) => block.head)).toEqual(
      expect.arrayContaining(['location = /index.html', 'location @missing_asset', 'location @missing_widget_asset']),
    );
    for (const block of carriers) expect(values(ownHeaders(block), HSTS), block.head).toEqual([HSTS_VALUE]);
  });

  it('reaches every response, once: the document, build files, downloads and both widgets', () => {
    for (const block of LOCATIONS) expect(values(effectiveHeaders(block), HSTS), block.head).toEqual([HSTS_VALUE]);
  });

  it('is never preloaded', () => {
    // Preload lists are hard to leave; `includeSubDomains` and a year are the policy.
    const directives = [SERVER, ...LOCATIONS].flatMap((block) => block.directives);
    expect(directives.filter((directive) => /preload/i.test(directive))).toEqual([]);
  });

  it('hides the backend\'s own header on the same-origin /api/ proxy, so a response carries one', () => {
    const api = LOCATIONS.find((block) => block.head === 'location /api/');
    expect(api?.directives).toContain(`proxy_hide_header ${HSTS}`);
    expect(ownHeaders(api as Block)).toEqual([]);
  });
});
