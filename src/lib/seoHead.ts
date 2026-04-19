/**
 * Head/meta updater for SPA-navigated KB pages.
 *
 * Server-rendered KB pages already include canonical/hreflang/JSON-LD on
 * first paint (see server/routes/kb.ts). When the user navigates between
 * KB pages without a full reload, this helper rewrites those tags so SEO
 * parity is maintained for crawlers that re-evaluate after hydration and
 * for sharing/social previews.
 *
 * The helper is idempotent and tags every element it manages with
 * data-managed="seo" so we can safely remove stale entries on each call.
 */

type Hreflang = { hreflang: string; href: string };

export interface SeoHeadOptions {
  title: string;
  description?: string;
  canonical?: string;
  locale?: string;
  dir?: 'ltr' | 'rtl';
  hreflangs?: Hreflang[];
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
  robots?: string; // e.g. 'index,follow' | 'noindex,nofollow'
}

function clearManaged() {
  const existing = document.head.querySelectorAll('[data-managed="seo"]');
  existing.forEach((el) => el.parentNode?.removeChild(el));
}

function add(tagName: string, attrs: Record<string, string>, text?: string) {
  const el = document.createElement(tagName);
  el.setAttribute('data-managed', 'seo');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  document.head.appendChild(el);
}

function setMeta(name: string, content: string, useProperty = false) {
  add('meta', useProperty ? { property: name, content } : { name, content });
}

export function applySeoHead(opts: SeoHeadOptions): void {
  if (typeof document === 'undefined') return;

  // Title
  if (opts.title) document.title = opts.title;

  // <html lang/dir>
  if (opts.locale) document.documentElement.setAttribute('lang', opts.locale);
  if (opts.dir) document.documentElement.setAttribute('dir', opts.dir);

  clearManaged();

  if (opts.description) {
    setMeta('description', opts.description);
    setMeta('og:description', opts.description, true);
    setMeta('twitter:description', opts.description);
  }

  if (opts.title) {
    setMeta('og:title', opts.title, true);
    setMeta('twitter:title', opts.title);
    setMeta('twitter:card', 'summary');
  }

  if (opts.canonical) {
    add('link', { rel: 'canonical', href: opts.canonical });
    setMeta('og:url', opts.canonical, true);
  }

  setMeta('robots', opts.robots || 'index,follow');

  if (opts.hreflangs && opts.hreflangs.length) {
    for (const h of opts.hreflangs) {
      add('link', { rel: 'alternate', hreflang: h.hreflang, href: h.href });
    }
  }

  if (opts.jsonLd) {
    const payload = Array.isArray(opts.jsonLd) ? opts.jsonLd : [opts.jsonLd];
    add('script', { type: 'application/ld+json' }, JSON.stringify(payload).replace(/</g, '\\u003c'));
  }
}

export function clearSeoHead(): void {
  clearManaged();
}